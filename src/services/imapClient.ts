import { connect } from "cloudflare:sockets";
import type { MailSummary } from "../types";
import { hashString } from "../utils/hash";

type ImapSegment = { type: "line"; text: string } | { type: "literal"; text: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

export class ImapClient {
  private readonly host: string;
  private readonly port: number;
  private readonly secure: "on" | "starttls" | "off";
  private readonly username: string;
  private readonly password: string;
  private socket: Socket | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private buffer = "";
  private tagCounter = 1;

  constructor(opts: {
    host: string;
    port: number;
    secure: "on" | "starttls" | "off";
    username: string;
    password: string;
  }) {
    this.host = opts.host;
    this.port = opts.port;
    this.secure = opts.secure;
    this.username = opts.username;
    this.password = opts.password;
  }

  async connect(): Promise<void> {
    if (this.socket) {
      return;
    }

    this.socket = connect(
      {
        hostname: this.host,
        port: this.port,
      },
      {
        secureTransport: this.secure,
        allowHalfOpen: false,
      },
    );

    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();

    const greeting = await this.readLine();
    if (!greeting.startsWith("*")) {
      throw new Error(`IMAP サーバーの挨拶が不正です: ${greeting}`);
    }
  }

  async login(): Promise<void> {
    const { tag, segments } = await this.sendCommand(
      `LOGIN ${quoteString(this.username)} ${quoteString(this.password)}`,
    );
    this.assertOk(tag, segments, "LOGIN");
  }

  async selectMailbox(mailbox: string): Promise<void> {
    const { tag, segments } = await this.sendCommand(`SELECT ${quoteString(mailbox)}`);
    this.assertOk(tag, segments, "SELECT");
  }

  async searchSince(date: Date): Promise<number[]> {
    const since = formatImapSince(date);
    const { tag, segments } = await this.sendCommand(`UID SEARCH SINCE ${since}`);
    this.assertOk(tag, segments, "SEARCH");

    const searchLine = segments.find(
      (segment) => segment.type === "line" && segment.text.startsWith("* SEARCH"),
    );
    if (!searchLine) {
      return [];
    }

    const parts = searchLine.text.split(" ").slice(2);
    return parts
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 10))
      .filter((n) => Number.isFinite(n));
  }

  async fetchSummary(uid: number): Promise<MailSummary | null> {
    const { tag, segments } = await this.sendCommand(
      `UID FETCH ${uid} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM DATE)])`,
    );
    this.assertOk(tag, segments, "FETCH");

    const fetchLine = segments.find(
      (segment) => segment.type === "line" && segment.text.startsWith("* "),
    );
    const literal = segments.find((segment) => segment.type === "literal");
    if (!fetchLine || !literal) {
      return null;
    }

    const uidMatch = fetchLine.text.match(/UID (\d+)/i);
    const internalDateMatch = fetchLine.text.match(/INTERNALDATE "([^"]+)"/i);
    if (!uidMatch || !internalDateMatch) {
      return null;
    }

    const internalDate = new Date(internalDateMatch[1]);
    if (Number.isNaN(internalDate.getTime())) {
      return null;
    }

    const headers = parseHeaders(literal.text);
    const subject = headers.get("subject") ?? "";
    const from = headers.get("from") ?? "";
    const messageId = headers.get("message-id") ?? undefined;

    const hashInput = `${uidMatch[1]}|${internalDate.toISOString()}|${subject}|${from}|${messageId ?? ""}`;
    const hash = await hashString(hashInput);

    return {
      uid: Number.parseInt(uidMatch[1], 10),
      subject,
      from,
      internalDate,
      messageId,
      hash,
    };
  }

  async close(): Promise<void> {
    try {
      if (this.writer) {
        await this.sendCommand("LOGOUT");
      }
    } catch (err) {
      console.warn("LOGOUT に失敗しました", err);
    }

    if (this.reader) {
      await this.reader.cancel();
      this.reader = null;
    }
    if (this.writer) {
      await this.writer.close();
      this.writer = null;
    }
    if (this.socket) {
      await this.socket.close();
      this.socket = null;
    }
    this.buffer = "";
  }

  private async sendCommand(command: string): Promise<{ tag: string; segments: ImapSegment[] }> {
    if (!this.writer || !this.reader) {
      throw new Error("IMAP 接続が初期化されていません。");
    }

    const tag = `A${this.tagCounter++}`;
    await this.writer.write(encoder.encode(`${tag} ${command}\r\n`));
    const segments = await this.readUntilTag(tag);
    return { tag, segments };
  }

  private async readUntilTag(tag: string): Promise<ImapSegment[]> {
    const segments: ImapSegment[] = [];

    while (true) {
      const line = await this.readLine();
      segments.push({ type: "line", text: line });

      const literalMatch = line.match(/\{(\d+)\}$/);
      if (literalMatch) {
        const literalLength = Number.parseInt(literalMatch[1], 10);
        const literal = await this.readLiteral(literalLength);
        segments.push({ type: "literal", text: literal });
      }

      if (line.startsWith(`${tag} `)) {
        return segments;
      }
    }
  }

  private async readLine(): Promise<string> {
    while (true) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        return line;
      }

      if (!this.reader) {
        throw new Error("IMAP リーダーが初期化されていません。");
      }

      const { value, done } = await this.reader.read();
      if (done) {
        throw new Error("IMAP サーバーとの接続が切断されました。");
      }
      this.buffer += decoder.decode(value, { stream: true });
    }
  }

  private async readLiteral(length: number): Promise<string> {
    let literal = "";
    while (literal.length < length) {
      if (this.buffer.length > 0) {
        const take = Math.min(length - literal.length, this.buffer.length);
        literal += this.buffer.slice(0, take);
        this.buffer = this.buffer.slice(take);
      } else {
        if (!this.reader) {
          throw new Error("IMAP リーダーが初期化されていません。");
        }
        const { value, done } = await this.reader.read();
        if (done) {
          throw new Error("IMAP サーバーとの接続が切断されました。");
        }
        this.buffer += decoder.decode(value, { stream: true });
      }
    }
    return literal;
  }

  private assertOk(tag: string, segments: ImapSegment[], context: string) {
    const last = segments[segments.length - 1];
    if (!last || last.type !== "line" || !last.text.toUpperCase().startsWith(`${tag} OK`)) {
      const message = last && last.type === "line" ? last.text : "(応答なし)";
      throw new Error(`${context} コマンドが失敗しました: ${message}`);
    }
  }
}

function formatImapSince(date: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

function quoteString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseHeaders(headerBlock: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = headerBlock.split(/\r\n/);
  let currentKey: string | null = null;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentKey) {
      map.set(currentKey, `${map.get(currentKey)} ${line.trim()}`);
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) {
      currentKey = null;
      continue;
    }
    currentKey = line.slice(0, idx).toLowerCase();
    map.set(currentKey, line.slice(idx + 1).trim());
  }

  return map;
}
