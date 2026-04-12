import type { VercelRequest, VercelResponse } from "@vercel/node";
import { WebClient } from "@slack/web-api";

export const config = { maxDuration: 60 };

const {
  SLACK_BOT_TOKEN = "",
  CHANNEL_IDS = "",
  TRIGGER_EMOJI = "mega",
  CONFIRM_EMOJI = "white_check_mark",
  DONE_EMOJI = "done",
  BOT_EXCLUDE_USERS = "",
  BOT_EXCLUDE_GROUPS = "",
  CRON_SECRET = "",
  ADMIN_USER_ID = "",
} = process.env;

const channelIds = CHANNEL_IDS.split(",").map((s) => s.trim()).filter(Boolean);

const excludeGroupIds = BOT_EXCLUDE_GROUPS.split(",").map((s) => s.trim()).filter(Boolean);

const excludeUsers = new Set(
  BOT_EXCLUDE_USERS.split(",").map((s) => s.trim()).filter(Boolean),
);

function extractUsergroupIds(text: string): string[] {
  const ids = new Set<string>();
  const re = /<!subteam\^(S[A-Z0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

type SlackReaction = { name: string; users: string[] };
type SlackMessage = {
  ts: string;
  user: string;
  text: string;
  reactions?: SlackReaction[];
};

function getElapsedHours(msgTs: string): number {
  return (Date.now() - parseFloat(msgTs) * 1000) / (1000 * 60 * 60);
}

function getChaseInterval(_elapsedH: number): number {
  return 4;
}

function getChaseText(elapsedH: number, confirmed: number, total: number): string {
  const progress = `（確認済み: ${confirmed}/${total}人）`;
  if (elapsedH < 72)
    return `📌 まだ確認リアクション（:${CONFIRM_EMOJI}:）がついていません。確認お願いします！${progress}`;
  if (elapsedH < 96)
    return `⚠️ 【3日目】まだ未確認です。確認をお願いします！${progress}`;
  return `🚨 【5日目以上】長期未確認です。至急ご対応をお願いします。${progress}`;
}

async function processMessage(
  slack: WebClient,
  channelId: string,
  msg: SlackMessage,
  botUserId: string | null,
): Promise<string> {
  const reactions = msg.reactions ?? [];
  const hasTrigger = reactions.some(
    (r) => r.name === TRIGGER_EMOJI && r.users.includes(msg.user),
  );
  const hasDone = reactions.some((r) => r.name === DONE_EMOJI);
  if (!hasTrigger || hasDone) return "skip";

  const groupIds = extractUsergroupIds(msg.text ?? "");
  if (groupIds.length === 0) return "no-usergroup";

  const fresh = await slack.reactions.get({
    channel: channelId,
    timestamp: msg.ts,
    full: true,
  });
  const freshReactions =
    (fresh.message as { reactions?: SlackReaction[] })?.reactions ?? [];
  if (freshReactions.some((r) => r.name === DONE_EMOJI)) return "done-already";

  // Check chase interval using thread replies
  const elapsedH = getElapsedHours(msg.ts);
  const intervalH = getChaseInterval(elapsedH);

  if (botUserId) {
    const replies = await slack.conversations.replies({
      channel: channelId,
      ts: msg.ts,
      limit: 100,
    });
    const botReplies = (replies.messages ?? [])
      .filter((r) => r.user === botUserId && r.ts !== msg.ts);
    if (botReplies.length > 0) {
      const lastBotReply = botReplies[botReplies.length - 1];
      const hoursSinceLastChase = getElapsedHours(lastBotReply.ts!);
      if (hoursSinceLastChase < intervalH) return "interval-skip";
    }
  }

  const confirmedUsers = new Set(
    freshReactions
      .filter((r) => r.name === CONFIRM_EMOJI)
      .flatMap((r) => r.users),
  );

  const members = new Set<string>();
  for (const gid of groupIds) {
    const res = await slack.usergroups.users.list({ usergroup: gid });
    for (const u of res.users ?? []) members.add(u);
  }

  const excludeGroupMembers = new Set<string>();
  for (const gid of excludeGroupIds) {
    const res = await slack.usergroups.users.list({ usergroup: gid });
    for (const u of res.users ?? []) excludeGroupMembers.add(u);
  }

  const targetMembers = [...members].filter(
    (u) => u !== msg.user && !excludeUsers.has(u) && !excludeGroupMembers.has(u),
  );
  const notReacted = targetMembers.filter((u) => !confirmedUsers.has(u));
  const confirmed = targetMembers.length - notReacted.length;

  if (notReacted.length === 0) {
    await slack.reactions.add({
      channel: channelId,
      timestamp: msg.ts,
      name: DONE_EMOJI,
    });
    return "marked-done";
  }

  const mentions = notReacted.map((u) => `<@${u}>`).join(" ");
  const text = getChaseText(elapsedH, confirmed, targetMembers.length);
  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: msg.ts,
    text: `${text}\n${mentions}`,
  });
  return `chased:${notReacted.length}`;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (CRON_SECRET) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).send("Unauthorized");
    }
  }

  if (!SLACK_BOT_TOKEN || channelIds.length === 0) {
    return res
      .status(500)
      .json({ error: "missing env", need: ["SLACK_BOT_TOKEN", "CHANNEL_IDS"] });
  }

  const slack = new WebClient(SLACK_BOT_TOKEN);

  let botUserId: string | null = null;
  try {
    const auth = await slack.auth.test();
    botUserId = auth.user_id ?? null;
  } catch { /* fallback: skip duplicate check */ }

  const allResults: { channel: string; ts: string; status: string; error?: string }[] = [];

  for (const channelId of channelIds) {
    const history = await slack.conversations.history({
      channel: channelId,
      limit: 50,
    });

    for (const m of history.messages ?? []) {
      if (!m.ts || !m.user) continue;
      try {
        const status = await processMessage(slack, channelId, m as SlackMessage, botUserId);
        allResults.push({ channel: channelId, ts: m.ts, status });
      } catch (e) {
        allResults.push({
          channel: channelId,
          ts: m.ts,
          status: "error",
          error: (e as Error).message,
        });
      }
    }
  }

  const errors = allResults.filter((r) => r.status === "error");
  if (errors.length > 0 && ADMIN_USER_ID) {
    const summary = errors
      .map((e) => `• ch:\`${e.channel}\` ts:\`${e.ts}\` — ${e.error}`)
      .join("\n");
    await slack.chat.postMessage({
      channel: ADMIN_USER_ID,
      text: `⚠️ chase-bot エラー (${errors.length}件)\n${summary}`,
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true, processed: allResults.length, results: allResults });
}
