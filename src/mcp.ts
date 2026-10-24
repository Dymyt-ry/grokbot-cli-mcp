// `grokbot mcp`: stdio MCP server that lets Claude Code (or any MCP host) use Grok.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { generateText } from "ai";
import { z } from "zod";
import { listBots, pickBot, readBot, sendToBot } from "./bots.js";
import { DEFAULT_MODEL, VERSION } from "./setup.js";
import {
  createImage,
  createProvider,
  createVideo,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  loadImage,
  type Result,
  search,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type XaiProvider,
} from "./xai.js";

type ToolResponse = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const reply = (text: string, isError = false): ToolResponse => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});
const fromResult = (r: Result) => reply(r.text, !r.ok);

/** API key from env, else whatever `grokbot login` or /login stored (x.ai OAuth or API key). */
async function resolveApiKey(): Promise<string | undefined> {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return new ModelRegistry(await ModelRuntime.create()).getApiKeyForProvider("xai");
}

async function provider(): Promise<XaiProvider> {
  const key = await resolveApiKey();
  if (!key) throw new Error("No xAI credentials. Run `grokbot login` once (Google, X or email via x.ai), or set XAI_API_KEY.");
  return createProvider(key);
}

function directory(dir: string | undefined): string {
  const full = resolve(dir || process.cwd());
  if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error(`Directory does not exist: ${full}`);
  return full;
}

/** Thrown errors become MCP tool errors (isError) instead of protocol errors. */
function safe<A>(handler: (args: A, signal: AbortSignal) => Promise<ToolResponse>) {
  return async (args: A, extra: { signal: AbortSignal }): Promise<ToolResponse> => {
    try {
      return await handler(args, extra.signal);
    } catch (err) {
      return reply(err instanceof Error ? err.message : String(err), true);
    }
  };
}

const dirArg = z
  .string()
  .optional()
  .describe("Working directory (absolute path). Defaults to where the MCP server was started.");

export function createGrokMcpServer(): McpServer {
  const server = new McpServer({ name: "grokbot", version: VERSION });

  server.registerTool(
    "grok_ask",
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      title: "Ask Grok",
      description:
        "One-shot prompt to xAI Grok. Good for a second opinion, brainstorming, or reasoning with a different model. Pass image paths/URLs in `images` for vision. Grok sees only what you put in the prompt.",
      inputSchema: {
        prompt: z.string().min(1),
        system: z.string().optional(),
        model: z.string().optional().describe(`Grok model id (see grok_models). Default ${DEFAULT_MODEL}`),
        images: z.array(z.string()).optional().describe("Local paths or http(s) URLs of images"),
        directory: dirArg,
      },
    },
    safe(async ({ prompt, system, model, images, directory: dir }, signal) => {
      const xai = await provider();
      const cwd = directory(dir);
      const files = await Promise.all((images ?? []).map((src) => loadImage(src, cwd, signal)));
      const { text } = await generateText({
        model: xai.responses(model || DEFAULT_MODEL),
        system,
        messages: [
          {
            role: "user",
            content: [
              ...files.map((f) => ({ type: "file" as const, data: f.data, mediaType: f.mediaType })),
              { type: "text" as const, text: prompt },
            ],
          },
        ],
        abortSignal: signal,
      });
      return reply(text || "(empty response)");
    }),
  );

  server.registerTool(
    "grok_search_web",
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      title: "Grok web search",
      description: "Live web search via Grok. Synthesized answer with source URLs. Current docs, news, prices, releases.",
      inputSchema: {
        query: z.string().min(1),
        allowed_domains: z.array(z.string()).max(5).optional(),
        excluded_domains: z.array(z.string()).max(5).optional(),
      },
    },
    safe(async ({ query, allowed_domains, excluded_domains }, signal) =>
      fromResult(
        await search(
          await provider(),
          "web",
          query,
          { allowedDomains: allowed_domains, excludedDomains: excluded_domains },
          signal,
        ),
      ),
    ),
  );

  server.registerTool(
    "grok_search_x",
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      title: "Grok X search",
      description:
        "Real-time search of X (Twitter) via Grok: what people say, sentiment, announcements. Synthesized answer with post URLs.",
      inputSchema: {
        query: z.string().min(1),
        handles: z.array(z.string()).max(10).optional().describe("Only these handles (no @)"),
        excluded_handles: z.array(z.string()).max(10).optional(),
        from_date: z.string().optional().describe("YYYY-MM-DD"),
        to_date: z.string().optional().describe("YYYY-MM-DD"),
      },
    },
    safe(async ({ query, handles, excluded_handles, from_date, to_date }, signal) =>
      fromResult(
        await search(
          await provider(),
          "x",
          query,
          { allowedXHandles: handles, excludedXHandles: excluded_handles, fromDate: from_date, toDate: to_date },
          signal,
        ),
      ),
    ),
  );

  server.registerTool(
    "grok_generate_image",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      title: "Grok image generation",
      description: "Generate an image from text, or edit one (pass `source`). Saves files locally and returns paths.",
      inputSchema: {
        prompt: z.string().min(1),
        source: z.string().optional(),
        aspect_ratio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
        resolution: z.enum(IMAGE_RESOLUTIONS).optional(),
        n: z.number().int().min(1).max(4).optional(),
        output_path: z.string().optional(),
        directory: dirArg,
      },
    },
    safe(async ({ directory: dir, ...input }, signal) =>
      fromResult(await createImage(await provider(), input, directory(dir), signal)),
    ),
  );

  server.registerTool(
    "grok_generate_video",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      title: "Grok video generation",
      description: "Generate a short video from text, or animate an image (`source`). Slow. Saves locally, returns path.",
      inputSchema: {
        prompt: z.string().min(1),
        source: z.string().optional(),
        duration: z.number().int().min(1).max(15).optional(),
        aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).optional(),
        resolution: z.enum(VIDEO_RESOLUTIONS).optional(),
        output_path: z.string().optional(),
        directory: dirArg,
      },
    },
    safe(async ({ directory: dir, ...input }, signal) =>
      fromResult(await createVideo(await provider(), input, directory(dir), signal)),
    ),
  );

  server.registerTool(
    "grok_agent",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      title: "Run the grokbot agent",
      description:
        "Delegate a whole task to the autonomous grokbot agent (Grok) in a directory. It can read/edit files, run commands, search web and X, generate media, and use the MCP servers configured for grokbot (e.g. email). Returns its final answer, tool trail, cost and a session_id to continue later. Can take minutes. Set read_only for research/review tasks: no shell, no file writes, no MCP servers.",
      inputSchema: {
        prompt: z.string().min(1).describe("The task, with all context Grok needs"),
        directory: dirArg,
        session: z.string().optional().describe("session_id from an earlier grok_agent call, to continue it"),
        model: z.string().optional().describe(`Grok model id. Default ${DEFAULT_MODEL}`),
        read_only: z
          .boolean()
          .optional()
          .describe("Only read/search tools: no bash, no edits, no MCP servers. Use for research and reviews."),
      },
    },
    async ({ prompt, directory: dir, session, model, read_only }, extra) => {
      try {
        const token = extra._meta?.progressToken;
        let toolCount = 0;
        const run = await runAgent({
          prompt,
          cwd: directory(dir),
          session,
          model,
          readOnly: read_only === true,
          signal: extra.signal,
          onEvent: (event) => {
            if (token === undefined || event.type !== "tool_execution_start") return;
            toolCount += 1;
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken: token, progress: toolCount, message: String(event.toolName) },
              })
              .catch(() => {});
          },
        });
        return reply(formatAgentRun(run), Boolean(run.error) && !run.answer);
      } catch (err) {
        return reply(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  server.registerTool(
    "grok_models",
    { title: "List Grok models", annotations: { readOnlyHint: true }, description: "List Grok model ids with context window and price.", inputSchema: {} },
    async () =>
      reply(
        xaiProvider()
          .getModels()
          .map((m) => `${m.id}: ${m.name} | ${m.contextWindow} ctx | $${m.cost.input}/$${m.cost.output} per 1M tokens`)
          .join("\n"),
      ),
  );

  // --- The user's bots in the official Grok Bot app (unofficial client, Cursor login) ---
  const botArg = z.string().optional().describe("Bot name (or prefix) as shown in the Grok Bot app; default: the main bot");

  server.registerTool(
    "bot_list",
    { title: "List Grok Bot bots", annotations: { readOnlyHint: true, openWorldHint: true }, description: "List the user's bots in the Grok Bot app.", inputSchema: {} },
    safe(async () => reply((await listBots()).map((b) => `${b.name}${b.description ? `: ${b.description}` : ""}`).join("\n"))),
  );

  server.registerTool(
    "bot_read",
    {
      title: "Read a Grok Bot chat",
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: "Read the latest messages of one of the user's Grok Bot bots.",
      inputSchema: { bot: botArg, limit: z.number().int().min(1).max(100).optional().describe("Default 10") },
    },
    safe(async ({ bot, limit }: { bot?: string; limit?: number }) => {
      const target = pickBot(await listBots(), bot);
      const entries = await readBot(target, limit ?? 10);
      return reply(entries.map((e) => `${e.from === "you" ? "user" : target.name}: ${e.text}`).join("\n\n") || "(no messages)");
    }),
  );

  server.registerTool(
    "bot_send",
    {
      title: "Message a Grok Bot bot",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "Send a message to one of the user's Grok Bot bots (it appears in their Grok Bot app as sent by them) and return the bot's replies. " +
        "Bots have their own computer, email inbox and connected apps, so they can act on the user's behalf. Waits up to timeout_s for the turn to finish.",
      inputSchema: {
        bot: botArg,
        message: z.string().min(1),
        timeout_s: z.number().int().min(0).max(1800).optional().describe("0 = send without waiting; default 600"),
      },
    },
    safe(async ({ bot, message, timeout_s }: { bot?: string; message: string; timeout_s?: number }, signal) => {
      const target = pickBot(await listBots(), bot);
      const wait = timeout_s !== 0;
      const { replies, done } = await sendToBot(target, message, { wait, timeoutMs: (timeout_s ?? 600) * 1000, signal });
      if (!wait) return reply(`Sent to ${target.name}.`);
      const text = replies.map((r) => r.text).join("\n\n") || "(no reply yet)";
      return reply(done ? text : `${text}\n\n[${target.name} is still working; read later with bot_read]`);
    }),
  );

  return server;
}

// --- grok_agent: runs `grokbot --mode json` as a subprocess -------------------------------------------

/** The subset of pi's JSON event stream (docs/json.md) that grok_agent reads. */
export type AgentEvent = { type: string; [key: string]: unknown };

export interface AgentRun {
  sessionId?: string;
  answer: string;
  tools: Array<{ name: string; ok: boolean }>;
  costUsd: number;
  error?: string;
}

interface AssistantMessage {
  role: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { cost?: { total?: number } };
  stopReason?: string;
  errorMessage?: string;
}

export function summarizeAgentEvents(events: AgentEvent[]): AgentRun {
  const run: AgentRun = { answer: "", tools: [], costUsd: 0 };
  for (const event of events) {
    if (event.type === "session" && typeof event.id === "string") run.sessionId = event.id;
    if (event.type === "tool_execution_end") run.tools.push({ name: String(event.toolName), ok: event.isError !== true });
    if (event.type === "message_end") {
      const msg = event.message as AssistantMessage | undefined;
      if (msg?.role !== "assistant") continue;
      run.costUsd += msg.usage?.cost?.total ?? 0;
      const text = (msg.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
      if (text.trim()) run.answer = text.trim(); // the last assistant text is the final answer
      if (msg.stopReason === "error" || msg.stopReason === "aborted") run.error = msg.errorMessage || msg.stopReason;
    }
  }
  return run;
}

export function formatAgentRun(run: AgentRun): string {
  const parts = [run.answer || "(no text answer)"];
  if (run.error) parts.push(`Error: ${run.error}`);
  if (run.tools.length) parts.push(`Tools used: ${run.tools.map((t) => (t.ok ? t.name : `${t.name}(failed)`)).join(", ")}`);
  const meta = [run.sessionId && `session_id: ${run.sessionId}`, run.costUsd > 0 && `cost: $${run.costUsd.toFixed(4)}`];
  if (meta.some(Boolean)) parts.push(meta.filter(Boolean).join(" | "));
  return parts.join("\n\n");
}

interface RunAgentOptions {
  prompt: string;
  cwd: string;
  session?: string;
  model?: string;
  readOnly?: boolean;
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export const READ_ONLY_ARGS = ["--tools", "read,grep,find,ls,web_search,x_search", "--no-mcp"];

export function agentArgs(opts: Pick<RunAgentOptions, "prompt" | "session" | "model" | "readOnly">): string[] {
  return [
    "--mode",
    "json",
    ...(opts.readOnly ? READ_ONLY_ARGS : []),
    ...(opts.session ? ["--session", opts.session] : []),
    ...(opts.model ? ["--provider", "xai", "--model", opts.model] : []),
    "--",
    opts.prompt,
  ];
}

function runAgent(opts: RunAgentOptions): Promise<AgentRun> {
  const args = [fileURLToPath(new URL("./cli.js", import.meta.url)), ...agentArgs(opts)];

  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const events: AgentEvent[] = [];
    let buffer = "";
    let stderr = "";
    const onAbort = () => child.kill();
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n"); // JSONL framing is LF only (see pi docs/json.md)
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line.replace(/\r$/, "")) as AgentEvent;
          events.push(event);
          opts.onEvent?.(event);
        } catch {
          // not a JSON record
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      const run = summarizeAgentEvents(events);
      if (code !== 0 && !run.error) run.error = stderr.trim() || `grokbot exited with code ${code}`;
      done(run);
    });
  });
}

export async function startMcpServer(): Promise<void> {
  await createGrokMcpServer().connect(new StdioServerTransport());
}
