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
