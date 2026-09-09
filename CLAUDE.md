# 追客くん（Slack催促Bot）

## 概要
Vercel Serverless Function + cron-job.org で動作するSlack未確認メッセージ催促Bot。
`:kakunin_yoro:` リアクションをトリガーに、48時間後から未確認メンバーに自動催促を送信する。

## コード構成
- `api/chase.ts` — 追客本体（`:kakunin_yoro:` 48h追客）
- `api/shift-remind.ts` — 休み明けリマインド本体（`:kyuake_yoro:` トリガー、毎朝9:00 JST）
- `vercel.json` — Vercel設定（両エンドポイント `maxDuration: 60`）
- `scripts/list-users.ts` — Slack ワークスペース member 一覧取得（`SHIFT_MEMBER_MAP` 作成用）
- `scripts/gen-emoji.py` — `kyuake-yoro.png` 生成（Pillow）
- `docs/superpowers/specs/2026-04-24-shift-remind-design.md` — 設計仕様
- `docs/superpowers/plans/2026-04-24-shift-remind.md` — 実装計画
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

### 共通
- `SLACK_BOT_TOKEN` / `CRON_SECRET` / `ADMIN_USER_ID`
- `CHANNEL_IDS` — 監視対象チャンネルID（カンマ区切り）。**shift-remind と共有。空にすると shift-remind が停止する**

### chase（追客）
- `CHASE_AUTO_CHANNELS` — `1` または `true` でBot参加チャンネルの自動検出を有効化。未設定なら `CHANNEL_IDS` を使う従来動作
- `TRIGGER_EMOJI` (kakunin_yoro) / `CONFIRM_EMOJI` (kakunin_zumi) / `DONE_EMOJI` (zennin_kakunin)
- `BOT_EXCLUDE_USERS` / `BOT_EXCLUDE_GROUPS`

### shift-remind（休み明けリマインド）
- `SHIFT_REMIND_EMOJI` (kyuake_yoro) / `SHIFT_DONE_EMOJI` (white_check_mark)
- `SHIFT_SHEET_ID` — シフト表のGoogle Spreadsheet ID
- `SHIFT_MEMBER_MAP` — `{ slack_user_id: sheet_column_name }` のJSON
- `GOOGLE_SERVICE_ACCOUNT_JSON` — Google Sheets API用 Service Account credentials
- `SHIFT_LOOKBACK_DAYS` (14) — 何日前までのメッセージを走査するか

## chase仕様（2026-04-12確定 / 2026-04-27 timing redesign）
- 48時間後から催促開始（**メッセージ投稿時刻 `msg.ts` 基準**）
- 4時間ごとにチェック・催促
- エスカレーション: 48-72h 通常 / 72-96h 警告 / 96h+ 緊急
- 走査対象は既定で `CHANNEL_IDS`。`CHASE_AUTO_CHANNELS=1` でBot参加チャンネルの自動検出に切り替わる（要 `channels:read`。private のみなら既存スコープで動く）
- 走査範囲は直近10日・1チャンネルあたり200件。45秒で打ち切り、開始位置を実行ごとにローテーションする
- CEOグループ除外 / マルチチャンネル / エラーDM通知
- 要件定義者: 成田彩香さん（U0AJVQWFRGW）

## shift-remind仕様（2026-04-24確定）
- 依頼者がメンション付きメッセージに `:kyuake_yoro:` を付与
- 毎朝9:00 JST に cron が起動、Google Sheets で「昨日=×／今日=O or 空」の人を検出
- 該当者がいれば元スレッドに @mention 付きでリマインド投稿
- per-user dedup: 既にbotがメンションしたuidはスキップ（複数日復帰のメッセージにも対応）
- 全mapped mentionが処理済みになった時のみ `:white_check_mark:` を親メッセージに付与
- 依頼者: 堀江昂汰さん（U0ADVCK5ALT）
