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

function parseMemberMap(): { map: MemberMap; error: string | null } {
  try {
    const parsed = JSON.parse(SHIFT_MEMBER_MAP);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { map: {}, error: "SHIFT_MEMBER_MAP must be a JSON object" };
    }
    if (Object.keys(parsed).length === 0) {
      return { map: {}, error: "SHIFT_MEMBER_MAP is empty — no users will receive reminders" };
    }
    return { map: parsed as MemberMap, error: null };
  } catch (e) {
    return { map: {}, error: `SHIFT_MEMBER_MAP parse failed: ${(e as Error).message}` };
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
    const msg = String(e?.response?.data?.error?.message ?? e?.message ?? "");
    if (status === 400 && msg.includes("Unable to parse range")) return null;
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

type ReturnVerdict = "yes" | "no" | "column-not-found" | "row-not-found";

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
  if (todayRow === -1 || yesterdayRow === -1) return "row-not-found";

  const todayStatus = (todayGrid[todayRow]?.[todayCol] ?? "").toString().trim();
  const yesterdayStatus = (yesterdayGrid[yesterdayRow]?.[yesterdayCol] ?? "").toString().trim();

  const isOffYesterday = yesterdayStatus === "×";
  const isOnToday = todayStatus === "O" || todayStatus === "";
  return isOffYesterday && isOnToday ? "yes" : "no";
}

async function processTriggerMessage(opts: {
  slack: WebClient;
  channelId: string;
  triggerMsg: SlackMessage;
  threadRootTs: string;
  isThreadReply: boolean;
  memberMap: MemberMap;
  todayGrid: SheetGrid;
  yesterdayGrid: SheetGrid;
  todayMD: string;
  yesterdayMD: string;
  botUserId: string | null;
  botBotId: string | null;
  results: { channel: string; ts: string; status: string; error?: string }[];
  errors: string[];
}): Promise<void> {
  const {
    slack, channelId, triggerMsg, threadRootTs, isThreadReply,
    memberMap, todayGrid, yesterdayGrid, todayMD, yesterdayMD,
    botUserId, botBotId, results, errors,
  } = opts;

  const suffix = isThreadReply ? "(thread)" : "";

  const reactions = triggerMsg.reactions ?? [];
  const hasTrigger = reactions.some((r) => r.name === SHIFT_REMIND_EMOJI);
  const hasDone = reactions.some((r) => r.name === SHIFT_DONE_EMOJI);
  if (!hasTrigger) return;
  if (hasDone) {
    results.push({ channel: channelId, ts: triggerMsg.ts, status: `done-already${suffix}` });
    return;
  }
  const mentions = extractUserMentions(triggerMsg.text ?? "");
  if (mentions.length === 0) {
    results.push({ channel: channelId, ts: triggerMsg.ts, status: `no-mention${suffix}` });
    return;
  }

  let alreadyReminded = new Set<string>();
  try {
    const replies = await slack.conversations.replies({
      channel: channelId,
      ts: threadRootTs,
      limit: 100,
    });
    const botReplies = (replies.messages ?? []).filter((r) => {
      if (r.ts === threadRootTs) return false;
      if (botUserId && r.user === botUserId) return true;
      if (botBotId && r.bot_id === botBotId) return true;
      return false;
    });
    for (const reply of botReplies) {
      for (const uid of extractUserMentions(reply.text ?? "")) {
        alreadyReminded.add(uid);
      }
    }
  } catch (e) {
    errors.push(`replies(${channelId}, ${threadRootTs}): ${(e as Error).message}`);
  }

  try {
    const returningToday: string[] = [];
    const unknownColumns: string[] = [];
    const missingRows: string[] = [];
    for (const uid of mentions) {
      if (alreadyReminded.has(uid)) continue;
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
      if (verdict === "row-not-found") missingRows.push(`${columnName}(${todayMD} or ${yesterdayMD})`);
    }

    if (unknownColumns.length > 0) {
      errors.push(`column-not-found: ${unknownColumns.join(", ")}`);
    }
    if (missingRows.length > 0) {
      errors.push(`row-not-found: ${missingRows.join(", ")}`);
    }

    if (returningToday.length === 0) {
      results.push({ channel: channelId, ts: triggerMsg.ts, status: `not-returning-today${suffix}` });
      return;
    }

    const mentionText = returningToday.map((u) => `<@${u}>`).join(" ");
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadRootTs,
      text: `${mentionText} おはようございます！\nお休み中に確認依頼が届いています。ご対応お願いします 🙏`,
    });
    // After posting the reminder, augment alreadyReminded with this run's set.
    for (const uid of returningToday) alreadyReminded.add(uid);
    const mappedMentions = mentions.filter((u) => memberMap[u]);
    const fullyDrained = mappedMentions.every((u) => alreadyReminded.has(u));
    if (fullyDrained) {
      try {
        await slack.reactions.add({
          channel: channelId,
          timestamp: triggerMsg.ts,
          name: SHIFT_DONE_EMOJI,
        });
      } catch (e: any) {
        if (e?.data?.error !== "already_reacted") {
          errors.push(`reactions.add(${triggerMsg.ts}): ${e.message}`);
        }
      }
    }
    results.push({
      channel: channelId,
      ts: triggerMsg.ts,
      status: `reminded:${returningToday.length}${suffix}`,
    });
  } catch (e) {
    results.push({
      channel: channelId,
      ts: triggerMsg.ts,
      status: "error",
      error: (e as Error).message,
    });
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

  const slack = new WebClient(SLACK_BOT_TOKEN);

  let botUserId: string | null = null;
  let botBotId: string | null = null;
  try {
    const auth = await slack.auth.test();
    botUserId = auth.user_id ?? null;
    botBotId = auth.bot_id ?? null;
  } catch (e) {
    const msg = `shift-remind: auth.test failed — ${(e as Error).message}`;
    if (ADMIN_USER_ID) {
      await slack.chat.postMessage({ channel: ADMIN_USER_ID, text: `⚠️ ${msg}` }).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: msg });
  }
  if (!botUserId && !botBotId) {
    const msg = `shift-remind: auth.test returned no bot identity. Skipping run.`;
    if (ADMIN_USER_ID) {
      await slack.chat.postMessage({ channel: ADMIN_USER_ID, text: `⚠️ ${msg}` }).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: msg });
  }

  const { map: memberMap, error: memberMapError } = parseMemberMap();
  const errors: string[] = [];
  if (memberMapError) {
    errors.push(memberMapError);
  }

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

  if (!todayGrid) {
    // Current-month tab missing — try previous-month tab as a graceful fallback
    try {
      const fallback = await fetchSheetTab(sheets, yesterdayTabName);
      if (fallback) {
        const warn = `shift-remind: today tab ${todayTabName} missing, using fallback ${yesterdayTabName}`;
        if (ADMIN_USER_ID) {
          await slack.chat.postMessage({ channel: ADMIN_USER_ID, text: `⚠️ ${warn}` }).catch(() => {});
        }
        todayGrid = fallback;
        yesterdayGrid = fallback;
      }
    } catch (e) {
      errors.push(`fallback fetch ${yesterdayTabName}: ${(e as Error).message}`);
    }
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

    for (const parentMsg of (history.messages ?? []) as SlackMessage[]) {
      if (!parentMsg.ts) continue;

      // Process top-level message
      await processTriggerMessage({
        slack, channelId,
        triggerMsg: parentMsg,
        threadRootTs: parentMsg.ts,
        isThreadReply: false,
        memberMap, todayGrid, yesterdayGrid, todayMD, yesterdayMD,
        botUserId, botBotId, results, errors,
      });

      // Process thread replies if any
      const replyCount = (parentMsg as any).reply_count ?? 0;
      if (replyCount > 0) {
        let repliesRes;
        try {
          repliesRes = await slack.conversations.replies({
            channel: channelId,
            ts: parentMsg.ts,
            limit: 100,
          });
        } catch (e) {
          errors.push(`replies-scan(${channelId}, ${parentMsg.ts}): ${(e as Error).message}`);
          continue;
        }
        const allReplies = (repliesRes.messages ?? []) as SlackMessage[];
        // Skip the parent itself (always at index 0 when ts matches the root)
        for (const reply of allReplies) {
          if (!reply.ts || reply.ts === parentMsg.ts) continue;
          await processTriggerMessage({
            slack, channelId,
            triggerMsg: reply,
            threadRootTs: parentMsg.ts,
            isThreadReply: true,
            memberMap, todayGrid, yesterdayGrid, todayMD, yesterdayMD,
            botUserId, botBotId, results, errors,
          });
        }
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
