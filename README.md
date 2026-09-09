# Slack 未リアクション追撃 Bot

Slackの特定投稿に対し、メンション先ユーザーグループ内で確認リアクションをしていないメンバーを5分おきに検知し、スレッドで催促するBot。

## 仕組み

- Vercel Cron が5分おきに `/api/chase` を叩く
- Slack `conversations.history` で直近20件を取得
- 投稿者自身が `TRIGGER_EMOJI` (例: `:mega:`) を付けた投稿のみ対象
- 本文の `<!subteam^...>` からユーザーグループを抽出
- グループメンバー − `CONFIRM_EMOJI` リアクション済みユーザー − 投稿者 − 除外ユーザー = 未対応者
- 未対応者 > 0 → スレッドに `@mention` 付きで催促
- 未対応者 = 0 → 投稿に `DONE_EMOJI` を付けて以後スキップ（状態はSlack上に保存）

## セットアップ

### 1. Slack App 作成
https://api.slack.com/apps → Create New App → From scratch

**Bot Token Scopes** (OAuth & Permissions):
- `channels:history` (publicチャンネル) / `groups:history` (privateチャンネル)
- `channels:read` (`CHASE_AUTO_CHANNELS` でチャンネル自動検出を使う場合のみ)
- `reactions:read`
- `reactions:write`
- `usergroups:read`
- `chat:write`

**Install to Workspace** → `xoxb-...` トークンをコピー。対象チャンネルに `/invite @BotName`。

### 2. 残りの環境変数を登録
```bash
vercel env add SLACK_BOT_TOKEN production   # xoxb-...
vercel env add CHANNEL_ID production        # C0123456789
# 任意:
vercel env add BOT_EXCLUDE_USERS production  # U_BOT1,U_BOT2
```

既に設定済み (Production):
- `CRON_SECRET` (自動生成)
- `TRIGGER_EMOJI=mega`
- `CONFIRM_EMOJI=white_check_mark`
- `DONE_EMOJI=done`

絵文字を変えたい場合は `vercel env rm <NAME> production` → `vercel env add` で差し替え。

### 3. デプロイ
```bash
vercel --prod
```

### 4. 動作確認
テストチャンネルで:
1. 投稿者自身が投稿に `:mega:` リアクション
2. 本文に `@ユーザーグループ` メンション
3. 5分待つ、または手動実行:
   ```bash
   CRON_SECRET=$(vercel env pull /tmp/.env --environment=production --yes >/dev/null && grep CRON_SECRET /tmp/.env | cut -d'"' -f2)
   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>.vercel.app/api/chase
   ```
4. スレッドに催促返信が来るか確認
5. 全員が `:white_check_mark:` を付けたら次回実行でBotが `:done:` を付与

## ローカル開発
```bash
vercel env pull .env.local
vercel dev
curl -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d'=' -f2 | tr -d '\"')" http://localhost:3000/api/chase
```

## ファイル構成
- `api/chase.ts` — Cronハンドラ (Node.js, Fluid Compute)
- `vercel.json` — Cron設定 `*/5 * * * *`
- `package.json` / `tsconfig.json`
