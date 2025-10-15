# Cloudflare Workers IMAP → Discord 通知

Cloudflare Workers 上で 15 分おきに IMAP を監視し、未通知メールを Discord Webhook に送信します。前回の確認時刻と通知済みメールのハッシュ値は Cloudflare D1 に保存し、重複通知を防ぎます。

## 前提

- Cloudflare Workers で `tcp_sockets` 機能が利用可能であること（Cloudflare アカウント側で Beta を有効化してください）。
- Cron Trigger が利用可能なプラン。
- 読み取り可能な IMAP サーバー情報と Discord Webhook URL。

## 初期設定

1. 依存関係をインストール:
   ```bash
   pnpm install
   ```
2. D1 データベースを作成して `wrangler.toml` の `REPLACE_WITH_*` を差し替え:
   ```bash
   pnpm wrangler d1 create EMAIL_STATE
   # 上記コマンドの出力から database_name と database_id を wrangler.toml に転記
   pnpm wrangler d1 migrations apply EMAIL_STATE
   ```
3. IMAP 接続情報や Webhook URL を環境変数で設定（本番は `wrangler secret put`、ローカル開発は `.dev.vars` に記述すると便利です）:
   ```bash
   pnpm wrangler secret put IMAP_HOST
   pnpm wrangler secret put IMAP_USERNAME
   pnpm wrangler secret put IMAP_PASSWORD
   pnpm wrangler secret put DISCORD_WEBHOOK_URL
   pnpm wrangler secret put IMAP_PORT        # 任意: 未指定時は 993
   pnpm wrangler secret put IMAP_SECURE      # 任意: on / starttls / off (既定は on)
   pnpm wrangler secret put IMAP_MAILBOX     # 任意: 未指定時は INBOX
   ```
4. 動作確認:
   ```bash
   pnpm dev
   ```
5. デプロイ:
   ```bash
   pnpm deploy
   ```

## 動作概要

- Cron Trigger（`*/15 * * * *`）で `scheduled` ハンドラが起動。
- IMAP へ TLS 接続し、前回確認日時以降に届いた UID を検索。
- 取得したヘッダーから SHA-256 ハッシュを計算し、D1 に保存済みのハッシュと比較。
- 新規メールのみ Discord Webhook へ送信し、通知成功時にハッシュ一覧と最終確認時刻を D1 に更新。

`/` への `POST` リクエストでも手動実行が可能で、`GET` では現在の保存状態を確認できます。
