import { MAX_HASH_HISTORY, STATE_KEY } from "./constants";
import { notifyDiscord } from "./services/discord";
import { ImapClient } from "./services/imapClient";
import type { Env, MailSummary, WorkerState } from "./types";

export async function runOnce(env: Env, now: Date) {
  if (!env.IMAP_HOST || !env.IMAP_PORT || !env.IMAP_USERNAME || !env.IMAP_PASSWORD) {
    throw new Error("IMAP 接続設定が不足しています。wrangler.toml と secrets を確認してください。");
  }
  if (!env.DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL が設定されていません。wrangler secret put DISCORD_WEBHOOK_URL を実行してください。");
  }

  const state = await env.EMAIL_STATE.get<WorkerState>(STATE_KEY, "json");
  const lastCheckTime = state?.lastCheck ? Date.parse(state.lastCheck) : 0;
  const seenHashes = new Set(state?.hashes ?? []);

  const imap = new ImapClient({
    host: env.IMAP_HOST,
    port: Number(env.IMAP_PORT || "993"),
    secure: normalizeSecure(env.IMAP_SECURE),
    username: env.IMAP_USERNAME,
    password: env.IMAP_PASSWORD,
  });

  const mailbox = env.IMAP_MAILBOX || "INBOX";
  const newMessages: MailSummary[] = [];

  try {
    await imap.connect();
    await imap.login();
    await imap.selectMailbox(mailbox);

    const uids = await imap.searchSince(new Date(lastCheckTime || 0));
    for (const uid of uids) {
      const summary = await imap.fetchSummary(uid);
      if (!summary) {
        continue;
      }
      if (summary.internalDate.getTime() <= lastCheckTime) {
        continue;
      }
      if (seenHashes.has(summary.hash)) {
        continue;
      }
      newMessages.push(summary);
    }
  } finally {
    await imap.close();
  }

  let notified = 0;
  const newlySeen: string[] = [];
  for (const message of newMessages) {
    try {
      await notifyDiscord(env.DISCORD_WEBHOOK_URL, message);
    } catch (err) {
      console.error("Discord 通知に失敗しました", err);
      throw err;
    }
    notified += 1;
    newlySeen.push(message.hash);
    seenHashes.add(message.hash);
  }

  const mergedHashes = Array.from(seenHashes);
  if (mergedHashes.length > MAX_HASH_HISTORY) {
    mergedHashes.splice(0, mergedHashes.length - MAX_HASH_HISTORY);
  }

  await env.EMAIL_STATE.put(
    STATE_KEY,
    JSON.stringify({
      lastCheck: now.toISOString(),
      hashes: mergedHashes,
    } satisfies WorkerState),
  );

  return {
    checked: newMessages.length,
    notified,
    timestamp: now.toISOString(),
  };
}

function normalizeSecure(value?: string): "on" | "starttls" | "off" {
  const normalized = (value || "on").toLowerCase();
  if (normalized === "starttls" || normalized === "off") {
    return normalized;
  }
  return "on";
}
