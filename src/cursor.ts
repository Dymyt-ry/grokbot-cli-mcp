// Grok through the Cursor CLI: a pi provider that runs `cursor-agent -p` per turn, for people who sign in with Cursor.
// cursor-agent has no tool-calling API, so pi's tools are described in the prompt and the model answers with
// <tool_call> blocks, which become real pi tool calls. pi runs the tools; Cursor only produces text.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export const CURSOR_PROVIDER = "cursor";
export const CURSOR_MODELS = ["grok-4.7-high", "grok-4.7-medium", "grok-4.7-low", "grok-4.7-xhigh"] as const;
const CLI = "cursor-agent";
const INSTALL_HINT =
  "Install the Cursor CLI first: `curl https://cursor.com/install -fsS | bash` (Windows: `irm 'https://cursor.com/install?win32=true' | iex`).";
const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

/** Spawns cursor-agent. Windows installs it as a .cmd shim, which needs a shell; only fixed, validated args go there. */
function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawn(CLI, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: process.platform === "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function collect(args: string[], env?: NodeJS.ProcessEnv, onLine?: (line: string) => void): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = runCli(args, { env });
    child.stdin.end();
    let out = "";
    const take = (chunk: Buffer) => {
      const text = chunk.toString();
      out += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "ENOENT" ? new Error(`Cursor CLI not found. ${INSTALL_HINT}`) : err),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** Signs in through `cursor-agent login` unless already signed in. Cursor keeps its own session; pi only stores a marker. */
export async function cursorLogin(onUrl: (url: string) => void, onProgress?: (msg: string) => void) {
  const status = await collect(["status"]);
  if (!/logged in as/i.test(stripAnsi(status.out)) || /not logged in/i.test(stripAnsi(status.out))) {
    onProgress?.("Opening Cursor sign-in...");
    let shown = false;
    const login = await collect(["login"], { ...process.env, NO_OPEN_BROWSER: "1" }, (line) => {
      const url = stripAnsi(line).match(/https:\/\/\S+/)?.[0];
      if (url && !shown) {
        shown = true;
        onUrl(url);
      }
    });
    if (login.code !== 0) throw new Error(`Cursor login failed: ${stripAnsi(login.out).trim()}`);
  }
  const who = stripAnsi((await collect(["status"])).out).match(/logged in as (\S+)/i)?.[1];
  if (!who) throw new Error("Cursor login did not complete. Run `cursor-agent login` and try again.");
  return { access: "cursor-agent", refresh: "cursor-agent", expires: Date.now() + 365 * 24 * 3600 * 1000, account: who };
}

function text(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image omitted]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** Flattens pi's transcript (system prompt, tools, messages, tool results) into one prompt for a stateless CLI call. */
export function buildPrompt(context: TranscriptContext): string {
  const tools = getCurrentTools(context.messages);
  const writable = canWrite(tools);
  const parts = [
    "<protocol>",
    "You are the model behind grokbot, a coding agent. You have two kinds of tools:",
    "1. Your own environment's tools (read, search, edit, shell, ...). They act on the same workspace; use them as usual.",
    "2. grokbot's tools listed in <tools>. Call one by ending your reply with one or more blocks, each exactly:",
    `   ${OPEN}{"name": "<tool name>", "arguments": {...}}${CLOSE}`,
    "   Write nothing after the last block. The results come back in the next turn.",
    writable
      ? "Make the changes the user asks for instead of only describing them."
      : "This session is READ-ONLY: do not modify files or run commands that change anything.",
    "</protocol>",
    "<instructions>",
    getCurrentSystemPrompt(context.messages),
    "</instructions>",
    "<tools>",
    ...tools.map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`),
    "</tools>",
    "<conversation>",
  ];
  for (const m of context.messages) {
    if (m.role === "user") parts.push(`[user]\n${text(m.content)}`);
    else if (m.role === "toolResult")
      parts.push(`[tool result ${m.toolName}${m.isError ? " (error)" : ""}]\n${text(m.content)}`);
    else if (m.role === "assistant")
      parts.push(
        `[assistant]\n${m.content
          .map((c) =>
            c.type === "text" ? c.text : c.type === "toolCall" ? `${OPEN}${JSON.stringify({ name: c.name, arguments: c.arguments })}${CLOSE}` : "",
          )
          .filter(Boolean)
          .join("\n")}`,
      );
  }
  parts.push("</conversation>", "Reply as [assistant] to the last message.");
  return parts.join("\n");
}

/** Text safe to show while streaming: everything before a <tool_call>, holding back a possibly partial opening tag. */
export function visibleText(raw: string): string {
  const at = raw.indexOf(OPEN);
  if (at >= 0) return raw.slice(0, at);
  for (let n = Math.min(OPEN.length - 1, raw.length); n > 0; n--) if (OPEN.startsWith(raw.slice(-n))) return raw.slice(0, -n);
  return raw;
}

/** Parses the <tool_call> blocks after the visible text. Unparsable blocks come back as `leftover` text. */
export function parseToolCalls(raw: string): { calls: ToolCall[]; leftover: string } {
  const calls: ToolCall[] = [];
  let leftover = "";
  const start = raw.indexOf(OPEN);
  if (start < 0) return { calls, leftover };
  for (const block of raw.slice(start).split(OPEN).slice(1)) {
    const body = block.split(CLOSE)[0].trim();
    try {
      const parsed = JSON.parse(body) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name !== "string") throw new Error("missing name");
      const args = parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments) ? parsed.arguments : {};
      calls.push({ type: "toolCall", id: `call_${randomUUID()}`, name: parsed.name, arguments: args as ToolCall["arguments"] });
    } catch {
      leftover += `${OPEN}${block}`;
    }
  }
  return { calls, leftover };
}

export interface CursorEvent {
  type?: string;
  subtype?: string;
  text?: string;
  timestamp_ms?: number;
  is_error?: boolean;
  result?: string;
  message?: { content?: { type: string; text?: string }[] };
  tool_call?: Record<string, { args?: { command?: string; path?: string; pattern?: string; globPattern?: string } }>;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

/** pi drops edit/write/bash from the tool list in read-only runs (grok_agent read_only); Cursor then may only read too. */
export function canWrite(tools: { name: string }[]): boolean {
  return tools.some((t) => ["edit", "write", "bash"].includes(t.name));
}

const CURSOR_READ_ONLY = new Set(["readToolCall", "globToolCall", "grepToolCall", "lsToolCall", "semanticSearchToolCall"]);

/** One line for the transcript about a tool Cursor ran itself, e.g. "edit calc.py". */
export function describeCursorTool(call: CursorEvent["tool_call"], cwd = process.cwd()): { name: string; readOnly: boolean; line: string } {
  const [key, value] = Object.entries(call ?? {})[0] ?? ["unknownToolCall", undefined];
  const name = key.replace(/ToolCall$/, "");
  const a = value?.args ?? {};
  const target = a.command ?? (a.path && relative(cwd, a.path).startsWith("..") ? a.path : a.path && relative(cwd, a.path)) ?? a.pattern ?? a.globPattern ?? "";
  return { name, readOnly: CURSOR_READ_ONLY.has(key), line: `${name} ${target}`.trim() };
}

export function streamCursor(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  // One open block at a time, like the providers that stream from an SSE API.
  let open: { kind: "text" | "thinking"; index: number } | undefined;
  let raw = "";
  let shown = 0;
  let segment = "";

  const close = () => {
    if (!open) return;
    const block = output.content[open.index];
    if (block.type === "text") stream.push({ type: "text_end", contentIndex: open.index, content: block.text, partial: output });
    if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: open.index, content: block.thinking, partial: output });
    open = undefined;
  };
  const append = (kind: "text" | "thinking", delta: string) => {
    if (!delta) return;
    if (open?.kind !== kind) {
      close();
      output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      open = { kind, index: output.content.length - 1 };
      stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: open.index, partial: output });
    }
    const block = output.content[open.index];
    if (block.type === "text") block.text += delta;
    if (block.type === "thinking") block.thinking += delta;
    stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: open.index, delta, partial: output });
  };
  const addText = (delta: string) => {
    raw += delta;
    const visible = visibleText(raw);
    append("text", visible.slice(shown));
    shown = visible.length;
  };
  const fail = (reason: "error" | "aborted", message: string) => {
    close();
    output.stopReason = reason;
    output.errorMessage = message;
    stream.push({ type: "error", reason, error: output });
    stream.end();
  };

  void (async () => {
    if (!(CURSOR_MODELS as readonly string[]).includes(model.id)) return fail("error", `Unknown Cursor model: ${model.id}`);
    const writable = canWrite(getCurrentTools(context.messages));
    let payload: unknown = { model: model.id, prompt: buildPrompt(context) };
    payload = (await options?.onPayload?.(payload, model)) ?? payload;
    const { prompt } = payload as { prompt: string };
    const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust", "--model", model.id];
    if (!writable) args.push("--mode", "ask");
    const child = runCli(args, { cwd: process.cwd() });
    stream.push({ type: "start", partial: output });
    child.stdin.end(prompt);

    let stderr = "";
    let result: CursorEvent | undefined;
    let blocked: string | undefined;
    const onAbort = () => child.kill();
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    let pending = "";
    child.stdout.on("data", (d: Buffer) => {
      pending += d.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        let event: CursorEvent;
        try {
          event = JSON.parse(line) as CursorEvent;
        } catch {
          continue;
        }
        if (blocked) continue;
        void options?.onProviderStreamEvent?.(event, model);
        if (event.type === "thinking" && event.subtype === "delta") append("thinking", event.text ?? "");
        else if (event.type === "thinking" && event.subtype === "completed") close();
        // Partial deltas carry a timestamp; the untimestamped assistant event repeats the whole text.
        else if (event.type === "assistant" && event.timestamp_ms !== undefined) {
          const delta = (event.message?.content ?? []).map((c) => c.text ?? "").join("");
          // Before Cursor runs one of its own tools it repeats the segment so far as one message; skip that copy.
          if (segment && delta === segment) {
            segment = "";
            continue;
          }
          segment += delta;
          addText(delta);
        } else if (event.type === "tool_call" && event.subtype === "started") {
          const tool = describeCursorTool(event.tool_call);
          if (!writable && !tool.readOnly) {
            // ponytail: killed on "started"; a fast write could land first. Ask mode is the main guard.
            blocked = tool.name;
            child.kill();
            continue;
          }
          // Shown in the transcript so the next (stateless) turn knows what Cursor already did.
          addText(`${raw && !raw.endsWith("\n") ? "\n" : ""}\`⚙ ${tool.line.slice(0, 200)}\`\n`);
        } else if (event.type === "result") result = event;
      }
    });

    const code = await new Promise<number>((resolve) => {
      child.on("error", (err: NodeJS.ErrnoException) => {
        stderr += err.code === "ENOENT" ? `Cursor CLI not found. ${INSTALL_HINT}` : err.message;
        resolve(1);
      });
      child.on("close", (c) => resolve(c ?? 1));
    });
    options?.signal?.removeEventListener("abort", onAbort);
    if (options?.signal?.aborted) return fail("aborted", "Request was aborted");
    if (blocked) return fail("error", `Read-only session: stopped Cursor's ${blocked} tool.`);
    if (code !== 0 || !result || result.is_error) {
      return fail("error", stripAnsi(result?.result || stderr).trim() || `cursor-agent exited with code ${code}`);
    }

    const parsed = parseToolCalls(raw);
    const { calls, leftover } = parsed;
    append("text", visibleText(raw).slice(shown) + leftover);
    close();
    for (const call of calls) {
      output.content.push(call);
      const index = output.content.length - 1;
      stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: output });
    }
    const u = result?.usage ?? {};
    output.usage.input = u.inputTokens ?? 0;
    output.usage.output = u.outputTokens ?? 0;
    output.usage.cacheRead = u.cacheReadTokens ?? 0;
    output.usage.cacheWrite = u.cacheWriteTokens ?? 0;
    output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
    output.stopReason = calls.length ? "toolUse" : "stop";
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  })().catch((err: unknown) => fail("error", err instanceof Error ? err.message : String(err)));

  return stream;
}

const MODEL_NAMES: Record<(typeof CURSOR_MODELS)[number], string> = {
  "grok-4.7-high": "Grok 4.7 High (Cursor)",
  "grok-4.7-medium": "Grok 4.7 Medium (Cursor)",
  "grok-4.7-low": "Grok 4.7 Low (Cursor)",
  "grok-4.7-xhigh": "Grok 4.7 Extra High (Cursor)",
};

/** Config for pi.registerProvider: Grok models through Cursor, signed in with `/login cursor`. */
export const cursorProvider = {
  name: "Cursor",
  baseUrl: "cursor-agent://local",
  api: "cursor-agent",
  streamSimple: streamCursor,
  models: CURSOR_MODELS.map((id) => ({
    id,
    name: MODEL_NAMES[id],
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 32_000,
  })),
  oauth: {
    name: "Cursor",
    isSubscription: true,
    async login(callbacks: { onAuth(info: { url: string; instructions?: string }): void; onProgress?(msg: string): void }) {
      return cursorLogin(
        (url) => callbacks.onAuth({ url, instructions: "Sign in to Cursor in the browser, then come back here." }),
        callbacks.onProgress,
      );
    },
    async refreshToken<T>(credentials: T) {
      return credentials;
    },
    getApiKey: () => "cursor-agent",
  },
};
