#!/usr/bin/env node
import { configureEnv, seedDefaultModel, VERSION } from "./setup.js";

const args = process.argv.slice(2);
configureEnv();

if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  // Read from package.json: importing pi just for its VERSION takes about a second.
  const { readFileSync } = await import("node:fs");
  const piPkg = new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
  console.log(`grokbot ${VERSION} (pi ${JSON.parse(readFileSync(piPkg, "utf8")).version})`);
  process.exit(0);
}

if (args[0] === "login" || args[0] === "logout") {
  const auth = await import("./login.js");
  await (args[0] === "login" ? auth.login(args.slice(1)) : auth.logout());
  process.exit();
}

if (args[0] === "bot") {
  const { botCommand } = await import("./bot-cli.js");
  process.exitCode = await botCommand(args.slice(1));
  process.exit();
}

// `grokbot mcp` (or `mcp serve`) runs our server; `grokbot mcp list|login|logout` stays pi's MCP client command.
if (args[0] === "mcp" && (args.length === 1 || args[1] === "serve")) {
  // stdout carries the MCP protocol; keep stray logs off it.
  console.log = console.error;
  const { startMcpServer } = await import("./mcp.js");
  await startMcpServer();
} else {
  seedDefaultModel(process.env.PI_CODING_AGENT_DIR as string);
  // pi's own bin calls setupCli() (HTTP dispatcher, warnings) before main(); it isn't in the package exports.
  const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { setupCli } = await import(new URL("./cli/setup.js", piEntry).href);
  setupCli();
  process.title = "grokbot";
  const { main } = await import("@earendil-works/pi-coding-agent");
  const { default: grokExtension } = await import("./extension.js");
  await main(args, { extensionFactories: [{ name: "grokbot", factory: grokExtension, hidden: true }] });
}
