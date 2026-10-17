// serve-local（ローカルで画面ごと動かす）用の追加の値。
// 合言葉はローカル専用の 'local'（データは .local/dev.sqlite。本番とも検証用とも無関係）。
export default async () => ({ APP_KEY: 'local' });
