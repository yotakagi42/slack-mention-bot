/**
 * One-off helper: list all active (non-bot, non-deleted) members of the workspace.
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... npx tsx scripts/list-users.ts
 *
 * Or, if you already have an .env.production locally:
 *   export $(grep -v '^#' .env.production | xargs) && npx tsx scripts/list-users.ts
 *
 * Outputs a sorted JSON array of { id, display_name, real_name } — paste the
 * matching ids into SHIFT_MEMBER_MAP keyed against the sheet column names.
 */
import { WebClient } from "@slack/web-api";

type Row = { id: string; display_name: string; real_name: string };

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error("SLACK_BOT_TOKEN is not set");
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
