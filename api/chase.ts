import { WebClient } from "@slack/web-api";

export const config = { maxDuration: 60 };

const {
  SLACK_BOT_TOKEN = "",
  CHANNEL_ID = "",
  TRIGGER_EMOJI = "mega",
  CONFIRM_EMOJI = "white_check_mark",
  DONE_EMOJI = "done",
  BOT_EXCLUDE_USERS = "",
  CRON_SECRET = "",
} = process.env;

const excludeUsers = new Set(
  BOT_EXCLUDE_USERS.split(",").map((s) => s.trim()).filter(Boolean),
);

const slack = new WebClient(SLACK_BOT_TOKEN);

function extractUsergroupIds(text: string): string[] {
  const ids = new Set<string>();
  const re = /<!subteam\^(S[A-Z0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

async function processMessage(msg: {
  ts: string;
  user: string;
  text: string;
  reactions?: { name: string; users: string[] }[];
}): Promise<string> {
  const reactions = msg.reactions ?? [];
  const hasTrigger = reactions.some(
    (r) => r.name === TRIGGER_EMOJI && r.users.includes(msg.user),
  );
  const hasDone = reactions.some((r) => r.name === DONE_EMOJI);
  if (!hasTrigger || hasDone) return "skip";

  const groupIds = extractUsergroupIds(msg.text ?? "");
  if (groupIds.length === 0) return "no-usergroup";

  // Fresh reactions (conversations.history may be stale)
  const fresh = await slack.reactions.get({
    channel: CHANNEL_ID,
    timestamp: msg.ts,
    full: true,
  });
  const freshReactions =
    (fresh.message as { reactions?: { name: string; users: string[] }[] })
      ?.reactions ?? [];
  if (freshReactions.some((r) => r.name === DONE_EMOJI)) return "done-already";

  const confirmedUsers = new Set(
    freshReactions
      .filter((r) => r.name === CONFIRM_EMOJI)
      .flatMap((r) => r.users),
  );

  // Merge all usergroup members
  const members = new Set<string>();
  for (const gid of groupIds) {
    const res = await slack.usergroups.users.list({ usergroup: gid });
    for (const u of res.users ?? []) members.add(u);
  }

  const notReacted = [...members].filter(
    (u) => u !== msg.user && !confirmedUsers.has(u) && !excludeUsers.has(u),
  );

  if (notReacted.length === 0) {
    await slack.reactions.add({
      channel: CHANNEL_ID,
      timestamp: msg.ts,
      name: DONE_EMOJI,
    });
    return "marked-done";
  }

  const mentions = notReacted.map((u) => `<@${u}>`).join(" ");
  await slack.chat.postMessage({
    channel: CHANNEL_ID,
    thread_ts: msg.ts,
    text: `📌 まだ確認リアクション（:${CONFIRM_EMOJI}:）がついていません。確認お願いします！\n${mentions}`,
  });
  return `chased:${notReacted.length}`;
}

export default async function handler(req: Request): Promise<Response> {
  // Cron auth: Vercel sends Authorization: Bearer $CRON_SECRET
  if (CRON_SECRET) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  if (!SLACK_BOT_TOKEN || !CHANNEL_ID) {
    return Response.json({ error: "missing env" }, { status: 500 });
  }

  const history = await slack.conversations.history({
    channel: CHANNEL_ID,
    limit: 20,
  });

  const results: { ts: string; status: string; error?: string }[] = [];
  for (const m of history.messages ?? []) {
    if (!m.ts || !m.user) continue;
    try {
      const status = await processMessage(
        m as Parameters<typeof processMessage>[0],
      );
      results.push({ ts: m.ts, status });
    } catch (e) {
      results.push({
        ts: m.ts,
        status: "error",
        error: (e as Error).message,
      });
    }
  }

  return Response.json({ ok: true, processed: results.length, results });
}
