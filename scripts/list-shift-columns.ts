/**
 * One-off helper: dump all column headers from the current month's shift tab.
 *
 * Usage:
 *   npx tsx scripts/list-shift-columns.ts
 */
import { readFileSync } from "node:fs";
import { google } from "googleapis";

function loadDotenv(key: string): string | undefined {
  try {
    const raw = readFileSync(".env.production", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() !== key) continue;
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
  } catch {}
  return undefined;
}

const sheetId = process.env.SHIFT_SHEET_ID || loadDotenv("SHIFT_SHEET_ID");
const credsRaw =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON || loadDotenv("GOOGLE_SERVICE_ACCOUNT_JSON");
if (!sheetId) throw new Error("SHIFT_SHEET_ID missing");
if (!credsRaw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing");

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(credsRaw),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
const yy = String(now.getUTCFullYear()).slice(-2);
const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
const tabName = `${yy}/${mm}`;

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: sheetId,
  range: `'${tabName}'!A1:ZZ1`,
});
const headers = (res.data.values?.[0] ?? []) as string[];

console.log(`Tab: ${tabName}`);
console.log(`Total columns: ${headers.length}`);
console.log("---");
headers.forEach((h, i) => {
  if (!h) return;
  const colLetter = i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + (i - 26))}`;
  console.log(`${colLetter} (idx ${i}): ${h}`);
});
