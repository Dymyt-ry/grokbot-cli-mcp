// Client for the official Grok Bot app's bots (xAI's desktop agent, served by Cursor's backend).
// Unofficial: it calls the same private Connect API the app uses (aiserver.v1.GrokBotService), with the user's own
// Cursor login, so messages and replies show up in the app. It can break whenever the app's API changes.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = process.env.GROKBOT_BOTS_API ?? "https://api2.cursor.sh/aiserver.v1.GrokBotService";

export interface Bot {
  agentId: string;
  name: string;
  description?: string;
}

export interface BotEntry {
  seq: number;
  from: "you" | "bot";
  text: string;
}

/** Cursor's login token. ponytail: only the Linux/XDG file cursor-agent writes; CURSOR_ACCESS_TOKEN covers the rest. */
function token(): string {
  if (process.env.CURSOR_ACCESS_TOKEN) return process.env.CURSOR_ACCESS_TOKEN;
  const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cursor", "auth.json");
  try {
    const t = JSON.parse(readFileSync(file, "utf8")).accessToken;
    if (typeof t === "string" && t) return t;
  } catch {
    // fall through to the error below
  }
  throw new Error("Not signed in to Cursor. Run `grokbot login --cursor` (or `cursor-agent login`), or set CURSOR_ACCESS_TOKEN.");
}

async function rpc<T>(method: string, body: object, retried = false): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "connect-protocol-version": "1" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 && !retried) {
    // An expired token: running cursor-agent refreshes the stored one.
    try {
      execFileSync("cursor-agent", ["status"], { stdio: "ignore", timeout: 30_000, shell: process.platform === "win32" });
    } catch {
      // the retry below reports the auth error
    }
    return rpc(method, body, true);
  }
  if (!res.ok) throw new Error(`Grok Bot API ${method} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export async function listBots(): Promise<Bot[]> {
  const { agents = [] } = await rpc<{ agents?: Bot[] }>("ListGrokBotAgents", {});
  return agents.map(({ agentId, name, description }) => ({ agentId, name, description }));
}

/** Finds a bot by id, exact name, or name prefix (case-insensitive). With no ref, the first bot (the main one). */
export function pickBot(bots: Bot[], ref?: string): Bot {
  if (!bots.length) throw new Error("No Grok Bot bots on this account. Create one in the Grok Bot app first.");
  if (!ref) return bots[0];
  const r = ref.toLowerCase();
  const bot =
    bots.find((b) => b.agentId === ref || b.name.toLowerCase() === r) ?? bots.find((b) => b.name.toLowerCase().startsWith(r));
  if (!bot) throw new Error(`No bot named "${ref}". Bots: ${bots.map((b) => b.name).join(", ")}`);
  return bot;
}

interface RawEntry {
  seq: string | number;
  body: string;
}

/** Turns transcript entries into plain messages; tool runs and other internal entries are dropped. */
export function parseEntries(entries: RawEntry[]): BotEntry[] {
  const out: BotEntry[] = [];
  for (const e of entries) {
    let body: { kind?: string; role?: string; content?: unknown; message?: { type?: string; content?: unknown; file_name?: string } };
    try {
      body = JSON.parse(Buffer.from(e.body, "base64").toString("utf8"));
    } catch {
      continue;
    }
    const seq = Number(e.seq);
    if (body.kind === "message" && body.role === "user" && typeof body.content === "string") {
      out.push({ seq, from: "you", text: body.content });
    } else if (body.kind === "send-message" && body.message) {
      const m = body.message;
      const text = m.type === "text" && typeof m.content === "string" ? m.content : m.type === "attachment" ? `[file: ${m.file_name ?? "attachment"}]` : "";
      if (text) out.push({ seq, from: "bot", text });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export async function readBot(bot: Bot, limit = 20): Promise<BotEntry[]> {
  const { entries = [] } = await rpc<{ entries?: RawEntry[] }>("ListGrokBotTranscriptEntries", {
    agentId: bot.agentId,
    limit,
    sessionId: "",
  });
  return parseEntries(entries);
}

async function settledAt(bot: Bot): Promise<number> {
  const { statuses = [] } = await rpc<{ statuses?: { agentId: string; live?: { lastTurnSettlement?: { settledAtMs?: string } } }[] }>(
    "ListGrokBotAgentStatuses",
    {},
  );
  return Number(statuses.find((s) => s.agentId === bot.agentId)?.live?.lastTurnSettlement?.settledAtMs ?? 0);
}

/**
 * Sends a message as the user (it shows up in the app) and, unless wait is off, returns the bot's replies once its
 * turn settles. Polls every few seconds; onReply sees each reply as it arrives.
 */
export async function sendToBot(
  bot: Bot,
  text: string,
  opts: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal; onReply?: (e: BotEntry) => void } = {},
): Promise<{ replies: BotEntry[]; done: boolean }> {
  const before = (await readBot(bot, 1)).at(-1)?.seq ?? 0;
  const sentAt = Date.now();
  const res = await rpc<{ dispatched?: boolean; refusal?: unknown }>("SendGrokBotUserMessage", {
    agentId: bot.agentId,
    messageId: randomUUID(),
    text,
    sentAtMs: String(sentAt),
    sessionId: "",
  });
  if (!res.dispatched) throw new Error(`The bot did not accept the message${res.refusal ? `: ${JSON.stringify(res.refusal)}` : "."}`);
  if (opts.wait === false) return { replies: [], done: false };

  const replies: BotEntry[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  while (Date.now() < deadline && !opts.signal?.aborted) {
    await new Promise((r) => setTimeout(r, 3000));
    // Checked before reading, so replies written just before the turn settled are still collected.
    const settled = (await settledAt(bot)) >= sentAt;
    for (const e of (await readBot(bot, 30)).filter((e) => e.from === "bot" && e.seq > before)) {
      if (replies.some((r) => r.seq === e.seq)) continue;
      replies.push(e);
      opts.onReply?.(e);
    }
    if (settled) return { replies, done: true };
  }
  return { replies, done: false };
}
