export interface WorkerState {
  lastCheck: string;
  hashes: string[];
}

export interface Env {
  EMAIL_STATE: KVNamespace;
  IMAP_HOST: string;
  IMAP_PORT: string;
  IMAP_SECURE?: "on" | "starttls" | "off";
  IMAP_USERNAME: string;
  IMAP_PASSWORD: string;
  IMAP_MAILBOX?: string;
  DISCORD_WEBHOOK_URL: string;
}

export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  internalDate: Date;
  messageId?: string;
  hash: string;
}
