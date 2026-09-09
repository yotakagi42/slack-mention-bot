import type { VercelRequest, VercelResponse } from "@vercel/node";
import { WebClient } from "@slack/web-api";

export const config = { maxDuration: 60 };

const {
  SLACK_BOT_TOKEN = "",
  CHANNEL_IDS = "",
  CHASE_AUTO_CHANNELS = "",
  TRIGGER_EMOJI = "mega",
  CONFIRM_EMOJI = "white_check_mark",
  DONE_EMOJI = "done",
  BOT_EXCLUDE_USERS = "",
  BOT_EXCLUDE_GROUPS = "",
  CRON_SECRET = "",
  ADMIN_USER_ID = "",
} = process.env;

// CHANNEL_IDS は shift-remind.ts も必須で使う共有変数なので、空=自動検出という意味変更はしない。
// 自動検出は専用フラグで明示的にオプトインさせ、デフォルトは常に旧来の CHANNEL_IDS 指定動作にする。
const isAutoChannelMode = CHASE_AUTO_CHANNELS === "1" || CHASE_AUTO_CHANNELS === "true";

const channelIds = CHANNEL_IDS.split(",").map((s) => s.trim()).filter(Boolean);

const excludeGroupIds = BOT_EXCLUDE_GROUPS.split(",").map((s) => s.trim()).filter(Boolean);

const excludeUsers = new Set(
  BOT_EXCLUDE_USERS.split(",").map((s) => s.trim()).filter(Boolean),
);

// 直列走査が時間切れした時に毎回同じ後半チャンネルだけ飢餓になるのを防ぐための予算とローテーション。
const TIME_BUDGET_MS = 45 * 1000;
const MESSAGE_LOOKBACK_MS = 10 * 24 * 60 * 60 * 1000;
const MAX_CHANNEL_LIST_PAGES = 20;

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
    return `⚠️ 【3日目〜4日目】まだ未確認です。確認をお願いします！${progress}`;
  return `🚨 【5日目以上】長期未確認です。至急ご対応をお願いします。${progress}`;
}

async function notifyAdmin(slack: WebClient, text: string): Promise<void> {
  if (!ADMIN_USER_ID) return;
  await slack.chat
    .postMessage({ channel: ADMIN_USER_ID, text })
    .catch((e) => console.error(`chase-bot: admin DM failed — ${(e as Error).message}`));
}

// 走査対象は Bot が参加しているチャンネル全部（CHASE_AUTO_CHANNELS が有効な場合のみ）。
// それ以外は CHANNEL_IDS を使う。自動検出モードで CHANNEL_IDS にも値がある場合は自動検出を優先する。
async function resolveChannelIds(
  slack: WebClient,
): Promise<{ ids: string[]; error: string | null; usedAutoDetect: boolean; partial: boolean }> {
  if (!isAutoChannelMode) {
    return { ids: channelIds, error: null, usedAutoDetect: false, partial: false };
  }

  const ids: string[] = [];
  let cursor: string | undefined;
  let partial = false;
  for (let page = 0; page < MAX_CHANNEL_LIST_PAGES; page++) {
    try {
      const res = await slack.users.conversations({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const c of res.channels ?? []) if (c.id) ids.push(c.id);
      const nextCursor = res.response_metadata?.next_cursor || undefined;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    } catch (e) {
      if (ids.length === 0) {
        return {
          ids: [],
          error: `参加チャンネルの取得に失敗しました: ${(e as Error).message}。Slack App に channels:read / groups:read / channels:history / groups:history を追加して再インストールしてください。`,
          usedAutoDetect: true,
          partial: false,
        };
      }
      partial = true;
      break;
    }
  }
  return { ids, error: null, usedAutoDetect: true, partial };
}

// 除外グループのメンバーは1回の実行中に変わらないので最初に1度だけ引く。
// usergroups.users.list は毎分20回の制限があり、メッセージごとに呼ぶと走査数が増えた時に詰まる。
async function fetchExcludeGroupMembers(slack: WebClient): Promise<Set<string>> {
  const members = new Set<string>();
  for (const gid of excludeGroupIds) {
    const res = await slack.usergroups.users.list({ usergroup: gid });
    for (const u of res.users ?? []) members.add(u);
  }
  return members;
}

async function processMessage(
  slack: WebClient,
  channelId: string,
  msg: SlackMessage,
  botUserId: string | null,
  botBotId: string | null,
  excludeGroupMembers: Set<string>,
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

  const targetMembers = [...members].filter(
    (u) => u !== msg.user && !excludeUsers.has(u) && !excludeGroupMembers.has(u),
  );
  const notReacted = targetMembers.filter((u) => !confirmedUsers.has(u));
  const confirmed = targetMembers.length - notReacted.length;

  // Empty target set (poster-only group, all members excluded, etc.) — bail without
  // marking done so the misleading green tick isn't applied without anyone being chased.
  if (targetMembers.length === 0) return "no-targets";

  // All confirmed → add done emoji (regardless of 48h)
  if (notReacted.length === 0) {
    try {
      await slack.reactions.add({
        channel: channelId,
        timestamp: msg.ts,
        name: DONE_EMOJI,
      });
    } catch (e: any) {
      if (e?.data?.error !== "already_reacted") throw e;
    }
    return "marked-done";
  }

  // Chase messages only after 48h
  const hoursSinceMessage = getElapsedHours(msg.ts);
  if (hoursSinceMessage < 48) return "too-early";

  // Get thread replies to check chase interval
  const replies = await slack.conversations.replies({
    channel: channelId,
    ts: msg.ts,
    limit: 100,
  });
  const botReplies = (replies.messages ?? []).filter((r) => {
    if (r.ts === msg.ts) return false;
    if (botUserId && r.user === botUserId) return true;
    if (botBotId && r.bot_id === botBotId) return true;
    return false;
  });

  // Check chase interval against last bot reply
  if (botReplies.length > 0) {
    const intervalH = getChaseInterval(hoursSinceMessage);
    const lastBotReply = botReplies[botReplies.length - 1];
    const hoursSinceLastChase = getElapsedHours(lastBotReply.ts!);
    if (hoursSinceLastChase < intervalH) return "interval-skip";
  }

  const mentions = notReacted.map((u) => `<@${u}>`).join(" ");
  const text = getChaseText(hoursSinceMessage, confirmed, targetMembers.length);
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

  const missingEnv: string[] = [];
  if (!SLACK_BOT_TOKEN) missingEnv.push("SLACK_BOT_TOKEN");
  if (!isAutoChannelMode && !CHANNEL_IDS) missingEnv.push("CHANNEL_IDS");
  if (missingEnv.length > 0) {
    console.error(`chase-bot: missing env — ${missingEnv.join(", ")}`);
    return res.status(500).json({ error: "missing env", need: missingEnv });
  }

  // 429 リトライのデフォルト（最大約30分）と無制限タイムアウトは maxDuration: 60s と両立しないため明示指定する。
  const slack = new WebClient(SLACK_BOT_TOKEN, {
    retryConfig: { retries: 2, factor: 1.5, maxTimeout: 3000 },
    timeout: 10000,
  });

  let botUserId: string | null = null;
  let botBotId: string | null = null;
  try {
    const auth = await slack.auth.test();
    botUserId = auth.user_id ?? null;
    botBotId = auth.bot_id ?? null;
  } catch (e) {
    const msg = `chase-bot: auth.test failed — ${(e as Error).message}. Skipping run to avoid duplicate chase messages.`;
    console.error(msg);
    await notifyAdmin(slack, `⚠️ ${msg}`);
    return res.status(200).json({ ok: false, error: msg });
  }
  if (!botUserId && !botBotId) {
    const msg = `chase-bot: auth.test returned no bot identity. Skipping run.`;
    console.error(msg);
    await notifyAdmin(slack, `⚠️ ${msg}`);
    return res.status(200).json({ ok: false, error: msg });
  }

  const {
    ids: resolvedChannelIds,
    error: channelError,
    usedAutoDetect,
    partial: channelListPartial,
  } = await resolveChannelIds(slack);
  if (channelError) {
    console.error(`chase-bot: ${channelError}`);
    await notifyAdmin(slack, `⚠️ chase-bot: ${channelError}`);
    return res.status(200).json({ ok: false, error: channelError });
  }
  const ignoredChannelIds = usedAutoDetect && channelIds.length > 0;
  if (resolvedChannelIds.length === 0) {
    // 4時間おきに走るcronなので、DMすると恒久的に鳴り続ける。ログだけに留める。
    console.warn("chase-bot: 走査対象のチャンネルがありません。Botをチャンネルに招待してください。");
    return res.status(200).json({ ok: false, error: "no target channels" });
  }

  let excludeGroupMembers: Set<string>;
  try {
    excludeGroupMembers = await fetchExcludeGroupMembers(slack);
  } catch (e) {
    // 除外リストなしで走らせるとCEOグループ等に催促が飛びかねないため、失敗時は走査自体を中止する。
    const msg = `chase-bot: 除外グループの取得に失敗しました — ${(e as Error).message}。BOT_EXCLUDE_GROUPS を確認してください。走査を中止します。`;
    console.error(msg);
    await notifyAdmin(slack, `⚠️ ${msg}`);
    return res.status(200).json({ ok: false, error: msg });
  }

  // 開始インデックスを4時間の実行周期でずらし、時間切れによる後半チャンネルの飢餓を防ぐ。
  const rotationOffset = Math.floor(Date.now() / (4 * 3600 * 1000)) % resolvedChannelIds.length;
  const orderedChannelIds = [
    ...resolvedChannelIds.slice(rotationOffset),
    ...resolvedChannelIds.slice(0, rotationOffset),
  ];

  const startedAt = Date.now();
  const allResults: { channel: string; ts: string; status: string; error?: string }[] = [];
  const historyErrors: string[] = [];
  let truncated = false;
  let processedChannelCount = 0;

  for (const channelId of orderedChannelIds) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      truncated = true;
      break;
    }
    processedChannelCount++;

    let history;
    try {
      history = await slack.conversations.history({
        channel: channelId,
        oldest: String(Math.floor((Date.now() - MESSAGE_LOOKBACK_MS) / 1000)),
        limit: 200,
      });
    } catch (e) {
      historyErrors.push(`history(${channelId}): ${(e as Error).message}`);
      continue;
    }

    for (const m of history.messages ?? []) {
      if (!m.ts || !m.user) continue;
      try {
        const status = await processMessage(slack, channelId, m as SlackMessage, botUserId, botBotId, excludeGroupMembers);
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
  const errorSummaryLines = [
    ...historyErrors.map((e) => `• ${e}`),
    ...errors.map((e) => `• ch:\`${e.channel}\` ts:\`${e.ts}\` — ${e.error}`),
  ];
  if (errorSummaryLines.length > 0) {
    console.error(`chase-bot: ${errorSummaryLines.length}件のエラー\n${errorSummaryLines.join("\n")}`);
    // chat.postMessage は約4000文字で失敗するため、先頭20件に絞って残数を付記する。
    const shown = errorSummaryLines.slice(0, 20);
    const omitted = errorSummaryLines.length - shown.length;
    const summary = shown.join("\n") + (omitted > 0 ? `\n…他${omitted}件` : "");
    await notifyAdmin(slack, `⚠️ chase-bot エラー (${errorSummaryLines.length}件)\n${summary}`);
  }

  return res.status(200).json({
    ok: true,
    processed: allResults.length,
    channelsScanned: processedChannelCount,
    channelsTotal: orderedChannelIds.length,
    truncated,
    ...(truncated ? { channelsRemaining: orderedChannelIds.length - processedChannelCount } : {}),
    ...(usedAutoDetect ? { usedAutoDetect: true } : {}),
    ...(ignoredChannelIds ? { note: "CHASE_AUTO_CHANNELS is enabled — CHANNEL_IDS was ignored" } : {}),
    ...(channelListPartial ? { partial: true } : {}),
    results: allResults,
  });
}
