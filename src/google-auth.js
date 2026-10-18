/**
 * google-auth.js — 「Googleでログイン」の部品（依存ゼロ。6つのアプリで同じファイルを使い回す）
 *
 *   GET /auth/google           → Google のアカウント選択画面へ送る
 *   GET /auth/google/callback  → 戻ってきたら持ち主のメールか確かめ、合言葉と同じセッション Cookie を出す
 *
 * 設定（どれも Worker の秘密の値。`wrangler secret put` で入れる）:
 *   GOOGLE_CLIENT_ID      Google Cloud の OAuth クライアント ID
 *   GOOGLE_CLIENT_SECRET  同じクライアントのシークレット
 *   OWNER_EMAIL           入ってよい Google アカウントのメール（カンマ区切りで複数可。大文字小文字は無視）
 *   どれか1つでも無い（または合言葉 APP_KEY が無い）あいだは Google ログインは出さず、今までの合言葉の画面のまま。
 *
 * 発行する Cookie は、合言葉で入ったときと全く同じもの（元は APP_KEY）。
 * なので Google で入っても合言葉で入っても同じ扱いで、合言葉を変えれば全端末のログインが切れるのも今までどおり。
 *
 * id_token の署名を検証しない理由:
 *   id_token は、ブラウザ経由ではなく Worker が oauth2.googleapis.com へ client_secret 付きで直接（TLS で）
 *   取りに行った応答の中にある。途中で誰かが差し替える余地がないので、OpenID Connect の仕様
 *   （Core 3.1.3.7 の 6）でも「トークンエンドポイントから直接受け取った場合は TLS の検証で代えてよい」とされている。
 *   それでも aud（自分のクライアント ID か）・iss・exp・email_verified は確かめる。
 */

const STATE_COOKIE = '__Host-g_state';
const STATE_MAX_AGE = 600;   // 10分
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Google ログインを出してよいか（設定が全部そろっているか） */
export function googleEnabled(env) {
  return !!(env && env.APP_KEY && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && ownerEmails(env).length);
}

function ownerEmails(env) {
  return String((env && env.OWNER_EMAIL) || '')
    .split(',')
    .map((s) => s.normalize('NFKC').trim().toLowerCase())
    .filter(Boolean);
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function randomState() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const stateCookie = (value, maxAge) =>
  `${STATE_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

/** JWT の真ん中（ペイロード）を読む。署名検証はしない（理由は冒頭） */
function decodeJwtPayload(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 断られたとき・失敗したときの日本語の画面（アプリの外観に寄せず、どのアプリでも読める落ち着いた画面） */
function page(status, title, message, links, appName) {
  const linkHtml = links
    .map(([href, label, main]) => `<a href="${esc(href)}" class="${main ? 'main' : 'sub'}">${esc(label)}</a>`)
    .join('');
  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)}${appName ? ' — ' + esc(appName) : ''}</title>
<style>
  :root { --bg:#f6f5f2; --card:#fff; --text:#2b2b2b; --muted:#6b6b6b; --line:#e2e0da; --accent:#3d4a5c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --card:#1d2026; --text:#e8e8e8; --muted:#9a9ea6; --line:#2d313a; --accent:#c9d3e0; } }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text);
         font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; padding:16px; box-sizing:border-box; }
  .card { width:100%; max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px 24px; text-align:center; }
  h1 { font-size:18px; font-weight:600; margin:0 0 12px; }
  p { font-size:14px; line-height:1.8; color:var(--muted); margin:0 0 22px; word-break:break-all; }
  a { display:block; text-decoration:none; border-radius:10px; padding:12px; font-size:14px; margin-top:10px; }
  a.main { background:var(--accent); color:var(--card); font-weight:600; }
  a.sub { color:var(--muted); font-size:13px; }
</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${message}</p>${linkHtml}</div></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': stateCookie('', 0),   // 使い終わった state は必ず捨てる
    },
  });
}

/**
 * /auth/google と /auth/google/callback を受け持つ。それ以外のパスなら null を返す。
 *   opts.issueSession: () => Promise<string>  合言葉ログインと同じ Set-Cookie の値を返す関数
 *   opts.appName:      画面のタイトルに出すアプリ名
 */
export async function handleGoogleAuth(request, env, url, opts) {
  const path = url.pathname;
  if (path !== '/auth/google' && path !== '/auth/google/callback') return null;
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

  const appName = (opts && opts.appName) || '';
  // 設定がそろっていなければ、今までどおり合言葉の画面へ
  if (!googleEnabled(env)) return Response.redirect(url.origin + '/', 302);

  const redirectUri = `${url.origin}/auth/google/callback`;
  const retry = ['/auth/google', '別のアカウントで試す', true];
  const back = ['/', 'アプリに戻る（合言葉で入る）', false];

  // ---- 入口: Google へ送る
  if (path === '/auth/google') {
    const state = randomState();
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      prompt: 'select_account',
      state,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: `${AUTH_URL}?${q}`,
        'cache-control': 'no-store',
        'set-cookie': stateCookie(state, STATE_MAX_AGE),
      },
    });
  }

  // ---- 戻り: state を照合 → code を交換 → メールを確かめる
  if (url.searchParams.get('error')) {
    return page(400, 'Googleログインを取りやめました', 'もう一度試すか、合言葉で入ってください。', [['/auth/google', 'もう一度試す', true], back], appName);
  }
  const state = url.searchParams.get('state') || '';
  const saved = readCookie(request, STATE_COOKIE) || '';
  if (!state || !saved || !safeEqual(state, saved)) {
    return page(400, 'ログインをやり直してください', '時間が経ちすぎたか、別の画面から戻ってきたため確認できませんでした。', [['/auth/google', 'もう一度試す', true], back], appName);
  }
  const code = url.searchParams.get('code');
  if (!code) return page(400, 'ログインをやり直してください', 'Googleから必要な情報が返ってきませんでした。', [['/auth/google', 'もう一度試す', true], back], appName);

  let tokens;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    tokens = res.ok ? await res.json() : null;
    if (!res.ok) console.error('google token exchange failed', res.status, await res.text().catch(() => ''));
  } catch (e) {
    console.error('google token exchange error', e && e.stack || e);
    tokens = null;
  }
  if (!tokens || !tokens.id_token) {
    return page(502, 'Googleとのやりとりに失敗しました', '少し時間をおいてもう一度試してください。', [['/auth/google', 'もう一度試す', true], back], appName);
  }

  const p = decodeJwtPayload(tokens.id_token);
  const nowSec = Math.floor(Date.now() / 1000);
  const claimsOk = p
    && p.aud === env.GOOGLE_CLIENT_ID
    && (p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com')
    && (p.email_verified === true || p.email_verified === 'true')
    && typeof p.exp === 'number' && p.exp > nowSec
    && typeof p.email === 'string' && p.email;
  if (!claimsOk) {
    return page(400, 'Googleアカウントを確認できませんでした', 'メールアドレスが確認済みのアカウントでもう一度試してください。', [retry, back], appName);
  }

  const email = p.email.normalize('NFKC').trim().toLowerCase();
  if (!ownerEmails(env).includes(email)) {
    return page(403, 'このGoogleアカウントでは入れません', `${esc(email)} はこのアプリの持ち主として登録されていません。`, [retry, back], appName);
  }

  // 持ち主。合言葉で入ったときと同じセッション Cookie を出してトップへ
  const headers = new Headers({ location: url.origin + '/', 'cache-control': 'no-store' });
  headers.append('set-cookie', await opts.issueSession());
  headers.append('set-cookie', stateCookie('', 0));
  return new Response(null, { status: 302, headers });
}
