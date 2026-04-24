# Shift-Aware Return Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 毎朝9:00に Google Sheets のシフト表を読み取り、休み明け復帰したメンバー宛の `:shift_matte:` リアクション付きメッセージを検出してスレッドに自動リマインドを送る新エンドポイント `api/shift-remind.ts` を追加する。

**Architecture:** 既存 `api/chase.ts` には手を入れず、新規 Vercel Serverless Function として独立実装。cron-job.org から毎朝叩かれ、Slack `conversations.history` で過去 N 日のメッセージを走査、`:shift_matte:` 付き・`:shift_done:` 未済のものに対して Google Sheets（Service Account 認証）を参照して「昨日=×／今日=O or 空」の復帰者を判定、スレッドに @mention 付きリプライを1回送って `:shift_done:` でマーク。

**Tech Stack:** TypeScript（ESM）/ `@vercel/node` / `@slack/web-api`（既存）/ `googleapis`（新規追加）/ Google Sheets API v4 Service Account

**Spec:** `docs/superpowers/specs/2026-04-24-shift-remind-design.md`

> **自動テストについて:** 既存 `chase.ts` に合わせて、本プロジェクトはユニットテストを追加しない方針（spec §9 承認済み）。各タスク末尾の確認は `npx tsc --noEmit` による型チェックを使用し、全体の動作確認は最終タスクの手動検証で行う。

---

## File Structure

| パス | 種別 | 責務 |
|------|------|------|
| `api/shift-remind.ts` | 新規 | エンドポイント本体。env 解析／Slack メッセージ走査／Sheets 取得／復帰判定／通知を1ファイルで実装（既存 `chase.ts` の構成に合わせる） |
| `vercel.json` | 変更 | `functions` に `api/shift-remind.ts` を追加（`maxDuration: 60`） |
| `package.json` | 変更 | `dependencies` に `googleapis` を追加 |

---

## Task 1: `googleapis` パッケージを追加

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`（`npm install` で自動更新）

- [ ] **Step 1: 依存をインストール**

```bash
cd /Users/takagiyoshiharu/slack-mention-bot
npm install googleapis@^144
```

- [ ] **Step 2: `package.json` の `dependencies` に反映されたことを確認**

Run: `node -e "console.log(require('./package.json').dependencies)"`
Expected: `{ '@slack/web-api': '^7.9.0', googleapis: '^144.x.x' }`

- [ ] **Step 3: 型チェックが通ることを確認**

Run: `npx tsc --noEmit`
Expected: 出力なし（エラーゼロ）

- [ ] **Step 4: コミット**

```bash
git add package.json package-lock.json
git commit -m "chore: add googleapis for shift-remind"
```

---

## Task 2: `api/shift-remind.ts` の骨格（env 解析・型定義・ハンドラ雛形）

**Files:**
- Create: `api/shift-remind.ts`

- [ ] **Step 1: ファイルを新規作成して以下の骨格を書く**

```ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { WebClient } from "@slack/web-api";
import { google } from "googleapis";

export const config = { maxDuration: 60 };

const {
  SLACK_BOT_TOKEN = "",
  CHANNEL_IDS = "",
  SHIFT_REMIND_EMOJI = "shift_matte",
  SHIFT_DONE_EMOJI = "shift_done",
  SHIFT_SHEET_ID = "",
  SHIFT_MEMBER_MAP = "{}",
  GOOGLE_SERVICE_ACCOUNT_JSON = "",
  SHIFT_LOOKBACK_DAYS = "14",
  CRON_SECRET = "",
  ADMIN_USER_ID = "",
} = process.env;

const channelIds = CHANNEL_IDS.split(",").map((s) => s.trim()).filter(Boolean);

type MemberMap = Record<string, string>;
type SlackReaction = { name: string; users: string[] };
type SlackMessage = {
  ts: string;
  user?: string;
  text?: string;
  reactions?: SlackReaction[];
};
type SheetGrid = string[][];

function parseMemberMap(): MemberMap {
  try {
    return JSON.parse(SHIFT_MEMBER_MAP) as MemberMap;
  } catch {
    return {};
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (CRON_SECRET) {
    const authHeader = req.headers["authorization"];
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).send("Unauthorized");
    }
  }

  if (!SLACK_BOT_TOKEN || channelIds.length === 0 || !SHIFT_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.status(500).json({
      error: "missing env",
      need: ["SLACK_BOT_TOKEN", "CHANNEL_IDS", "SHIFT_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"],
    });
  }

  // TODO: implementation will be added in subsequent tasks
  return res.status(200).json({ ok: true, processed: 0, results: [] });
}
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーゼロ

- [ ] **Step 3: コミット**

```bash
git add api/shift-remind.ts
git commit -m "feat: scaffold shift-remind endpoint"
```

---

## Task 3: メンション抽出ヘルパ

**Files:**
- Modify: `api/shift-remind.ts`

- [ ] **Step 1: `parseMemberMap` の直下に以下を追加**

```ts
function extractUserMentions(text: string): string[] {
  const ids = new Set<string>();
  const re = /<@(U[A-Z0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーゼロ

- [ ] **Step 3: コミット**

```bash
git add api/shift-remind.ts
git commit -m "feat(shift-remind): add user mention extraction helper"
```

---

## Task 4: JST 日付／タブ名ユーティリティ

**Files:**
- Modify: `api/shift-remind.ts`

- [ ] **Step 1: `extractUserMentions` の直下に追加**

```ts
function getJstNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function addDays(d: Date, delta: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + delta);
  return copy;
}

function formatYYMM(d: Date): string {
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}/${mm}`;
}

function formatMD(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
```

> **補足:** `getJstNow()` が返す Date は「UTC時刻が +9h ずれた値」。以降の `addDays` / `formatYYMM` / `formatMD` はすべて `getUTC*` で読み、JST 日時として扱う。`setDate` を使うとローカルタイムゾーンに依存するため `setUTCDate` に統一する。

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーゼロ

- [ ] **Step 3: コミット**

```bash
git add api/shift-remind.ts
git commit -m "feat(shift-remind): add JST date helpers"
```

---

## Task 5: Google Sheets クライアント＆タブ取得

**Files:**
- Modify: `api/shift-remind.ts`

- [ ] **Step 1: `formatMD` の直下に追加**

```ts
type SheetsClient = ReturnType<typeof google.sheets>;

async function createSheetsClient(): Promise<SheetsClient> {
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

async function fetchSheetTab(
  sheets: SheetsClient,
  tabName: string,
): Promise<SheetGrid | null> {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHIFT_SHEET_ID,
      range: `'${tabName}'!A1:ZZ50`,
    });
    return (res.data.values ?? []) as SheetGrid;
  } catch (e: any) {
    const status = e?.response?.status ?? e?.code;
    if (status === 400) return null; // invalid range = tab not found
    throw e;
  }
}
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーゼロ

- [ ] **Step 3: コミット**

```bash
git add api/shift-remind.ts
git commit -m "feat(shift-remind): add Google Sheets fetch via Service Account"
```

---

## Task 6: グリッド検索ヘルパ＋復帰日判定

**Files:**
- Modify: `api/shift-remind.ts`

- [ ] **Step 1: `fetchSheetTab` の直下に追加**

```ts
function findColumnByHeader(grid: SheetGrid, headerName: string): number {
  const header = grid[0] ?? [];
  return header.findIndex((h) => (h ?? "").toString().trim() === headerName);
}

function findRowIndexByDate(grid: SheetGrid, targetMD: string): number {
  for (let i = 1; i < grid.length; i++) {
    const cell = (grid[i]?.[0] ?? "").toString().trim();
    if (cell === targetMD) return i;
  }
  return -1;
}

type ReturnVerdict = "yes" | "no" | "column-not-found";

function isReturningToday(
  todayGrid: SheetGrid,
  yesterdayGrid: SheetGrid,
  columnName: string,
  todayMD: string,
  yesterdayMD: string,
): ReturnVerdict {
  const todayCol = findColumnByHeader(todayGrid, columnName);
  const yesterdayCol = findColumnByHeader(yesterdayGrid, columnName);
  if (todayCol === -1 || yesterdayCol === -1) return "column-not-found";

  const todayRow = findRowIndexByDate(todayGrid, todayMD);
  const yesterdayRow = findRowIndexByDate(yesterdayGrid, yesterdayMD);
  if (todayRow === -1 || yesterdayRow === -1) return "no";

  const todayStatus = (todayGrid[todayRow]?.[todayCol] ?? "").toString().trim();
  const yesterdayStatus = (yesterdayGrid[yesterdayRow]?.[yesterdayCol] ?? "").toString().trim();

  const isOffYesterday = yesterdayStatus === "×";
  const isOnToday = todayStatus === "O" || todayStatus === "";
  return isOffYesterday && isOnToday ? "yes" : "no";
}
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーゼロ

- [ ] **Step 3: コミット**

```bash
git add api/shift-remind.ts
git commit -m "feat(shift-remind): add grid lookup and return-day verdict"
```

---

## Task 7: ハンドラ本体（メイン処理）

**Files:**
- Modify: `api/shift-remind.ts`

- [ ] **Step 1: `handler` 関数内の `// TODO: implementation will be added ...` 以下を丸ごと差し替える**

差し替え前：
```ts
  // TODO: implementation will be added in subsequent tasks
  return res.status(200).json({ ok: true, processed: 0, results: [] });
```

差し替え後：
```ts
  const slack = new WebClient(SLACK_BOT_TOKEN);
  const memberMap = parseMemberMap();
  const errors: string[] = [];

  let sheets: SheetsClient;
  try {
    sheets = await createSheetsClient();
  } catch (e) {
    const msg = `shift-remind: Sheets auth failed — ${(e as Error).message}`;
    if (ADMIN_USER_ID) {
      await slack.chat.postMessage({ channel: ADMIN_USER_ID, text: `⚠️ ${msg}` }).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: msg });
  }

  const jstNow = getJstNow();
  const jstYesterday = addDays(jstNow, -1);
  const todayTabName = formatYYMM(jstNow);
  const yesterdayTabName = formatYYMM(jstYesterday);
  const todayMD = formatMD(jstNow);
  const yesterdayMD = formatMD(jstYesterday);

  let todayGrid: SheetGrid | null;
  let yesterdayGrid: SheetGrid | null;
  try {
    todayGrid = await fetchSheetTab(sheets, todayTabName);
    yesterdayGrid =
      todayTabName === yesterdayTabName
        ? todayGrid
        : await fetchSheetTab(sheets, yesterdayTabName);
  } catch (e) {
    const msg = `shift-remind: Sheets fetch failed — ${(e as Error).message}`;
    if (ADMIN_USER_ID) {
      await slack.chat.postMessage({ channel: ADMIN_USER_ID, text: `⚠️ ${msg}` }).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: msg });
  }

  if (!todayGrid || !yesterdayGrid) {
    const msg = `shift-remind: tab not found (today=${todayTabName}, yesterday=${yesterdayTabName})`;
    if (ADMIN_USER_ID) {
      await slack.chat.postMessage({ channel: ADMIN_USER_ID, text: `⚠️ ${msg}` }).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: msg });
  }

  const lookbackDays = Number(SHIFT_LOOKBACK_DAYS) || 14;
  const results: { channel: string; ts: string; status: string; error?: string }[] = [];

  for (const channelId of channelIds) {
    const oldest = String(Math.floor(Date.now() / 1000 - lookbackDays * 86400));
    let history;
    try {
      history = await slack.conversations.history({
        channel: channelId,
        oldest,
        limit: 200,
      });
    } catch (e) {
      errors.push(`history(${channelId}): ${(e as Error).message}`);
      continue;
    }

    for (const msg of (history.messages ?? []) as SlackMessage[]) {
      if (!msg.ts) continue;
      const reactions = msg.reactions ?? [];
      const hasTrigger = reactions.some((r) => r.name === SHIFT_REMIND_EMOJI);
      const hasDone = reactions.some((r) => r.name === SHIFT_DONE_EMOJI);
      if (!hasTrigger) continue;
      if (hasDone) {
        results.push({ channel: channelId, ts: msg.ts, status: "done-already" });
        continue;
      }
      const mentions = extractUserMentions(msg.text ?? "");
      if (mentions.length === 0) {
        results.push({ channel: channelId, ts: msg.ts, status: "no-mention" });
        continue;
      }

      try {
        const returningToday: string[] = [];
        const unknownColumns: string[] = [];
        for (const uid of mentions) {
          const columnName = memberMap[uid];
          if (!columnName) continue; // not managed → silent skip
          const verdict = isReturningToday(
            todayGrid,
            yesterdayGrid,
            columnName,
            todayMD,
            yesterdayMD,
          );
          if (verdict === "yes") returningToday.push(uid);
          if (verdict === "column-not-found") unknownColumns.push(columnName);
        }

        if (unknownColumns.length > 0) {
          errors.push(`column-not-found: ${unknownColumns.join(", ")}`);
        }

        if (returningToday.length === 0) {
          results.push({ channel: channelId, ts: msg.ts, status: "not-returning-today" });
          continue;
        }

        const mentionText = returningToday.map((u) => `<@${u}>`).join(" ");
        await slack.chat.postMessage({
          channel: channelId,
          thread_ts: msg.ts,
          text: `${mentionText} おはようございます！\nお休み中に確認依頼が届いています。ご対応お願いします 🙏`,
        });
        try {
          await slack.reactions.add({
            channel: channelId,
            timestamp: msg.ts,
            name: SHIFT_DONE_EMOJI,
          });
        } catch (e: any) {
          if (e?.data?.error !== "already_reacted") {
            errors.push(`reactions.add(${msg.ts}): ${e.message}`);
          }
        }
        results.push({
          channel: channelId,
          ts: msg.ts,
          status: `reminded:${returningToday.length}`,
        });
      } catch (e) {
        results.push({
          channel: channelId,
          ts: msg.ts,
          status: "error",
          error: (e as Error).message,
        });
      }
    }
  }

  if (errors.length > 0 && ADMIN_USER_ID) {
    await slack.chat.postMessage({
      channel: ADMIN_USER_ID,
      text: `⚠️ shift-remind エラー (${errors.length}件)\n${errors.map((e) => `• ${e}`).join("\n")}`,
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーゼロ

- [ ] **Step 3: コミット**

```bash
git add api/shift-remind.ts
git commit -m "feat(shift-remind): implement main handler"
```

---

## Task 8: `vercel.json` に新エンドポイントの関数設定を追加

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: `vercel.json` の `functions` にエントリ追加**

変更前:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/chase.ts": { "maxDuration": 60 }
  }
}
```

変更後:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/chase.ts": { "maxDuration": 60 },
    "api/shift-remind.ts": { "maxDuration": 60 }
  }
}
```

- [ ] **Step 2: コミット**

```bash
git add vercel.json
git commit -m "chore: register shift-remind function in vercel.json"
```

---

## Task 9: Google Cloud Service Account 準備（ユーザー手作業）

> このタスクは Google Cloud Console 上での手作業。コード変更なし、コミットなし。

- [ ] **Step 1: Google Cloud プロジェクトを選択（なければ新規作成）**

https://console.cloud.google.com/ にログイン

- [ ] **Step 2: Google Sheets API を有効化**

"APIs & Services" > "Library" > "Google Sheets API" > "Enable"

- [ ] **Step 3: Service Account を作成**

"IAM & Admin" > "Service Accounts" > "Create Service Account"
- Name: `slack-mention-bot-shift`
- Role: 不要（Sheet 側で個別に共有するため）

- [ ] **Step 4: JSON キーをダウンロード**

作成した Service Account > "Keys" > "Add Key" > "Create new key" > "JSON"
→ ローカルに `shift-bot-sa.json` として保存

- [ ] **Step 5: シフト表シートに Service Account のメールアドレスを「閲覧者」権限で共有**

- シート: `https://docs.google.com/spreadsheets/d/11WXjkrEhdCT0wOZ7-KzYDt1lvuypDdLIV9vRu4jKk-U/edit`
- 右上「共有」→ Service Account のメールアドレス（`...@...iam.gserviceaccount.com`）を追加
- 権限: 閲覧者

---

## Task 10: Vercel 環境変数を登録（ユーザー手作業）

> プロジェクト規約どおり、すべて `printf` を使う（`echo` は改行が混入するため禁止）。

- [ ] **Step 1: `SHIFT_REMIND_EMOJI`**

```bash
printf '%s' 'shift_matte' | vercel env add SHIFT_REMIND_EMOJI production
```

- [ ] **Step 2: `SHIFT_DONE_EMOJI`**

```bash
printf '%s' 'shift_done' | vercel env add SHIFT_DONE_EMOJI production
```

- [ ] **Step 3: `SHIFT_SHEET_ID`**

```bash
printf '%s' '11WXjkrEhdCT0wOZ7-KzYDt1lvuypDdLIV9vRu4jKk-U' | vercel env add SHIFT_SHEET_ID production
```

- [ ] **Step 4: `SHIFT_LOOKBACK_DAYS`**

```bash
printf '%s' '14' | vercel env add SHIFT_LOOKBACK_DAYS production
```

- [ ] **Step 5: `SHIFT_MEMBER_MAP`**

実際のシート列名と Slack user_id の対応を JSON で用意。例：

```bash
printf '%s' '{"U0AJVQWFRGW":"成田(ミカタ)","U01234567":"伊澤","U76543210":"若林(ケンプリ)"}' \
  | vercel env add SHIFT_MEMBER_MAP production
```

> user_id はシート列名すべての行について記入が必要。Slack の管理画面 (Admin > Members) で user_id を確認。シート列ヘッダ文字列は完全一致（括弧・全角文字含む）で入れる。

- [ ] **Step 6: `GOOGLE_SERVICE_ACCOUNT_JSON`**

Task 9 でダウンロードした `shift-bot-sa.json` を1行化して投入：

```bash
printf '%s' "$(jq -c . < ./shift-bot-sa.json)" | vercel env add GOOGLE_SERVICE_ACCOUNT_JSON production
```

- [ ] **Step 7: 登録確認**

```bash
vercel env ls production | grep -E 'SHIFT_|GOOGLE_SERVICE'
```

Expected: 6つの変数が `Production` で表示されること

---

## Task 11: Slack カスタム絵文字を追加（ユーザー手作業）

- [ ] **Step 1: Slack ワークスペース管理画面へアクセス**

左上メニュー > "設定と管理" > "カスタム絵文字を管理"

- [ ] **Step 2: `:shift_matte:` を追加**

任意の画像でアップロード（例: ⏳ の絵）

- [ ] **Step 3: `:shift_done:` を追加**

任意の画像でアップロード（例: ☑ の絵）

---

## Task 12: デプロイ

**Files:** なし（CLI操作のみ）

- [ ] **Step 1: 型チェックが通ることを最終確認**

Run: `npx tsc --noEmit`
Expected: エラーゼロ

- [ ] **Step 2: 本番デプロイ**

Run: `vercel --prod`
Expected: `Production: https://slack-mention-bot-sepia.vercel.app` が表示

- [ ] **Step 3: 空打ちで 200 が返ることを確認（リアクション付きメッセージがなくても OK が返る）**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://slack-mention-bot-sepia.vercel.app/api/shift-remind | head -c 500
```

Expected: `{"ok":true,"processed":...,"results":[...]}`

> もし 500 が返る場合は `vercel logs` で原因を確認し、環境変数を見直す。

---

## Task 13: cron-job.org に朝9:00 JST のジョブを追加（ユーザー手作業）

- [ ] **Step 1: https://cron-job.org/ にログイン**

- [ ] **Step 2: 新規ジョブ作成**

- Title: `slack-mention-bot shift-remind`
- URL: `https://slack-mention-bot-sepia.vercel.app/api/shift-remind`
- Schedule: 毎日 `0:00 UTC`（=`9:00 JST`）
- Headers: `Authorization: Bearer <CRON_SECRET の値>`
- Timeout: 60秒
- Timezone: UTC（cron-job.org の表記に合わせる）

- [ ] **Step 3: 手動トリガーで1度叩いてステータス 200 を確認**

ダッシュボードの "Run now" ボタンを押して、ヒストリが 200 で記録されることを確認。

---

## Task 14: 本番で手動検証（エンドツーエンド）

**Files:** なし（Slack 側の操作のみ）

- [ ] **Step 1: テスト環境のセットアップ**

- テスト用 Slack チャンネル (既存 `CHANNEL_IDS` に含まれる channel) を1つ選ぶ
- シート `11WXjkrEhdCT0wOZ7-KzYDt1lvuypDdLIV9vRu4jKk-U` の自分の列で、**前日 `×` / 今日 `O`** に設定（もし違う状態なら一時的に変更）
- `SHIFT_MEMBER_MAP` に自分の user_id と列名の対応が入っていることを再確認

- [ ] **Step 2: テスト用メンション投稿**

テストチャンネルに以下を投稿：
```
<@自分のID> テスト: お休み明け対応お願いします
```
そのメッセージに `:shift_matte:` リアクションを付与。

- [ ] **Step 3: エンドポイントを手動で叩く**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://slack-mention-bot-sepia.vercel.app/api/shift-remind
```

Expected: 該当メッセージが `status:"reminded:1"` で含まれる。

- [ ] **Step 4: Slack 上で確認**

- スレッドに `おはようございます！お休み中に確認依頼が届いています。ご対応お願いします 🙏` と自分宛メンション付きリプライが届いている
- 親メッセージに `:shift_done:` リアクションが追加されている

- [ ] **Step 5: 冪等性確認**

もう一度 curl を叩く → 該当メッセージは `status:"done-already"` になる（スレッドへの2度送信なし）。

- [ ] **Step 6: `not-returning-today` 確認**

シートの自分の「今日」を `O` → `×` に戻す（または別の非復帰パターンにする）。新しい `:shift_matte:` をつけた別メッセージを用意して再実行 → `status:"not-returning-today"`。

- [ ] **Step 7: テストデータを片付ける**

- シートを元の状態に戻す
- テストメッセージは残しておいてOK（`:shift_done:` がついているので再発火しない）

---

## Task 15: 関係者へ連携

- [ ] **Step 1: 堀江さん・成田さんにローンチ連絡**

Slack で一言：
```
お休み明けリマインド、本番に出しました🎉
使い方: メンション付きメッセージに :shift_matte: を付けると、
対象者の休み明け朝9:00にスレッドへ自動リマインドが届きます。
```

- [ ] **Step 2: README／CLAUDE.md に運用メモを追記（任意）**

`CLAUDE.md` の「現在の環境変数」セクションに shift 関連 env を追記してもよい（別PRで OK）。

---

## Self-Review Notes（計画作成後の確認）

- Spec coverage: §2 スコープ ／ §4 アーキ ／ §5 データフロー ／ §6 env ／ §7 エラー処理 ／ §9 テスト ／ §10 デプロイ — いずれもタスクに対応あり（§5.2 Sheets 読み取り → T5、§5.3 復帰判定 → T6、§7 エラー → T7、§10 デプロイ → T9-13、§9 検証 → T14）
- プレースホルダ: `// TODO: implementation will be added ...` は T2 → T7 で削除される設計。他に TBD／TODO なし
- 型整合: `SheetGrid` / `SheetsClient` / `MemberMap` / `ReturnVerdict` はすべて T2-6 で定義された型を T7 で一貫利用
- スコープ: 1つの機能（shift-remind）に絞り込み済み
