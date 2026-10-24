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

/** API key from env, else whatever `grokbot` stored via /login (API key or SuperGrok/X Premium OAuth). */
async function resolveApiKey(): Promise<string | undefined> {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return new ModelRegistry(await ModelRuntime.create()).getApiKeyForProvider("xai");
}

async function provider(): Promise<XaiProvider> {
  const key = await resolveApiKey();
  if (!key) throw new Error("No xAI credentials. Set XAI_API_KEY, or run `grokbot` and use /login once.");
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
      title: "Run the grokbot agent",
      description:
        "Delegate a whole task to the autonomous grokbot agent (Grok) in a directory. It can read/edit files, run commands, search web and X, generate media, and use the MCP servers configured for grokbot (e.g. email). Returns its final answer, tool trail, cost and a session_id to continue later. Can take minutes.",
      inputSchema: {
        prompt: z.string().min(1).describe("The task, with all context Grok needs"),
        directory: dirArg,
        session: z.string().optional().describe("session_id from an earlier grok_agent call, to continue it"),
        model: z.string().optional().describe(`Grok model id. Default ${DEFAULT_MODEL}`),
      },
    },
    async ({ prompt, directory: dir, session, model }, extra) => {
      try {
        const token = extra._meta?.progressToken;
        let toolCount = 0;
        const run = await runAgent({
          prompt,
          cwd: directory(dir),
          session,
          model,
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
    { title: "List Grok models", description: "List Grok model ids with context window and price.", inputSchema: {} },
    async () =>
      reply(
        xaiProvider()
          .getModels()
          .map((m) => `${m.id}: ${m.name} | ${m.contextWindow} ctx | $${m.cost.input}/$${m.cost.output} per 1M tokens`)
          .join("\n"),
      ),
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
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

function runAgent(opts: RunAgentOptions): Promise<AgentRun> {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const args = [
    cli,
    "--mode",
    "json",
    ...(opts.session ? ["--session", opts.session] : []),
    ...(opts.model ? ["--provider", "xai", "--model", opts.model] : []),
    "--",
    opts.prompt,
  ];

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
