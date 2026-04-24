# 追客くん（Slack催促Bot）

## 概要
Vercel Serverless Function + cron-job.org で動作するSlack未確認メッセージ催促Bot。
`:kakunin_yoro:` リアクションをトリガーに、48時間後から未確認メンバーに自動催促を送信する。

## コード構成
- `api/chase.ts` — Bot本体（約210行、単一ファイル）
- `vercel.json` — Vercel設定
- `slack-chase-bot.n8n.json` — 旧n8nワークフロー（廃止済み、参考用）

## 開発フロー
```bash
# 型チェック
npx tsc --noEmit

# デプロイ
vercel --prod

# 動作確認
curl -H "Authorization: Bearer $CRON_SECRET" https://slack-mention-bot-sepia.vercel.app/api/chase
```

## 環境変数の追加・変更
```bash
# 必ず printf を使う（echo は改行が混入する）
vercel env rm VAR_NAME production --yes
printf '%s' 'value' | vercel env add VAR_NAME production
vercel --prod
```

## 現在の環境変数
- `SLACK_BOT_TOKEN` / `CHANNEL_IDS` / `TRIGGER_EMOJI` (kakunin_yoro)
- `CONFIRM_EMOJI` (kakunin_zumi) / `DONE_EMOJI` (zennin_kakunin)
- `ADMIN_USER_ID` / `CRON_SECRET` / `BOT_EXCLUDE_USERS` / `BOT_EXCLUDE_GROUPS`

## 最終仕様（2026-04-12確定）
- 48時間後から催促開始（Bot初検出時刻基準、最大4hズレ）
- 4時間ごとにチェック・催促
- エスカレーション: 48-72h 通常 / 72-96h 警告 / 96h+ 緊急
- CEOグループ除外 / マルチチャンネル / エラーDM通知
- 要件定義者: 成田彩香さん（U0AJVQWFRGW）
