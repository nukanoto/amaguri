import { MAX_HASH_HISTORY } from "./constants";
import { notifyDiscord } from "./services/discord";
import { EmailStateStore } from "./services/emailStateStore";
import { ImapClient } from "./services/imapClient";
import type { Env, MailSummary } from "./types";

export async function runOnce(env: Env, now: Date) {
  if (!env.IMAP_HOST || !env.IMAP_USERNAME || !env.IMAP_PASSWORD) {
    throw new Error(
      "IMAP 接続設定が不足しています。環境変数 (wrangler secret) を確認してください。",
    );
  }
  if (!env.DISCORD_WEBHOOK_URL) {
    throw new Error(
      "DISCORD_WEBHOOK_URL が設定されていません。環境変数 (wrangler secret) を確認してください。",
    );
  }

  const store = new EmailStateStore(env.EMAIL_STATE);
  const state = await store.load();
  const lastCheckTime = state?.lastCheck ? Date.parse(state.lastCheck) : 0;
  const seenHashes = new Set(state?.hashes ?? []);

  const imap = new ImapClient({
    host: env.IMAP_HOST,
    port: resolveImapPort(env.IMAP_PORT),
    secure: normalizeSecure(env.IMAP_SECURE),
    username: env.IMAP_USERNAME,
    password: env.IMAP_PASSWORD,
  });

  const mailbox = env.IMAP_MAILBOX?.trim() || "INBOX";
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

  await store.save({
    lastCheck: now.toISOString(),
    hashes: mergedHashes,
  });

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

function resolveImapPort(value?: string): number {
  if (!value || !value.trim()) {
    return 993;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("IMAP_PORT 環境変数が不正です。正の整数を指定してください。");
  }

  return port;
}
