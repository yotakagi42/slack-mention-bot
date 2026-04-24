/**
 * One-off helper: list all active (non-bot, non-deleted) members of the workspace.
 *
 * Usage:
 *   npx tsx scripts/list-users.ts              # reads .env.production automatically
 *   SLACK_BOT_TOKEN=xoxb-... npx tsx scripts/list-users.ts
 *
 * Outputs a sorted JSON array of { id, display_name, real_name } — paste the
 * matching ids into SHIFT_MEMBER_MAP keyed against the sheet column names.
 */
import { readFileSync } from "node:fs";
import { WebClient } from "@slack/web-api";

type Row = { id: string; display_name: string; real_name: string };

function loadDotenvToken(): string | undefined {
  try {
    const raw = readFileSync(".env.production", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key !== "SLACK_BOT_TOKEN") continue;
      let val = trimmed.slice(eq + 1).trim();
      // strip surrounding single or double quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
  } catch {
    // file missing — fall through
  }
  return undefined;
}

const token = process.env.SLACK_BOT_TOKEN || loadDotenvToken();
if (!token) {
  console.error(
    "SLACK_BOT_TOKEN is not set. Either export it, or place it in .env.production.",
  );
  process.exit(1);
}

const slack = new WebClient(token);
const users: Row[] = [];
let cursor: string | undefined;

while (true) {
  const res: any = await slack.users.list({ cursor, limit: 200 });
  for (const m of res.members ?? []) {
    if (m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
    users.push({
      id: m.id ?? "",
      display_name: m.profile?.display_name || m.profile?.real_name || "",
      real_name: m.real_name || "",
    });
  }
  cursor = res.response_metadata?.next_cursor;
  if (!cursor) break;
}

users.sort((a, b) =>
  (a.display_name || a.real_name).localeCompare(
    b.display_name || b.real_name,
    "ja",
  ),
);

console.log(JSON.stringify(users, null, 2));
console.error(`\n${users.length} active users found.`);
