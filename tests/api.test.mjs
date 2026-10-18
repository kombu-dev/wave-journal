/*
 * API とデータの挙動テスト（ブラウザもデプロイも不要。数秒で終わる）
 *   npm test
 * D1 は Node 内蔵 SQLite で模擬する（cloudflare-app-builder スキルの d1-harness）。
 * deploy:dev / deploy:prod はこのテストが通らないと止まる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** アプリがリポジトリのどこに置かれても d1-harness を見つけられるよう、上へ辿って探す */
function findHarness(start) {
  let d = start;
  for (let i = 0; i < 10; i++) {
    const p = path.join(d, '.claude', 'skills', 'cloudflare-app-builder', 'scripts', 'd1-harness.mjs');
    if (fs.existsSync(p)) return p;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error('d1-harness.mjs が見つかりません（新たなる開発withclaude/.claude/skills/cloudflare-app-builder/scripts/）');
}
const { createApp, makeChecker } = await import(pathToFileURL(findHarness(root)).href);

const app = await createApp({ root, vars: { APP_ENV: 'test', APP_KEY: 'test-key-123' } });
const { check, done } = makeChecker();
console.log('migrations:', app.migrations.join(', '));

// Cookie を覚えて送る小さなクライアント
let cookie = '';
async function call(method, pathname, body) {
  const init = { method, headers: {} };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await app.worker.fetch(new Request('https://test.local' + pathname, init), app.env, app.ctx);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* JSON でない */ }
  return { status: res.status, body: json ?? text, headers: res.headers };
}
const count = (where = '1=1') => app.db.prepare(`select count(*) n from entries where ${where}`).get().n;
const live = (date) => app.db.prepare('select * from entries where date=? and deleted_at is null').get(date);

// ------------------------------------------------------------------ 合言葉
console.log('\n[合言葉]');
let r = await call('GET', '/api/env');
check('env は合言葉なしで見られる', r.status === 200 && r.body.env === 'test', r.body);

r = await call('GET', '/api/session');
check('session: 設定済み・未ログイン', r.body.configured === true && r.body.authed === false && !r.headers.get('set-cookie'), r.body);

for (const [m, p, b] of [
  ['GET', '/api/entries'], ['GET', '/api/export'], ['GET', '/api/trash'],
  ['PUT', '/api/days/2026-10-01', { value: 1, note: 'x' }], ['POST', '/api/import', []],
  ['DELETE', '/api/entries/abcdefgh'],
]) {
  r = await call(m, p, b);
  check(`合言葉なしでは ${m} ${p} が401`, r.status === 401 && r.body.code === 'auth', r.status);
}
check('合言葉なしの書き込みは何も残さない', count() === 0);

r = await call('POST', '/api/login', { key: 'wrong' });
check('違う合言葉は401', r.status === 401 && !cookie, r.status);

r = await call('POST', '/api/login', { key: 'test-key-123' });
check('正しい合言葉で入れる', r.status === 200 && cookie.startsWith('wj_session='), r.body);
const sc = r.headers.get('set-cookie');
check('Cookie は HttpOnly/Secure/400日', /HttpOnly/.test(sc) && /Secure/.test(sc) && /Max-Age=34560000/.test(sc), sc);

r = await call('GET', '/api/session');
check('開くたびに期限が延びる（Cookie を出し直す）', r.body.authed === true && /Max-Age=34560000/.test(r.headers.get('set-cookie') || ''));
r = await call('GET', '/api/entries');
check('画面の起動で最初に読む一覧でも期限が延びる', r.status === 200 && /Max-Age=34560000/.test(r.headers.get('set-cookie') || ''), r.headers.get('set-cookie'));
{
  const saved = cookie;
  cookie = '';
  r = await call('GET', '/api/entries');
  check('合言葉なしの一覧は401で、Cookie は出さない', r.status === 401 && !r.headers.get('set-cookie'));
  cookie = saved;
}

{
  const saved = app.env.APP_KEY;
  delete app.env.APP_KEY;
  r = await call('GET', '/api/entries');
  check('合言葉が未設定なら全部閉じる（Cookie があっても）', r.status === 503 && r.body.code === 'no_key', r.status);
  r = await call('GET', '/api/session');
  check('未設定なら session は configured:false', r.body.configured === false && r.body.authed === false, r.body);
  r = await call('POST', '/api/login', { key: '' });
  check('未設定のとき空の合言葉では入れない', r.status === 503, r.status);
  app.env.APP_KEY = saved;
}
{
  const saved = { env: app.env.APP_ENV, cookie };
  cookie = '';
  app.env.DEV_OPEN = '1';
  app.env.APP_ENV = 'prod';
  r = await call('GET', '/api/entries');
  check('本番では DEV_OPEN があっても開かない', r.status === 401, r.status);
  app.env.APP_ENV = 'test';
  r = await call('GET', '/api/entries');
  check('検証用以外（test）でも開かない', r.status === 401, r.status);
  app.env.APP_ENV = 'dev';
  r = await call('GET', '/api/entries');
  check('検証用は DEV_OPEN のときだけ開く', r.status === 200, r.status);
  delete app.env.DEV_OPEN;
  r = await call('GET', '/api/entries');
  check('DEV_OPEN を外せば検証用も閉じる', r.status === 401, r.status);
  app.env.APP_ENV = saved.env;
  cookie = saved.cookie;
}

// ------------------------------------------------------------------ 追加・編集・削除
console.log('\n[記録]');
r = await call('PUT', '/api/days/2026-10-01', { value: -2, note: '設計書を書いた' });
check('追加できる', r.status === 200 && r.body.created === true && r.body.entry.value === -2, r.body);
const firstId = r.body.entry.id;
await call('PUT', '/api/days/2026-10-02', { value: 3, note: '動画を見続けた' });
await call('PUT', '/api/days/2026-09-30', { value: 1, note: '' });

r = await call('GET', '/api/entries');
check('一覧は日付順に3件', r.body.entries.length === 3 && r.body.entries.map((e) => e.date).join() === '2026-09-30,2026-10-01,2026-10-02', r.body.entries.map((e) => e.date));

r = await call('PUT', '/api/days/2026-10-01', { value: 2, note: '絵を描いた' });
check('同じ日にもう一度記録すると書き換わる（増えない）', r.body.created === false && r.body.entry.id === firstId && count() === 3, r.body);
check('書き換えた中身', live('2026-10-01').value === 2 && live('2026-10-01').note === '絵を描いた');

for (const [b, why] of [
  [{ value: 0, note: '' }, '値0'], [{ value: 5 }, '値5'], [{ note: 'x' }, '値なし'], [{ value: 'abc' }, '文字'],
]) {
  r = await call('PUT', '/api/days/2026-10-03', b);
  check(`正しくない状態は400（${why}）`, r.status === 400, r.status);
}
r = await call('PUT', '/api/days/2026-02-30', { value: 1 });
check('ありえない日付は400', r.status === 400, r.status);
r = await call('PUT', '/api/days/2026-10-03', { value: 1, note: 'あ'.repeat(5000) });
check('長すぎるメモは切り詰める', r.status === 200 && live('2026-10-03').note.length === 1000);
await call('DELETE', '/api/entries/' + live('2026-10-03').id);

// 論理削除と復元
const id2 = live('2026-10-02').id;
r = await call('DELETE', '/api/entries/' + id2);
check('削除できる', r.status === 200, r.body);
check('行は残っている（論理削除）', count('id=\'' + id2 + '\' and deleted_at is not null') === 1);
r = await call('GET', '/api/entries');
check('一覧から消える', !r.body.entries.some((e) => e.id === id2));
r = await call('GET', '/api/trash');
check('ゴミ箱に入る', r.body.entries.some((e) => e.id === id2));
r = await call('DELETE', '/api/entries/' + id2);
check('2回消そうとしても404', r.status === 404);

r = await call('PUT', '/api/days/2026-10-02', { value: -1, note: '消したあと書き直し' });
check('消した日にまた記録できる（新しい行）', r.body.created === true && r.body.entry.id !== id2);
r = await call('POST', `/api/entries/${id2}/restore`);
check('同じ日に生きた記録があれば戻せない（409）', r.status === 409, r.status);
await call('DELETE', '/api/entries/' + live('2026-10-02').id);
r = await call('POST', `/api/entries/${id2}/restore`);
check('空いていればゴミ箱から戻せる', r.status === 200 && live('2026-10-02').id === id2, r.body);

// ------------------------------------------------------------------ 書き出し・読み込み
console.log('\n[書き出し・読み込み]');
const exp = (await call('GET', '/api/export')).body;
check('書き出しの形式', exp.format === 'wave-journal-backup' && Array.isArray(exp.entries), exp.format);
check('書き出しにはゴミ箱の分も入る', exp.entries.length === count() && exp.entries.some((e) => e.deleted_at), exp.entries.length);

const before = count();
r = await call('POST', '/api/import', exp);
check('書き出し→同じものを読み込んでも増えない', r.status === 200 && r.body.added === 0 && count() === before, r.body);

app.db.prepare('delete from entries where id=?').run(firstId); // 物理的に消えた状況を作る
r = await call('POST', '/api/import', exp);
check('消えた1件だけ戻る', r.body.added === 1 && count() === before && live('2026-10-01').id === firstId, r.body);

const tampered = JSON.parse(JSON.stringify(exp));
tampered.entries.find((e) => e.id === firstId).note = '上書きされたら困る';
await call('POST', '/api/import', tampered);
check('読み込みは既存行を上書きしない', live('2026-10-01').note === '絵を描いた');

r = await call('POST', '/api/import', { hello: 1 });
check('他のファイルは拒否', r.status === 400, r);
r = await call('POST', '/api/import', 'not json');
check('壊れたファイルは拒否', r.status === 400, r);

// ------------------------------------------------------------------ 旧版（GitHub Pages 版）の書き出し
console.log('\n[旧版の書き出しJSON]');
// 旧版の handleExport は JSON.stringify(entries, null, 2)。[{date, value, note}] の配列
const legacy = [
  { date: '2026-08-01', value: -3, note: '計画だけで終わった' },
  { date: '2026-08-02', value: 1, note: '' },
  { date: '2026-08-03', value: 2 },                                  // note が無い古い記録
  { date: '2026-10-01', value: 2, note: '絵を描いた' },             // 今ある記録とまったく同じ
  { date: '2026-09-30', value: -1, note: '旧版ではこう書いていた' }, // 今ある記録と中身が違う
  { date: 'bad', value: 1, note: '日付が壊れている' },
  { value: 1, note: '日付が無い' },
  { date: '2026-08-04', value: 9, note: 'ありえない値' },
  null,
];
const legacyText = JSON.stringify(legacy, null, 2);
const liveBefore = count('deleted_at is null');
const old930 = live('2026-09-30');

r = await call('POST', '/api/import', legacyText);
check('旧版の配列をそのまま読み込める', r.status === 200 && r.body.read === 5, r.body);
check('新しい日の3件が増える＋置き換え1件', r.body.added === 4 && r.body.replaced === 1 && r.body.skipped === 1, r.body);
check('生きている記録は3件増えた', count('deleted_at is null') === liveBefore + 3 && r.body.total === liveBefore + 3, r.body.total);
check('note が無い記録は空文字で入る', live('2026-08-03').note === '' && live('2026-08-03').value === 2);
check('同じ日の記録は旧版と同じく読み込んだ方が表に出る', live('2026-09-30').note === '旧版ではこう書いていた');
check('置き換えられた元の記録は消えずにゴミ箱へ', app.db.prepare('select deleted_at from entries where id=?').get(old930.id).deleted_at !== null
  && app.db.prepare('select note from entries where id=?').get(old930.id).note === old930.note);
check('まったく同じ記録は増やさない', count("date='2026-10-01'") === 1);

const n = count();
r = await call('POST', '/api/import', legacyText);
check('旧版の同じファイルをもう一度読んでも増えない・変わらない', r.body.added === 0 && r.body.replaced === 0 && count() === n, r.body);

// 旧版の中で同じ日が2回出てきたら、後ろの方を採る（旧版の Map と同じ）
r = await call('POST', '/api/import', [
  { date: '2026-07-01', value: -2, note: '前' },
  { date: '2026-07-01', value: 3, note: '後' },
]);
check('ファイル内で同じ日が重なったら後ろを採る', r.body.read === 1 && live('2026-07-01').note === '後' && count("date='2026-07-01'") === 1, r.body);

// 新版で書き換えたあとに旧版ファイルをもう一度読んでも、書き換えが戻されない
await call('PUT', '/api/days/2026-08-01', { value: -1, note: '新版で書き直した' });
await call('POST', '/api/import', legacyText);
check('新版で書き直した記録は、旧版ファイルの再読み込みで巻き戻らない', live('2026-08-01').note === '新版で書き直した');

r = await call('POST', '/api/import', []);
check('空の配列は0件', r.status === 200 && r.body.read === 0 && r.body.added === 0, r.body);

// 書き出し→読み込みの往復（旧版取り込み後も）
const exp2 = (await call('GET', '/api/export')).body;
const n2 = count();
r = await call('POST', '/api/import', exp2);
check('取り込み後の書き出しを読み直しても増えない', r.body.added === 0 && count() === n2, r.body);

// 大量（旧版の数年分）でも通る
const many = [];
for (let i = 0; i < 400; i++) {
  const d = new Date(Date.UTC(2024, 0, 1 + i));
  many.push({ date: d.toISOString().slice(0, 10), value: [-3, -2, -1, 1, 2, 3][i % 6], note: `day ${i}` });
}
r = await call('POST', '/api/import', many);
check('400日分の旧版ファイルを読める', r.status === 200 && r.body.added === 400, r.body);

// ------------------------------------------------------------------ その他
r = await call('POST', '/api/logout');
r = await call('GET', '/api/entries');
check('ログアウト後は見られない', r.status === 401);
r = await call('GET', '/api/nothing');
check('未知のAPIは401か404', r.status === 401 || r.status === 404);

done();
