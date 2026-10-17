#!/usr/bin/env node
/*
 * 本番データベースをまるごとSQLファイルに書き出す（読み取りのみ・本番には何も書かない）。
 *   npm run backup:prod  →  backups/prod-YYYYMMDD-HHMM.sql
 * migrate:prod の前に自動で走り、失敗したら本番への変更を止める。
 * DB名は wrangler.jsonc の本番側 database_name から読む。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const conf = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
const m = conf.match(/"database_name"\s*:\s*"([^"]+)"/);   // 最初に出てくる＝本番側
if (!m) { console.error('wrangler.jsonc に database_name が見つかりません'); process.exit(1); }
const dbName = m[1];

const dir = path.join(ROOT, 'backups');
fs.mkdirSync(dir, { recursive: true });
const d = new Date(Date.now() + 9 * 3600 * 1000); // JST
const stamp = d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const out = path.join(dir, `prod-${stamp}.sql`);

// 最初の1回（まだ表が1つも無い）は守るものが無いので飛ばす。空のDBの export は失敗することがあるため。
{
  const sql = "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'";
  const probe = spawnSync(`npx wrangler d1 execute ${dbName} --remote --json --command "${sql}"`,
    { cwd: ROOT, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let n = null;
  try { n = JSON.parse(probe.stdout)[0].results[0].n; } catch { /* 読めなければ通常どおり書き出しを試す */ }
  if (n === 0) {
    console.log(`本番DB（${dbName}）はまだ空です（表がありません）。守るデータが無いのでバックアップは不要です。`);
    process.exit(0);
  }
}

console.log(`本番DB（${dbName}）を書き出しています →`, path.relative(ROOT, out));
// Windows の PowerShell は npx.ps1 を実行ポリシーで止めるので、shell 経由（cmd → npx.cmd）で呼ぶ。
// キーボード入力を渡さないので、Wrangler の「Ok to proceed?」は既定の yes で進む（書き出しは読むだけ）。
const r = spawnSync(`npx wrangler d1 export ${dbName} --remote "--output=${out}"`, {
  cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], shell: true,
});
if (r.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
  console.error('\nバックアップに失敗しました。本番への変更は中止します。');
  process.exit(1);
}
console.log(`完了: ${fs.statSync(out).size} bytes`);
