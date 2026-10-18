/**
 * wave-journal — 理性と感性の波を一日一回記録する（Cloudflare Worker）
 *
 *   /api/*  : JSON API（記録は D1）
 *   それ以外 : public/ の静的ファイル（ASSETS）
 *
 * 入口には合言葉がある（日々の心の状態の記録なので、URLを知っているだけでは見せない）。
 *   合言葉は Worker の秘密の値 APP_KEY。未設定なら全部閉じる（fail closed）。
 *   一度入れた端末には 400 日有効の Cookie を置くので、毎回は聞かない。
 *
 * データの守り方（.claude/skills/cloudflare-app-builder/references/data-safety.md）:
 *   - 1日に生きている記録は1件。同じ日にもう一度記録すると、その記録を書き換える（旧版と同じ）
 *   - 削除は論理削除（deleted_at）。ゴミ箱から戻せる
 *   - 書き出し / 読み込み。読み込みは追記だけ（同じ id は INSERT OR IGNORE で書かない）
 *     旧版（GitHub Pages 版）の書き出し JSON（[{date, value, note}, ...]）もそのまま読める
 */

// ------------------------------------------------------------------ 小道具

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}
const err = (status, message, extra = {}) => json({ error: message, ...extra }, { status });
const nowIso = () => new Date().toISOString();
const str = (v, max = 1000) => (v === undefined || v === null ? '' : String(v).slice(0, max));

const BACKUP_FORMAT = 'wave-journal-backup';
const VALUES = [-3, -2, -1, 1, 2, 3];
const ID_RE = /^[A-Za-z0-9-]{6,80}$/;
const SESSION_COOKIE = 'wj_session';
const SESSION_MAX_AGE = 400 * 24 * 3600;       // ブラウザが許す最長（400日）

/** YYYY-MM-DD として正しい日付か（正規表現を使わず、長さと Date.parse で見る） */
function isDate(s) {
  if (typeof s !== 'string' || s.length !== 10 || s[4] !== '-' || s[7] !== '-') return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
function toValue(v) {
  const n = Number(v);
  return VALUES.includes(n) ? n : null;
}

/** 旧版の記録に付ける決まった id（同じファイルを何度読み込んでも同じ id になる） */
function legacyId(date, value, note) {
  let h = 0x811c9dc5;                         // FNV-1a 32bit
  const s = `${value}|${note}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `legacy-${date}-${h.toString(16).padStart(8, '0')}`;
}

// ------------------------------------------------------------------ 合言葉（セッション）

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/** 合言葉を変えると、全端末の Cookie が自動的に無効になる */
// 合言葉は全角・半角の違い（英数字・記号）と前後の空白を無視して照合する（NFKC）。日本語の合言葉もそのまま使える。
const normKey = (s) => String(s ?? '').normalize('NFKC').trim();
const sessionToken = (env) => hmac(env.APP_KEY, 'wave-journal-session-v1');

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
async function isAuthed(request, env) {
  if (!env.APP_KEY) return false;
  const got = readCookie(request, SESSION_COOKIE);
  return !!got && safeEqual(got, await sessionToken(env));
}
function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function login(env, body) {
  if (!env.APP_KEY) return err(503, '合言葉がまだ設定されていません', { code: 'no_key' });
  const given = str(body && body.key, 200);
  // 比べるのは HMAC 同士（長さの違いから推測されないように）
  const ok = safeEqual(await hmac(env.APP_KEY, 'k:' + normKey(given)), await hmac(env.APP_KEY, 'k:' + normKey(env.APP_KEY)));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 700));   // 総当たりを遅くする
    return err(401, '合言葉が違います');
  }
  return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(await sessionToken(env), SESSION_MAX_AGE) } });
}

// ------------------------------------------------------------------ 記録

const COLS = 'id, date, value, note, created_at, updated_at, deleted_at';

async function listEntries(env) {
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM entries WHERE deleted_at IS NULL ORDER BY date`).all();
  return json({ entries: results });
}

async function listTrash(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM entries WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500`
  ).all();
  return json({ entries: results });
}

/** その日の記録を書く。もう記録があれば書き換える（旧版の「上書きできる」と同じ） */
async function saveDay(env, date, body) {
  if (!isDate(date)) return err(400, '日付が正しくありません');
  const value = toValue(body && body.value);
  if (value === null) return err(400, '状態を選んでください');
  const note = str(body.note);
  const now = nowIso();
  const update = () => env.DB.prepare(
    'UPDATE entries SET value=?, note=?, updated_at=? WHERE date=? AND deleted_at IS NULL'
  ).bind(value, note, now, date).run();

  let r = await update();
  let created = false;
  if (!(r.meta && r.meta.changes)) {
    try {
      await env.DB.prepare(`INSERT INTO entries (${COLS}) VALUES (?,?,?,?,?,?,NULL)`)
        .bind(crypto.randomUUID(), date, value, note, now, now).run();
      created = true;
    } catch (e) {
      // 同時に2回押されたなどで、先に別の行が入っていた → そちらを書き換える
      r = await update();
      if (!(r.meta && r.meta.changes)) throw e;
    }
  }
  const row = await env.DB.prepare(`SELECT ${COLS} FROM entries WHERE date=? AND deleted_at IS NULL`).bind(date).first();
  return json({ ok: true, created, entry: row });
}

/** 論理削除。行は残るのでゴミ箱から戻せる */
async function deleteEntry(env, id) {
  const now = nowIso();
  const r = await env.DB.prepare('UPDATE entries SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
    .bind(now, now, id).run();
  if (!(r.meta && r.meta.changes)) return err(404, '見つかりません');
  return json({ ok: true });
}

async function restoreEntry(env, id) {
  const row = await env.DB.prepare('SELECT date FROM entries WHERE id=? AND deleted_at IS NOT NULL').bind(id).first();
  if (!row) return err(404, '見つかりません');
  const live = await env.DB.prepare('SELECT id FROM entries WHERE date=? AND deleted_at IS NULL').bind(row.date).first();
  if (live) return err(409, 'その日にはもう別の記録があります。先にそちらを消すと戻せます。');
  await env.DB.prepare('UPDATE entries SET deleted_at=NULL, updated_at=? WHERE id=?').bind(nowIso(), id).run();
  return json({ ok: true });
}

// ------------------------------------------------------------------ バックアップ

async function handleExport(env) {
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM entries ORDER BY date, created_at`).all();
  return json({ format: BACKUP_FORMAT, version: 1, exported_at: nowIso(), entries: results });
}

/**
 * 読み込み。2つの形式を受け付ける。
 *   - このアプリの書き出し: { format: 'wave-journal-backup', entries: [...] }
 *   - 旧版の書き出し:       [{ date, value, note }, ...]（wave-journal-backup-YYYY-MM-DD.json）
 *
 * 追記だけ:
 *   - 同じ id がもうあれば何もしない（INSERT OR IGNORE）。今の記録を書き換えない
 *   - 同じ日に生きている記録があり、中身が同じなら何もしない（何度読み込んでも増えない）
 *   - 同じ日に中身の違う記録があるときは、旧版の統合と同じく「読み込んだ方」を表に出す。
 *     ただし元の記録は消さずにゴミ箱へ移す（いつでも戻せる）
 */
async function handleImport(env, body) {
  let incoming;
  const now = nowIso();
  if (Array.isArray(body)) {
    // 旧版。同じ日が複数あれば後ろのものを採る（旧版の Map と同じ）
    const byDate = new Map();
    for (const x of body) {
      if (!x || !isDate(x.date)) continue;
      const value = toValue(x.value);
      if (value === null) continue;
      const note = str(x.note);
      byDate.set(x.date, { id: legacyId(x.date, value, note), date: x.date, value, note, created_at: now, updated_at: now, deleted_at: null });
    }
    incoming = [...byDate.values()];
  } else if (body && body.format === BACKUP_FORMAT) {
    const live = new Map();
    const dead = [];
    for (const x of Array.isArray(body.entries) ? body.entries : []) {
      if (!x || typeof x.id !== 'string' || !ID_RE.test(x.id) || !isDate(x.date)) continue;
      const value = toValue(x.value);
      if (value === null) continue;
      const created = typeof x.created_at === 'string' ? x.created_at : now;
      const row = {
        id: x.id, date: x.date, value, note: str(x.note), created_at: created,
        updated_at: typeof x.updated_at === 'string' ? x.updated_at : created,
        deleted_at: typeof x.deleted_at === 'string' && x.deleted_at ? x.deleted_at : null,
      };
      if (row.deleted_at) dead.push(row); else live.set(row.date, row);
    }
    incoming = [...dead, ...live.values()];
  } else {
    return err(400, 'このファイルは Wave Journal のバックアップではありません');
  }

  const ids = new Set((await env.DB.prepare('SELECT id FROM entries').all()).results.map((r) => r.id));
  const liveByDate = new Map(
    (await env.DB.prepare('SELECT id, date, value, note FROM entries WHERE deleted_at IS NULL').all()).results.map((r) => [r.date, r])
  );

  const insert = (x) => env.DB.prepare(`INSERT OR IGNORE INTO entries (${COLS}) VALUES (?,?,?,?,?,?,?)`)
    .bind(x.id, x.date, x.value, x.note, x.created_at, x.updated_at, x.deleted_at);

  // ops: 1つの op の文は同じ batch（＝同じトランザクション）に入れる
  const ops = [];
  let added = 0, replaced = 0, skipped = 0;
  for (const x of incoming) {
    if (ids.has(x.id)) { skipped++; continue; }
    ids.add(x.id);
    if (x.deleted_at) { ops.push([insert(x)]); added++; continue; }
    const cur = liveByDate.get(x.date);
    if (!cur) {
      ops.push([insert(x)]);
    } else if (Number(cur.value) === x.value && (cur.note || '') === x.note) {
      skipped++;
      continue;
    } else {
      // 旧版と同じく読み込んだ方を表に。元の記録はゴミ箱へ（消さない）
      ops.push([
        env.DB.prepare('UPDATE entries SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL').bind(now, now, cur.id),
        insert(x),
      ]);
      replaced++;
    }
    liveByDate.set(x.date, x);
    added++;
  }

  // 数百件でも詰まらないよう小分けに
  let batch = [];
  for (const op of ops) {
    if (batch.length + op.length > 25) { await env.DB.batch(batch); batch = []; }
    batch.push(...op);
  }
  if (batch.length) await env.DB.batch(batch);

  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE deleted_at IS NULL').first()).n;
  return json({ ok: true, read: incoming.length, added, replaced, skipped, total });
}

// ------------------------------------------------------------------ router

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ---- 合言葉なしで呼べるもの
  if (path === '/api/env' && method === 'GET') return json({ env: env.APP_ENV || 'prod' });

  // 検証用（dev）だけ、確かめている間に限って合言葉なしで開ける（デプロイ時に --var DEV_OPEN:1 を付けたときだけ）。
  // 本番（APP_ENV が dev 以外）では DEV_OPEN があっても絶対に開かない。中身はテストデータだけ。
  const devOpen = env.APP_ENV === 'dev' && env.DEV_OPEN === '1';

  if (path === '/api/session' && method === 'GET') {
    const authed = devOpen || await isAuthed(request, env);
    // 開くたびに期限を 400 日先へ延ばす。使い続けている限り、合言葉を聞き直されない
    const headers = authed && !devOpen ? { 'set-cookie': sessionCookie(await sessionToken(env), SESSION_MAX_AGE) } : {};
    return json({ configured: devOpen || !!env.APP_KEY, authed }, { headers });
  }
  const readJson = async () => { try { return await request.json(); } catch { return {}; } };
  if (path === '/api/login' && method === 'POST') return login(env, await readJson());
  if (path === '/api/logout' && method === 'POST') return json({ ok: true }, { headers: { 'set-cookie': sessionCookie('', 0) } });

  // ---- ここから先は合言葉が必要
  if (!devOpen) {
    if (!env.APP_KEY) return err(503, '合言葉がまだ設定されていません', { code: 'no_key' });
    if (!(await isAuthed(request, env))) return err(401, '合言葉を入れてください', { code: 'auth' });
  }

  const body = method === 'POST' || method === 'PUT' ? await readJson() : null;

  if (path === '/api/entries' && method === 'GET') {
    // 画面は起動時に session を呼ばずこれを最初に読むので、ここで Cookie の期限を 400 日先へ延ばす
    const res = await listEntries(env);
    if (!devOpen) res.headers.append('set-cookie', sessionCookie(await sessionToken(env), SESSION_MAX_AGE));
    return res;
  }
  if (path === '/api/trash' && method === 'GET') return listTrash(env);

  let m = path.match(/^\/api\/days\/([0-9-]{10})$/);
  if (m && method === 'PUT') return saveDay(env, m[1], body);

  m = path.match(/^\/api\/entries\/([A-Za-z0-9-]+)$/);
  if (m && method === 'DELETE') return deleteEntry(env, m[1]);
  m = path.match(/^\/api\/entries\/([A-Za-z0-9-]+)\/restore$/);
  if (m && method === 'POST') return restoreEntry(env, m[1]);

  if (path === '/api/export' && method === 'GET') return handleExport(env);
  if (path === '/api/import' && method === 'POST') return handleImport(env, body);

  return err(404, 'no such endpoint');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        console.error('API error', url.pathname, e && e.stack || e);
        return err(500, 'サーバーでエラーが起きました');
      }
    }
    return env.ASSETS.fetch(request);
  },
};
