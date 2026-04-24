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

function extractUserMentions(text: string): string[] {
  const ids = new Set<string>();
  const re = /<@(U[A-Z0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

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
    if (status === 400) return null;
    throw e;
  }
}

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
          if (!columnName) continue;
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
}
