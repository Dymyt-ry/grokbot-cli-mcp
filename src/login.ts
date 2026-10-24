// `grokbot login` / `grokbot logout` outside the TUI. Same credential store as the TUI's /login.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";

/** Command that opens a URL in the default browser, without a shell. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

function openBrowser(url: string): void {
  const [cmd, args] = browserCommand(url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {}); // no browser (SSH, CI): the printed link is enough
    child.unref();
  } catch {
    // same as above
  }
}

async function ask(prompt: AuthPrompt): Promise<string> {
  // Output goes through a mutable stream so a secret prompt can stop echoing what is typed.
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  try {
    if (prompt.type === "select") {
      prompt.options.forEach((o, i) => process.stderr.write(`  ${i + 1}) ${o.label}\n`));
      const pick = Number(await rl.question(`${prompt.message} [1]: `)) || 1;
      return (prompt.options[pick - 1] ?? prompt.options[0]).id;
    }
    if (prompt.type === "secret") {
      process.stderr.write(`${prompt.message} `);
      muted = true;
      const answer = await rl.question("");
      muted = false;
      process.stderr.write("\n");
      return answer.trim();
    }
    return (await rl.question(`${prompt.message} `)).trim();
  } finally {
    rl.close();
  }
}

function show(event: AuthEvent): void {
  if (event.type === "device_code") {
    process.stderr.write(
      `\nOpen ${event.verificationUri}\nand confirm the code: ${event.userCode}\n` +
        "Sign in there with Google, X or email (a SuperGrok or X Premium subscription unlocks Grok).\n\nWaiting for you to confirm...\n",
    );
    openBrowser(event.verificationUri);
  } else if (event.type === "auth_url") {
    process.stderr.write(`\nOpen ${event.url}\n${event.instructions ?? ""}\n`);
    openBrowser(event.url);
  } else {
    process.stderr.write(`${event.message}\n`);
  }
}

export async function login(args: string[]): Promise<void> {
  const useKey = args.includes("--api-key");
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create();
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  try {
    await runtime.login("xai", useKey ? "api_key" : "oauth", { signal: controller.signal, prompt: ask, notify: show });
    process.stderr.write("Signed in to xAI. Run `grokbot` to start, or use `grokbot mcp` from Claude Code.\n");
  } catch (err) {
    process.stderr.write(`Login failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

export async function logout(): Promise<void> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  await (await ModelRuntime.create()).logout("xai");
  process.stderr.write("Signed out of xAI.\n");
}
