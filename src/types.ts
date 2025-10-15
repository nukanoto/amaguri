export interface WorkerState {
  lastCheck: string | null;
  hashes: string[];
}

export type Env = Cloudflare.Env & {
  IMAP_PORT?: string;
  IMAP_SECURE?: "on" | "starttls" | "off";
  IMAP_MAILBOX?: string;
};

export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  internalDate: Date;
  messageId?: string;
  hash: string;
}
