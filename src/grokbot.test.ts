import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import grokbotExtension from "./extension.js";
import { type AgentEvent, agentArgs, createGrokMcpServer, formatAgentRun, summarizeAgentEvents } from "./mcp.js";
import { browserCommand } from "./login.js";
import { configureEnv, DEFAULT_MODEL, seedDefaultModel } from "./setup.js";
import { isPrivateAddress, loadImage, outputPath, sniffImage } from "./xai.js";

const tmp = () => mkdtempSync(join(tmpdir(), "grokbot-test-"));

beforeAll(() => {
  // No credentials and no network: every test runs as a fresh, signed-out install.
  delete process.env.XAI_API_KEY;
  delete process.env.GROK_API_KEY;
  process.env.PI_CODING_AGENT_DIR = tmp();
  process.env.PI_OFFLINE = "1";
});

describe("configureEnv", () => {
  it("defaults the agent dir, also when the variable is empty", () => {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: "" };
    configureEnv(env);
    expect(env.PI_CODING_AGENT_DIR).toMatch(/[\\/]\.grokbot[\\/]agent$/);
  });

  it("keeps a user-set agent dir and maps GROK_API_KEY to XAI_API_KEY", () => {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: "/x", GROK_API_KEY: "k" };
    configureEnv(env);
    expect(env).toMatchObject({ PI_CODING_AGENT_DIR: "/x", XAI_API_KEY: "k" });
  });

  it("does not override an explicit XAI_API_KEY", () => {
    const env: NodeJS.ProcessEnv = { GROK_API_KEY: "grok", XAI_API_KEY: "xai" };
    configureEnv(env);
    expect(env.XAI_API_KEY).toBe("xai");
  });
});

describe("seedDefaultModel", () => {
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

  it("makes Grok the default on first run", () => {
    const dir = join(tmp(), "agent");
    seedDefaultModel(dir);
    expect(read(dir)).toEqual({ defaultProvider: "xai", defaultModel: DEFAULT_MODEL });
  });

  it("keeps other settings and never overrides a chosen model", () => {
    const dir = tmp();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark" }));
    seedDefaultModel(dir);
    expect(read(dir)).toEqual({ theme: "dark", defaultProvider: "xai", defaultModel: DEFAULT_MODEL });

    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
    seedDefaultModel(dir);
    expect(read(dir)).toEqual({ defaultProvider: "anthropic" });
  });

  it("leaves an unparsable settings file untouched", () => {
    const dir = tmp();
    writeFileSync(join(dir, "settings.json"), "{ oops");
    seedDefaultModel(dir);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{ oops");
  });
});

describe("pi integration", () => {
  it("still ships the non-exported setupCli that cli.ts imports", async () => {
    const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
    expect(existsSync(fileURLToPath(new URL("./cli/setup.js", entry)))).toBe(true);
    const pi = await import("@earendil-works/pi-coding-agent");
    expect(typeof pi.main).toBe("function");
  });

  it("registers the Grok tools and a header", () => {
    const tools: string[] = [];
    const events: string[] = [];
    const fakePi = {
      registerTool: (t: { name: string }) => tools.push(t.name),
      on: (name: string) => events.push(name),
    };
    grokbotExtension(fakePi as never);
    expect(tools).toEqual(["web_search", "x_search", "generate_image", "generate_video"]);
    expect(events).toContain("session_start");
  });
});

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([createGrokMcpServer().connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("MCP server", () => {
  it("exposes the Grok tools", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "grok_agent",
      "grok_ask",
      "grok_generate_image",
      "grok_generate_video",
      "grok_models",
      "grok_search_web",
      "grok_search_x",
    ]);
  });

  it("marks grok_agent destructive so hosts ask before running it", async () => {
    const { tools } = await (await connect()).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.grok_agent).toMatchObject({ destructiveHint: true });
    expect(byName.grok_search_x).toMatchObject({ readOnlyHint: true });
  });

  it("restricts a read_only agent to read/search tools without MCP", () => {
    expect(agentArgs({ prompt: "-x", readOnly: true })).toEqual([
      "--mode",
      "json",
      "--tools",
      "read,grep,find,ls,web_search,x_search",
      "--no-mcp",
      "--",
      "-x",
    ]);
    expect(agentArgs({ prompt: "p", session: "s", model: "grok-4.3" })).toEqual([
      "--mode",
      "json",
      "--session",
      "s",
      "--provider",
      "xai",
      "--model",
      "grok-4.3",
      "--",
      "p",
    ]);
  });

  it("lists models without credentials", async () => {
    const res = await (await connect()).callTool({ name: "grok_models", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("grok-4");
  });

  it("returns a tool error, not a protocol error, when signed out", async () => {
    const res = await (await connect()).callTool({ name: "grok_ask", arguments: { prompt: "hi" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("No xAI credentials");
  });

  it("rejects a missing directory before calling xAI", async () => {
    process.env.XAI_API_KEY = "test";
    try {
      const res = await (await connect()).callTool({
        name: "grok_generate_image",
        arguments: { prompt: "cat", directory: join(tmp(), "nope") },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain("Directory does not exist");
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });
});

describe("summarizeAgentEvents", () => {
  const assistant = (text: string, cost: number, extra: object = {}) => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: cost } }, ...extra },
  });

  it("folds pi's JSON stream into answer, tools, session and cost", () => {
    const events: AgentEvent[] = [
      { type: "session", version: 3, id: "s-1", cwd: "/p" },
      { type: "message_end", message: { role: "user", content: "fix it" } },
      assistant("Looking.", 0.004),
      { type: "tool_execution_end", toolName: "bash", isError: false },
      { type: "tool_execution_end", toolName: "read", isError: true },
      assistant("Done: 3 tests fail.", 0.006),
    ];
    const run = summarizeAgentEvents(events);
    expect(run).toEqual({
      sessionId: "s-1",
      answer: "Done: 3 tests fail.",
      tools: [
        { name: "bash", ok: true },
        { name: "read", ok: false },
      ],
      costUsd: 0.01,
    });
    expect(formatAgentRun(run)).toBe(
      "Done: 3 tests fail.\n\nTools used: bash, read(failed)\n\nsession_id: s-1 | cost: $0.0100",
    );
  });

  it("reports provider errors", () => {
    const run = summarizeAgentEvents([assistant("", 0, { stopReason: "error", errorMessage: "401 bad key" })]);
    expect(run.error).toBe("401 bad key");
    expect(formatAgentRun(run)).toContain("Error: 401 bad key");
  });
});

describe("outputPath", () => {
  it("numbers multiple outputs and adds the right extension", () => {
    const cwd = tmp();
    expect(outputPath(cwd, "image", "image/jpeg", "out/cat", 1, 2, "r")).toBe(join(cwd, "out", "cat-2.jpg"));
    expect(outputPath(cwd, "video", undefined, undefined, 0, 1, "r")).toBe(
      join(cwd, ".grokbot", "generated-media", "video-r.mp4"),
    );
  });
});

describe("untrusted tool arguments", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it("only accepts real images as local sources", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
    writeFileSync(join(cwd, "cat.png"), "not really a png");
    writeFileSync(join(cwd, "ok.bin"), png);
    await expect(loadImage("id_rsa", cwd)).rejects.toThrow("Not a PNG, JPEG, GIF or WebP image");
    await expect(loadImage("cat.png", cwd)).rejects.toThrow("Not a PNG");
    expect((await loadImage("ok.bin", cwd)).mediaType).toBe("image/png");
    expect(sniffImage(Buffer.from("RIFF0000WEBPVP8 "))).toBe("image/webp");
  });

  it("refuses to download from private or local addresses", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
    await expect(loadImage("http://127.0.0.1:9/cat.png", tmp())).rejects.toThrow("private or local address");
    await expect(loadImage("http://[::1]/cat.png", tmp())).rejects.toThrow("private or local address");
    await expect(loadImage("http://localhost/cat.png", tmp())).rejects.toThrow("private or local address");
    await expect(loadImage("http://[::ffff:127.0.0.1]/cat.png", tmp())).rejects.toThrow("private or local address");
    await expect(loadImage("http://2130706433/cat.png", tmp())).rejects.toThrow("private or local address");
  });

  it("keeps outputs inside the working directory", () => {
    const cwd = tmp();
    expect(() => outputPath(cwd, "image", "image/png", "../escape.png", 0, 1, "r")).toThrow("inside the working directory");
    expect(() => outputPath(cwd, "image", "image/png", join(tmpdir(), "abs.png"), 0, 1, "r")).toThrow(
      "inside the working directory",
    );
  });
});

describe("browserCommand", () => {
  it("opens the login page without a shell on every OS", () => {
    const url = "https://accounts.x.ai/oauth2/device?user_code=AB&x=1";
    expect(browserCommand(url, "darwin")).toEqual(["open", [url]]);
    expect(browserCommand(url, "linux")).toEqual(["xdg-open", [url]]);
    expect(browserCommand(url, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
  });
});
