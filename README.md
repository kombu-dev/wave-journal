# Wave Journal（理性と感性の波）

理性と感性のバランスを一日一回記録するジャーナル。PCでもスマホでも、ホーム画面から開ける（PWA）。

このリポジトリには2つの版が同居している。

| | 置き場所 | 記録の保存先 |
|---|---|---|
| **新版（Cloudflare 版）** | `public/` `src/` `migrations/` ほか | Cloudflare D1（どの端末から開いても同じ記録） |
| 旧版（GitHub Pages 版） | `wave-journal.html` `sw.js` `manifest.json` `icon.svg` | その端末のブラウザの中（localStorage） |

旧版は、スマホに残っている記録を書き出すための出口として**そのまま残してある**（ファイルは変えていない）。
`.nojekyll` は、GitHub Pages がこの README を旧版のトップページに変えてしまわないためのもの。

## URL

| | URL | 記録 |
|---|---|---|
| 本番 | https://wave-journal.puccho082.workers.dev | D1 `wave-journal` |
| 検証用 | https://wave-journal-dev.puccho082.workers.dev | D1 `wave-journal-dev` |
| ローカル | http://localhost:5192（serve-local。`preview_start {name:"wave-journal"}`） | `.local/dev.sqlite` |
| 旧版 | https://kombu-dev.github.io/wave-journal/wave-journal.html | 端末の中 |

検証用とローカルは画面の上に黄黒の帯が出る。本番には出ない。

## 入口の合言葉

日々の心の状態の記録なので、URLを知っているだけでは見られないようにしてある（selftalk と同じ仕組み）。

- 本番の合言葉は Worker の秘密の値 `APP_KEY`。**本人が決める**。
- **未設定のあいだ、本番は全部閉じている**（「合言葉がまだ設定されていません」と出て、記録は見えない・書けない）。
- 一度入れた端末には 400 日有効の Cookie を置くので、毎回は聞かれない（開くたびに期限が延びる）。合言葉を変えると全端末がログアウトされる。
- 検証用は `wrangler.jsonc` の vars に固定値（中身はテストデータだけ）。ローカルは `local`。

### 合言葉の決め方（本人が1回だけ）

PowerShell で次の1行を実行し、`Enter a secret value:` と聞かれたら合言葉を打って Enter（打った文字は画面に出ない）。

```
& "C:\Program Files\nodejs\npm.cmd" --prefix "C:\Users\Owner\Documents\新たなる開発withclaude\wave-journal-app" run set-key
```

- 入れた直後から本番が開く（デプロイし直す必要はない）。
- 変えたいときも同じコマンド。忘れたら同じコマンドで新しい合言葉にすればよい（記録は消えない）。
- 長めの、自分だけが分かる言葉にする（スマホでも打ちやすいもの）。

## データの守り方

- 本番と検証用は Worker もデータベースも別。動作確認は検証用かローカルで行う。本番にテストデータは入れない。
- 1日に表に出る記録は1件。同じ日にもう一度記録すると、その記録を書き換える（旧版と同じ「上書きできる」）。
- 削除は「本当に消す？」を挟んだうえでゴミ箱行き（論理削除）。「波を見る」の下の「ゴミ箱」から戻せる。
- スキーマ変更は `migrations/` に番号付きの SQL を**足すだけ**（列の追加・テーブルの追加のみ）。
- 本番へのマイグレーション前に `backups/` へ自動でバックアップを取る（`backups/` は Git に入れない）。
- 「波を見る」の下の「書き出す／読み込む」で記録を手元にも保存できる。
  - 読み込みは**追記だけ**。同じものを何度読み込んでも増えない。今ある記録は書き換えない。
  - **旧版の書き出しファイル（`wave-journal-backup-YYYY-MM-DD.json`）もそのまま読み込める。**
  - 同じ日の記録が両方にあって中身が違うときは、旧版の「読み込む」と同じく読み込んだ方を表に出す。元の記録は消さずにゴミ箱へ移す（いつでも戻せる）。
- 最後の保険：D1 Time Travel で30日以内の任意の時点に戻せる（`npx wrangler d1 time-travel info wave-journal`）。

## 旧版（スマホ）からの引っ越し

1. スマホで旧版（https://kombu-dev.github.io/wave-journal/wave-journal.html 、ホーム画面に置いたアイコン）を開く。
2. 「波を見る」→ 一番下の「データのバックアップ」の **書き出す** を押す。`wave-journal-backup-YYYY-MM-DD.json` がスマホに保存される。
3. 同じスマホで新版（https://wave-journal.puccho082.workers.dev ）を開き、合言葉を入れる。
4. 「波を見る」→ 一番下の **読み込む** を押し、2. のファイルを選ぶ。
5. 「N件を読み込み、統合しました（合計M件）」と出れば完了。波と一覧に旧版の記録が並ぶ。

旧版の記録は消えない（旧版のデータはスマホの中にそのまま残る）。何度やり直しても二重にはならない。

## コマンド

PowerShell では `npm` が実行ポリシーで止まるので `npm.cmd` を使う。

```
& "C:\Program Files\nodejs\npm.cmd" --prefix "C:\Users\Owner\Documents\新たなる開発withclaude\wave-journal-app" run <script>
```

| script | 内容 |
|---|---|
| `test` | API とデータの挙動テスト（D1 を模擬。数秒・ブラウザ不要） |
| `deploy:dev` | テスト → 検証用へ |
| `deploy:prod` | テスト → 本番へ（データには触れない） |
| `migrate:dev` / `migrate:prod` | マイグレーション（本番は先にバックアップ） |
| `backup:prod` | 本番DBを `backups/` に書き出し |
| `set-key` | 本番の合言葉（APP_KEY）を決める・変える |
| `icons` | `public/icon.svg` から PNG アイコン（iPhone 用など）を作り直す |

テストは親フォルダ（`新たなる開発withclaude/.claude/skills/cloudflare-app-builder/scripts/d1-harness.mjs`）を使うので、このリポジトリ単体で clone した場所では動かない。

## 旧版から変えたところ

- 記録の置き場所が端末の中 → Cloudflare D1。React の CDN 読み込みをやめて素の JS にした（見た目と言葉・操作は同じ）。
- 「今日」は端末の日付で決める。旧版は世界標準時の日付だったので、日本の朝9時前に開くと前日扱いになっていた。
- 記録の削除（ゴミ箱つき）を足した。「記録する」でその日がもう記録済みのとき「この日の記録を消す」が出る。
- iPhone のホーム画面用に PNG アイコンを足した（図柄は旧版の icon.svg そのもの）。
