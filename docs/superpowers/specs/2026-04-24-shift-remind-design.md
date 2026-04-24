# Shift-Aware Return Reminder — 設計仕様

作成日: 2026-04-24
対象プロジェクト: slack-mention-bot（追客くん）
依頼: 堀江昂汰さん（シフト制が業務効率を下げる部分をエージェントでカバーしたい）

---

## 1. 目的

シフト制で休み中の人にメンションが届いても気付けない問題を、Botによる復帰日の自動リマインドで解消する。

**Before（手動）**
> @Suzuka Yokoyama お休みのところ失礼いたします。…
> 星つけておきましたのでお休み明けにご対応お願いいたします！

**After（Bot自動）**
1. 依頼者がメンション投稿
2. 依頼者または誰かが `:shift_matte:` リアクション
3. Botが休み明け（復帰日）の朝9:00にスレッドへ自動リプライ

## 2. スコープ

### 含む
- 新規ファイル `api/shift-remind.ts` 追加
- cron-job.org から毎朝 9:00 JST に叩く新エンドポイント
- Google Sheets（既存シフト表）を Service Account 経由で読み取り
- `:shift_matte:` が付いたメッセージ内の `<@U...>` 個人メンションを対象に判定
- 「昨日 `×` / 今日 `O`（または空白）」で復帰日と判定、スレッドへ @mention 付きリプライ 1回
- `:shift_done:` リアクションによる冪等性

### 含まない（将来拡張）
- 復帰日の時刻指定（朝9:00固定）
- 「休み中のメンション」の自動検知（emoji指示必須）
- シフト表の構造変更への自動追従
- DM通知
- `<!subteam^S...>` usergroup メンションの展開
- 単体テスト（既存chase.ts同様、手動検証のみ）

## 3. 既存資産との関係

- 既存 `api/chase.ts` は**一切変更しない**
- 既存の `:kakunin_yoro:` / `:zennin_kakunin:` / `:kakunin_zumi:` フローとは完全に別系統
- Slack Bot Token / Channel IDs / CRON_SECRET / ADMIN_USER_ID は流用

## 4. アーキテクチャ

```
[Slack channel]
   │  依頼者がメンション付きメッセージ投稿
   │  誰かが :shift_matte: リアクション付与
   ▼
[cron-job.org]  毎朝 9:00 JST (UTC 00:00)
   │  GET /api/shift-remind  (Authorization: Bearer CRON_SECRET)
   ▼
[api/shift-remind.ts]  Vercel Serverless Function
   1. CHANNEL_IDS の各チャンネルから過去 SHIFT_LOOKBACK_DAYS 日の履歴取得
   2. :shift_matte: ありかつ :shift_done: なしのメッセージを抽出
   3. msg.text から <@UXXXX> を抽出（個人メンションのみ）
   4. Google Sheets Service Account 認証で当月タブ読み取り
   5. 各対象ユーザーごとに「昨日×・今日O」で復帰判定
   6. 復帰者がいればスレッドに @mention 付きでリプライ（1メッセージに全員まとめる）
   7. 親メッセージに :shift_done: リアクション付与
   │
   │  エラー発生時は ADMIN_USER_ID に DM（既存chase.tsと同じパターン）
   ▼
[Response] { ok, processed, results: [...] }
```

## 5. データフロー詳細

### 5.1 メッセージ抽出

```ts
for (const channelId of channelIds) {
  const oldest = (Date.now() / 1000 - SHIFT_LOOKBACK_DAYS * 86400).toString();
  const history = await slack.conversations.history({
    channel: channelId,
    oldest,
    limit: 200,
  });
  for (const msg of history.messages ?? []) {
    const reactions = msg.reactions ?? [];
    const hasTrigger = reactions.some(r => r.name === SHIFT_REMIND_EMOJI);
    const hasDone = reactions.some(r => r.name === SHIFT_DONE_EMOJI);
    if (!hasTrigger || hasDone) continue;

    const mentionedIds = extractUserMentions(msg.text ?? "");
    if (mentionedIds.length === 0) continue;
    // → 候補に追加
  }
}
```

### 5.2 Google Sheets 読み取り

- パッケージ: `googleapis`（公式）
- 認証: Service Account（`GOOGLE_SERVICE_ACCOUNT_JSON` 環境変数にJSON保存）
- スコープ: `https://www.googleapis.com/auth/spreadsheets.readonly`
- 今日の月タブ名: `dayjs(today).format('YY/MM')` → 例 `"26/04"`
- 取得範囲: `'26/04'!A1:ZZ50` で一気に全体取得
- 同一cron実行中はメモリキャッシュ（同じタブを再取得しない）
- 月またぎ（例: 5/1の cron で前日 4/30 を参照）の場合、昨日タブを別途取得

### 5.3 復帰日判定ロジック

```ts
function isReturningToday(sheet, memberColumnName, today, yesterday): boolean {
  const headerRow = sheet[0];
  const col = headerRow.findIndex(h => h === memberColumnName);
  if (col === -1) return false;  // 列名未発見 → ADMIN通知

  const todayRow = findRowByDate(sheet, today);       // A列の日付と一致する行
  const yesterdayRow = findRowByDate(sheet, yesterday); // 月またぎは別シート

  const todayStatus = (todayRow?.[col] ?? "").trim();
  const yesterdayStatus = (yesterdayRow?.[col] ?? "").trim();

  // ステータス定義
  //   "O"    = 出勤
  //   "×"    = 休み
  //   ""     = 未入力（出勤扱い）
  //   その他（例："有給"）は想定外 → 出勤扱い
  const isOffYesterday = yesterdayStatus === "×";
  const isOnToday = todayStatus === "O" || todayStatus === "";

  return isOffYesterday && isOnToday;
}
```

### 5.4 通知

```
<@U111> <@U222> おはようございます！
お休み中に確認依頼が届いています。ご対応お願いします 🙏
```

- 1つの親メッセージで復帰者が複数いる場合、1リプライにまとめてメンション
- リプライ完了後に親メッセージへ `:shift_done:` 付与
- `already_reacted` エラーは無視（既存chase.tsの実装パターン踏襲）

### 5.5 冪等性

- `:shift_done:` が処理済みマーカー
- 同じ cron が連続で叩かれても、2回目以降はメッセージ抽出段階で `done-already` として除外
- Bot自身の reaction イベントは受けないため副作用なし

## 6. 環境変数

| 変数名 | 用途 | 例 |
|--------|------|-----|
| `SHIFT_REMIND_EMOJI` | トリガー絵文字 | `shift_matte` |
| `SHIFT_DONE_EMOJI` | 処理済みマーカー | `shift_done` |
| `SHIFT_SHEET_ID` | スプレッドシートID | `11WXjkrEhdCT0wOZ7-...` |
| `SHIFT_MEMBER_MAP` | `{ slack_user_id: sheet_column_name }` のJSON | `{"U0AJVQWFRGW":"成田(ミカタ)","U...":"伊澤"}` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service Account 認証情報（JSON） | `{"type":"service_account",...}` |
| `SHIFT_LOOKBACK_DAYS` | 何日前まで遡ってメッセージを探すか | `14` |

流用する既存変数: `SLACK_BOT_TOKEN`, `CHANNEL_IDS`, `CRON_SECRET`, `ADMIN_USER_ID`

**Vercel 登録手順（既存規約）:**
```bash
vercel env rm SHIFT_REMIND_EMOJI production --yes
printf '%s' 'shift_matte' | vercel env add SHIFT_REMIND_EMOJI production
# …同様に他の変数も登録
vercel --prod
```

## 7. エラー処理

| 障害点 | 挙動 |
|--------|------|
| Google Sheets 認証失敗 | ADMIN_USER_ID に DM「shift-remind: Sheets 認証失敗」、200 OK返却 |
| 当月タブが存在しない | 前月タブでリトライ、それも無ければ ADMIN に DM |
| `SHIFT_MEMBER_MAP` に無い user を @mention | そのユーザーだけスキップ。ログには残すが ADMIN 通知はしない（ノイズ防止） |
| ヘッダー列名未発見（例：略称変更） | 当該ユーザーをスキップ + ADMIN に DM「列名未発見: 成田(ミカタ)」 |
| Slack API rate limit / 送信失敗 | throw → まとめてADMIN に DM（既存chase.tsのerrors集約パターン踏襲） |
| `:shift_done:` 付与失敗（`already_reacted` 以外） | ADMIN に DM |
| Authorization Bearer不一致 | 401 返却（既存chase.tsと同じ） |

## 8. レスポンス

```json
{
  "ok": true,
  "processed": 5,
  "results": [
    {"channel": "C...", "ts": "1714...", "status": "reminded:2"},
    {"channel": "C...", "ts": "1714...", "status": "not-returning-today"},
    {"channel": "C...", "ts": "1714...", "status": "done-already"},
    {"channel": "C...", "ts": "1714...", "status": "no-mention"},
    {"channel": "C...", "ts": "1714...", "status": "column-not-found"}
  ]
}
```

## 9. テスト方針

自動テストは追加しない（既存chase.tsに揃える）。

**手動検証手順:**
1. `npx tsc --noEmit` で型チェック
2. テスト用チャンネルで自分宛メンションを投稿、`:shift_matte:` を付与
3. シート `SHIFT_SHEET_ID` の自分の列で「昨日=×, 今日=O」を設定
4. `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/shift-remind`
5. スレッドにリマインドが飛び、`:shift_done:` が付くことを確認
6. 再実行 → `done-already` が返る（冪等性確認）
7. シートで「昨日=O, 今日=O」に変えて同メッセージ + 新しい `:shift_matte:` → `not-returning-today` になる

## 10. デプロイ手順

1. **Service Account 作成**
   - Google Cloud Console でプロジェクト選択 → Service Account 新規作成
   - JSON key をダウンロード
   - 対象シートを Service Account のメールアドレスに「閲覧者」で共有

2. **環境変数登録**（`printf` 経由）
   - `SHIFT_REMIND_EMOJI`, `SHIFT_DONE_EMOJI`, `SHIFT_SHEET_ID`, `SHIFT_MEMBER_MAP`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SHIFT_LOOKBACK_DAYS`

3. **デプロイ**
   - `vercel --prod`

4. **cron-job.org に 2本目のジョブ追加**
   - URL: `https://slack-mention-bot-sepia.vercel.app/api/shift-remind`
   - Header: `Authorization: Bearer <CRON_SECRET>`
   - Schedule: 毎日 9:00 JST（UTC `0 0 * * *`）
   - Timeout: 60s（`export const config = { maxDuration: 60 }` に合わせる）

5. **Slack 側**
   - `:shift_matte:` と `:shift_done:` のカスタム絵文字を追加（Slack ワークスペース管理）

## 11. 確定事項（2026-04-24 堀江さん承認）

- [x] emoji名は `:shift_matte:` / `:shift_done:`
- [x] リマインド時刻は朝9:00固定
- [x] 初版は個人メンション (`<@U...>`) のみ対応、usergroup (`<!subteam^S...>`) は次版
- [x] 対象チャンネルは既存 `CHANNEL_IDS` と共用（デフォルト）
- [x] 休みの判定は `×` のみ（コメント列・「希望休」「有給」文字列は見ない）

## 12. 参考

- 対象シート: `https://docs.google.com/spreadsheets/d/11WXjkrEhdCT0wOZ7-KzYDt1lvuypDdLIV9vRu4jKk-U/edit?gid=284854056`
- 既存 Bot: `api/chase.ts`（221行、`:kakunin_yoro:` 48h追客）
- 要件定義者: 成田彩香さん、実装依頼者: 堀江昂汰さん
