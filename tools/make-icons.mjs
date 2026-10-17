#!/usr/bin/env node
/*
 * 現行のアイコン（public/icon.svg。旧版の icon.svg と同じもの）から PNG を作る。
 *   npm run icons  →  public/icon-180.png（iPhone のホーム画面）/ icon-192.png / icon-512.png
 * iPhone の Safari は SVG のホーム画面アイコンを使わないので PNG が要る。
 * 描画は Windows に入っている Microsoft Edge のヘッドレスモードで行う（追加のインストール不要）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = path.join(root, 'public', 'icon.svg');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('Microsoft Edge が見つかりません'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wj-icons-'));
for (const size of [180, 192, 512]) {
  const html = path.join(tmp, `icon-${size}.html`);
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#0F0F1A;overflow:hidden">`
    + `<img src="${pathToFileURL(svg).href}" width="${size}" height="${size}" style="display:block"></body></html>`);
  const out = path.join(root, 'public', `icon-${size}.png`);
  const r = spawnSync(EDGE, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--user-data-dir=${path.join(tmp, 'profile')}`,
    `--window-size=${size},${size}`, `--screenshot=${out}`, pathToFileURL(html).href,
  ], { encoding: 'utf8' });
  if (!fs.existsSync(out)) { console.error(`icon-${size}.png を作れませんでした`, r.stderr); process.exit(1); }
  console.log(`icon-${size}.png  ${fs.statSync(out).size} bytes`);
}
