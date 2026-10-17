-- 0001: 最初のスキーマ。
-- ここから先のスキーマ変更は 0002_*.sql, 0003_*.sql … を「足す」だけ。
-- 書いてよいのは CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN / CREATE INDEX IF NOT EXISTS / INSERT OR IGNORE。
-- DROP・列の削除や改名・作り直しはしない。適用済みのファイルは書き換えない。

-- 一日一回の記録。value は 理性の極 -3 / -2 / -1 / 1 / 2 / 3 感性の極（0 は無い）
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,             -- YYYY-MM-DD（記録した日。端末の日付）
  value       INTEGER NOT NULL,
  note        TEXT NOT NULL DEFAULT '',  -- 根拠となる事実（一行）
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                       -- 論理削除。NULL = 生きている
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS idx_entries_deleted ON entries(deleted_at);
-- 生きている記録は1日1件まで（ゴミ箱の中は何件あってもよい）
CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_live_date ON entries(date) WHERE deleted_at IS NULL;
