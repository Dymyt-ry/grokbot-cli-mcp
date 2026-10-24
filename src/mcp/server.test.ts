import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeadlessJsonEvent } from "../headless/output";
import { createGrokMcpServer, formatAgentRun, summarizeAgentEvents } from "./server";

vi.mock("../utils/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/settings")>()),
  getApiKey: () => process.env.TEST_GROK_KEY,
}));

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGrokMcpServer();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("grokbot MCP server", () => {
  afterEach(() => {
    delete process.env.TEST_GROK_KEY;
  });

  it("exposes the Grok tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
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

  it("lists models without an API key", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "grok_models", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("grok-4.3");
  });

  it("returns a tool error (not a protocol error) when the API key is missing", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "grok_ask", arguments: { prompt: "hi" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No Grok API key");
  });

  it("rejects a missing directory", async () => {
    process.env.TEST_GROK_KEY = "x";
    const client = await connect();
    const result = await client.callTool({
      name: "grok_generate_image",
      arguments: { prompt: "cat", directory: "/definitely/not/here" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Directory does not exist");
  });
});

describe("summarizeAgentEvents", () => {
  it("folds the headless JSON stream into answer, tools, session and cost", () => {
    const tc = (name: string) => ({ id: name, type: "function" as const, function: { name, arguments: "{}" } });
    const events: HeadlessJsonEvent[] = [
      { type: "step_start", sessionID: "s1", stepNumber: 1, timestamp: 0 },
      { type: "text", sessionID: "s1", stepNumber: 1, text: "Looking.", timestamp: 0 },
      { type: "tool_use", stepNumber: 1, timestamp: 0, toolCall: tc("bash"), toolResult: { success: true } },
      { type: "tool_use", stepNumber: 1, timestamp: 0, toolCall: tc("read_file"), toolResult: { success: false } },
      { type: "step_finish", stepNumber: 1, timestamp: 0, finishReason: "tool-calls", usage: { costUsdTicks: 5e7 } },
      { type: "text", stepNumber: 2, text: "Done: 3 tests fail.", timestamp: 0 },
      { type: "step_finish", stepNumber: 2, timestamp: 0, finishReason: "stop", usage: { costUsdTicks: 5e7 } },
    ];
    const run = summarizeAgentEvents(events);
    expect(run).toEqual({
      sessionId: "s1",
      answer: "Looking.\n\nDone: 3 tests fail.",
      tools: [
        { name: "bash", success: true },
        { name: "read_file", success: false },
      ],
      costUsd: 0.01,
    });
    const out = formatAgentRun(run);
    expect(out).toContain("Tools used: bash, read_file(failed)");
    expect(out).toContain("session_id: s1 | cost: $0.0100");
  });
});
