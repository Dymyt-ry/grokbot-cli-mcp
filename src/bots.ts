// Client for the official Grok Bot app's bots (xAI's desktop agent, served by Cursor's backend).
// Unofficial: it calls the same private Connect API the app uses (aiserver.v1.GrokBotService), with the user's own
// Cursor login, so messages and replies show up in the app. It can break whenever the app's API changes.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// --- Bots as pi "models": pick one with /model and chat with it in the grokbot TUI ---------------------------

export const BOTS_PROVIDER = "grok-bot-app";
const botIds = new Map<string, string>(); // model id (slug) -> agentId

/** Readable, unique model ids: "Grok Bot" -> "grok-bot"; duplicates get -2, -3. */
export function botSlugs(bots: Bot[]): string[] {
  const seen = new Map<string, number>();
  return bots.map((b) => {
    const base = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "bot";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/** The last user message is what gets sent: the bot keeps its own history in the app. */
function lastUserText(context: TranscriptContext): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m.role !== "user") continue;
    return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  }
  return "";
}

export function streamBot(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const block = output.content[0] as { type: "text"; text: string };
  const add = (delta: string) => {
    block.text += delta;
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
  };

  void (async () => {
    stream.push({ type: "start", partial: output });
    stream.push({ type: "text_start", contentIndex: 0, partial: output });
    const bot = { agentId: botIds.get(model.id) ?? model.id, name: model.name };
    const { done } = await sendToBot(bot, lastUserText(context), {
      signal: options?.signal,
      onReply: (e) => add(`${block.text ? "\n\n" : ""}${e.text}`),
    });
    if (options?.signal?.aborted) throw new Error("aborted");
    if (!done) add(`${block.text ? "\n\n" : ""}_${model.name} is still working; the rest will show in the Grok Bot app._`);
    stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
  })().catch((err: unknown) => {
    const aborted = options?.signal?.aborted ?? false;
    output.stopReason = aborted ? "aborted" : "error";
    output.errorMessage = aborted ? "Request was aborted" : err instanceof Error ? err.message : String(err);
    stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
    stream.end();
  });
  return stream;
}

/** Registers the user's Grok Bot bots as models. Skipped quietly when there is no Cursor login or no network. */
export async function registerBotProvider(pi: ExtensionAPI): Promise<void> {
  let bots: Bot[];
  try {
    bots = await listBots();
  } catch {
    return;
  }
  if (!bots.length) return;
  const ids = botSlugs(bots);
  bots.forEach((b, i) => botIds.set(ids[i], b.agentId));
  pi.registerProvider(BOTS_PROVIDER, {
    name: "Grok Bot app",
    baseUrl: API,
    apiKey: "cursor-login", // the real token is read from the Cursor login on each request
    api: "grok-bot-app",
    streamSimple: streamBot,
    models: bots.map((b, i) => ({
      id: ids[i],
      name: `${b.name} (Grok Bot app)`,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 100_000,
    })),
  });
}
