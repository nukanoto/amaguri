# Cloudflare Workers IMAP → Discord 通知

Cloudflare Workers 上で 15 分おきに IMAP を監視し、未通知メールを Discord Webhook に送信します。前回の確認時刻と通知済みメールのハッシュ値は Workers KV に保存し、重複通知を防ぎます。

## 前提

- Cloudflare Workers で `tcp_sockets` 機能が利用可能であること（Cloudflare アカウント側で Beta を有効化してください）。
- Cron Trigger が利用可能なプラン。
- 読み取り可能な IMAP サーバー情報と Discord Webhook URL。

## 初期設定

1. 依存関係をインストール:
   ```bash
   pnpm install
   ```
2. KV 名前空間を作成して `wrangler.toml` の `REPLACE_WITH_*` を差し替え:
   ```bash
   pnpm wrangler kv:namespace create EMAIL_STATE
   pnpm wrangler kv:namespace create EMAIL_STATE --preview
   ```
3. IMAP 接続情報を `wrangler.toml` の `[vars]` で更新（必要に応じて `IMAP_MAILBOX` も変更）。
4. シークレットを登録:
   ```bash
   pnpm wrangler secret put IMAP_PASSWORD
   pnpm wrangler secret put DISCORD_WEBHOOK_URL
   ```
5. 動作確認:
   ```bash
   pnpm dev
   ```
6. デプロイ:
   ```bash
   pnpm deploy
   ```

## 動作概要

- Cron Trigger（`*/15 * * * *`）で `scheduled` ハンドラが起動。
- IMAP へ TLS 接続し、前回確認日時以降に届いた UID を検索。
- 取得したヘッダーから SHA-256 ハッシュを計算し、KV に保存済みのハッシュと比較。
- 新規メールのみ Discord Webhook へ送信し、通知成功時にハッシュ一覧と最終確認時刻を KV に更新。

`/` への `POST` リクエストでも手動実行が可能で、`GET` では現在の保存状態を確認できます。
