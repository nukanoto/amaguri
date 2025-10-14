import type { MailSummary } from "../types";

export async function notifyDiscord(webhookUrl: string, mail: MailSummary) {
  const lines = [
    `📧 新着メール: ${mail.subject || "(件名なし)"}`,
    `From: ${mail.from || "(差出人不明)"}`,
    `受信日時: ${mail.internalDate.toISOString()}`,
  ];

  if (mail.messageId) {
    lines.push(`Message-ID: ${mail.messageId}`);
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: lines.join("\n"),
      allowed_mentions: { parse: [] },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord webhook 送信エラー: ${res.status} ${body}`);
  }
}
