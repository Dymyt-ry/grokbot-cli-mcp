import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { generateText } from "ai";
import { spawn } from "child_process";
import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { z } from "zod";
import packageJson from "../../package.json";
import { buildVisionUserMessages } from "../agent/vision-input";
import { createProvider, resolveModelRuntime, type XaiProvider } from "../grok/client";
import {
  generateImageTool,
  generateVideoTool,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
} from "../grok/media";
import { getEffectiveReasoningEffort, MODELS, normalizeModelId } from "../grok/models";
import { grokSearch } from "../grok/search";
import type { HeadlessJsonEvent } from "../headless/output";
import { resolveCliArgs } from "../tools/schedule";
import type { ToolResult } from "../types/index";
import { getApiKey, getBaseURL, getCurrentModel } from "../utils/settings";

type ToolResponse = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (value: string, isError = false): ToolResponse => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

const fromToolResult = (result: ToolResult): ToolResponse =>
  text(result.output || result.error || (result.success ? "Done." : "Failed."), !result.success);

function requireProvider(): XaiProvider {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("No Grok API key. Set GROK_API_KEY or run `grokbot -k <key>` once to save it.");
  }
  return createProvider(apiKey, getBaseURL());
}

function resolveDirectory(directory: string | undefined): string {
  const dir = resolve(directory || process.cwd());
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Directory does not exist: ${dir}`);
  }
  return dir;
}

/** Wraps a handler so thrown errors become MCP tool errors instead of protocol errors. */
function safe<A>(handler: (args: A, signal: AbortSignal) => Promise<ToolResponse>) {
  return async (args: A, extra: { signal: AbortSignal }): Promise<ToolResponse> => {
    try {
      return await handler(args, extra.signal);
    } catch (err: unknown) {
      return text(err instanceof Error ? err.message : String(err), true);
    }
  };
}

const directoryArg = z
  .string()
  .optional()
  .describe("Working directory (absolute path). Defaults to the directory the MCP server was started in.");

export function createGrokMcpServer(): McpServer {
  const server = new McpServer({ name: "grokbot", version: packageJson.version });

  server.registerTool(
    "grok_ask",
    {
      title: "Ask Grok",
      description:
        "Send a one-shot prompt to xAI Grok and get its answer. Useful for a second opinion, brainstorming, or reasoning with a different model. Pass image paths/URLs (png/jpg) in `images` for vision. Grok has no access to your files here unless you include their content in the prompt.",
      inputSchema: {
        prompt: z.string().min(1).describe("The question or task for Grok"),
        system: z.string().optional().describe("Optional system prompt"),
        model: z.string().optional().describe("Grok model id (see grok_models). Defaults to the user's default model."),
        images: z.array(z.string()).optional().describe("Local paths or http(s) URLs of png/jpg images to analyze"),
        reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
        directory: directoryArg,
      },
    },
    safe(async ({ prompt, system, model, images, reasoning_effort, directory }, signal) => {
      const runtime = resolveModelRuntime(requireProvider(), model || getCurrentModel());
      const effort = getEffectiveReasoningEffort(runtime.modelId, reasoning_effort);
      const visionPrompt = images?.length ? `${prompt}\n\n${images.join("\n")}` : prompt;
      const messages = await buildVisionUserMessages(visionPrompt, resolveDirectory(directory), signal);
      const result = await generateText({
        model: runtime.model,
        system,
        messages,
        abortSignal: signal,
        ...(effort ? { providerOptions: { xai: { reasoningEffort: effort } } } : {}),
      });
      return text(result.text || "(empty response)");
    }),
  );

  server.registerTool(
    "grok_search_web",
    {
      title: "Grok web search",
      description:
        "Live web search via Grok. Returns a synthesized answer with source URLs. Good for current docs, news, prices, releases.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for, phrased as a question or task"),
        allowed_domains: z.array(z.string()).max(5).optional().describe("Only search these domains"),
        excluded_domains: z.array(z.string()).max(5).optional().describe("Never search these domains"),
      },
    },
    safe(async ({ query, allowed_domains, excluded_domains }, signal) => {
      const result = await grokSearch(
        requireProvider(),
        "web_search",
        query,
        { allowedDomains: allowed_domains, excludedDomains: excluded_domains },
        signal,
      );
      return text(result.output, !result.success);
    }),
  );

  server.registerTool(
    "grok_search_x",
    {
      title: "Grok X search",
      description:
        "Real-time search of X (Twitter) posts via Grok: discussions, sentiment, announcements, what people say about a topic. Returns a synthesized answer with post URLs.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for on X"),
        handles: z.array(z.string()).max(10).optional().describe("Only posts from these X handles (without @)"),
        excluded_handles: z.array(z.string()).max(10).optional().describe("Exclude posts from these handles"),
        from_date: z.string().optional().describe("Start date YYYY-MM-DD"),
        to_date: z.string().optional().describe("End date YYYY-MM-DD"),
      },
    },
    safe(async ({ query, handles, excluded_handles, from_date, to_date }, signal) => {
      const result = await grokSearch(
        requireProvider(),
        "x_search",
        query,
        { allowedXHandles: handles, excludedXHandles: excluded_handles, fromDate: from_date, toDate: to_date },
        signal,
      );
      return text(result.output, !result.success);
    }),
  );

  server.registerTool(
    "grok_generate_image",
    {
      title: "Grok image generation",
      description:
        "Generate an image from text, or edit an existing image (pass `source`). Saves files locally and returns their paths.",
      inputSchema: {
        prompt: z.string().min(1),
        source: z.string().optional().describe("Path or URL of an image to edit"),
        aspect_ratio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
        resolution: z.enum(IMAGE_RESOLUTIONS).optional(),
        n: z.number().int().min(1).max(4).optional().describe("Number of images"),
        output_path: z.string().optional().describe("File path to save to (default: .grok/generated-media/)"),
        directory: directoryArg,
      },
    },
    safe(async ({ directory, ...input }, signal) =>
      fromToolResult(await generateImageTool(requireProvider(), input, resolveDirectory(directory), signal)),
    ),
  );

  server.registerTool(
    "grok_generate_video",
    {
      title: "Grok video generation",
      description:
        "Generate a short video from text, or animate an image (pass `source`). Slow (can take minutes). Saves the file locally and returns its path.",
      inputSchema: {
        prompt: z.string().min(1),
        source: z.string().optional().describe("Path or URL of an image to animate"),
        duration: z.number().int().min(1).max(15).optional().describe("Seconds"),
        aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).optional(),
        resolution: z.enum(VIDEO_RESOLUTIONS).optional(),
        output_path: z.string().optional(),
        directory: directoryArg,
      },
    },
    safe(async ({ directory, ...input }, signal) =>
      fromToolResult(await generateVideoTool(requireProvider(), input, resolveDirectory(directory), signal)),
    ),
  );

  server.registerTool(
    "grok_agent",
    {
      title: "Run the Grok agent",
      description:
        "Delegate a whole task to the autonomous Grok agent running in a directory. It can read/edit files, run shell commands, search web and X, generate media, use its own sub-agents and any MCP servers configured for grokbot (e.g. email). Returns its final answer, a tool trail, and a session_id you can pass back to continue the conversation. Can take minutes.",
      inputSchema: {
        prompt: z.string().min(1).describe("The task, with all context Grok needs"),
        directory: directoryArg,
        session: z.string().optional().describe("session_id from a previous grok_agent call, or 'latest', to continue"),
        model: z.string().optional().describe("Grok model id"),
        max_tool_rounds: z.number().int().min(1).max(400).optional().describe("Default 100"),
      },
    },
    async ({ prompt, directory, session, model, max_tool_rounds }, extra) => {
      try {
        const progressToken = extra._meta?.progressToken;
        const run = await runGrokAgent({
          prompt,
          directory: resolveDirectory(directory),
          session,
          model,
          maxToolRounds: max_tool_rounds ?? 100,
          signal: extra.signal,
          onEvent: (event, count) => {
            if (progressToken === undefined || event.type !== "tool_use") return;
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress: count, message: `${event.toolCall.function.name}` },
              })
              .catch(() => {});
          },
        });
        return text(formatAgentRun(run), run.error !== undefined && run.answer === "");
      } catch (err: unknown) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  server.registerTool(
    "grok_models",
    {
      title: "List Grok models",
      description: "List available Grok model ids with context window, price and capabilities.",
      inputSchema: {},
    },
    async () =>
      text(
        MODELS.map(
          (m) =>
            `${m.id}: ${m.description} | ${m.contextWindow} ctx | $${m.inputPrice}/$${m.outputPrice} per 1M tokens${m.reasoning ? " | reasoning" : ""}`,
        ).join("\n"),
      ),
  );

  return server;
}

export interface AgentRun {
  sessionId?: string;
  answer: string;
  tools: Array<{ name: string; success: boolean }>;
  costUsd?: number;
  error?: string;
}

/** Folds the headless `--format json` event stream into a compact result. */
export function summarizeAgentEvents(events: HeadlessJsonEvent[]): AgentRun {
  const run: AgentRun = { answer: "", tools: [] };
  const texts: string[] = [];
  let costTicks = 0;
  for (const event of events) {
    if (event.sessionID) run.sessionId = event.sessionID;
    if (event.type === "text" && event.text.trim()) texts.push(event.text.trim());
    if (event.type === "tool_use") {
      run.tools.push({ name: event.toolCall.function.name, success: event.toolResult.success });
    }
    if (event.type === "step_finish") costTicks += event.usage.costUsdTicks ?? 0;
    if (event.type === "error") run.error = event.message;
  }
  run.answer = texts.join("\n\n");
  // xAI reports cost in 1e-10 USD ticks
  if (costTicks > 0) run.costUsd = costTicks / 1e10;
  return run;
}

export function formatAgentRun(run: AgentRun): string {
  const parts = [run.answer || "(no text answer)"];
  if (run.error) parts.push(`Error: ${run.error}`);
  if (run.tools.length > 0) {
    parts.push(`Tools used: ${run.tools.map((t) => (t.success ? t.name : `${t.name}(failed)`)).join(", ")}`);
  }
  const meta = [
    run.sessionId ? `session_id: ${run.sessionId}` : null,
    run.costUsd ? `cost: $${run.costUsd.toFixed(4)}` : null,
  ];
  if (meta.some(Boolean)) parts.push(meta.filter(Boolean).join(" | "));
  return parts.join("\n\n");
}

interface RunGrokAgentOptions {
  prompt: string;
  directory: string;
  session?: string;
  model?: string;
  maxToolRounds: number;
  signal: AbortSignal;
  onEvent?: (event: HeadlessJsonEvent, count: number) => void;
}

function runGrokAgent(opts: RunGrokAgentOptions): Promise<AgentRun> {
  const args = [
    ...resolveCliArgs(),
    "--prompt",
    opts.prompt,
    "--format",
    "json",
    "--directory",
    opts.directory,
    "--max-tool-rounds",
    String(opts.maxToolRounds),
    ...(opts.session ? ["--session", opts.session] : []),
  ];
  // GROK_MODEL instead of --model: --model would overwrite the user's saved default model.
  const env = { ...process.env, ...(opts.model ? { GROK_MODEL: normalizeModelId(opts.model) } : {}) };

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: opts.directory, env, stdio: ["ignore", "pipe", "pipe"] });
    const events: HeadlessJsonEvent[] = [];
    let buffer = "";
    let stderr = "";

    const onAbort = () => child.kill("SIGTERM");
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as HeadlessJsonEvent;
          events.push(event);
          opts.onEvent?.(event, events.length);
        } catch {
          // non-JSON noise on stdout; ignore
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
      if (code !== 0 && !run.error) run.error = stderr.trim() || `grok agent exited with code ${code}`;
      resolvePromise(run);
    });
  });
}

export async function startMcpServer(): Promise<void> {
  const server = createGrokMcpServer();
  await server.connect(new StdioServerTransport());
}
