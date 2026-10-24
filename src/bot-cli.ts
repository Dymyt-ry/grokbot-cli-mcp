// `grokbot bot list|send|read`: talk to your bots in the official Grok Bot app from a terminal.
import { listBots, pickBot, readBot, sendToBot } from "./bots.js";

const USAGE = `Usage:
  grokbot bot list                         your bots in the Grok Bot app
  grokbot bot send [--bot NAME] [--no-wait] MESSAGE
                                           message a bot (default: your main bot) and print its replies
  grokbot bot read [--bot NAME] [N]        last N messages of a bot's chat (default 10)`;

function take(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args.splice(i, 2)[1];
}

export async function botCommand(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    if (cmd === "list") {
      for (const b of await listBots()) console.log(`${b.name}${b.description ? `  (${b.description})` : ""}`);
      return 0;
    }
    if (cmd === "send" || cmd === "read") {
      const ref = take(args, "--bot");
      const noWait = args.includes("--no-wait");
      const rest = args.filter((a) => a !== "--no-wait");
      const bot = pickBot(await listBots(), ref);
      if (cmd === "read") {
        for (const e of await readBot(bot, Number(rest[0]) || 10)) console.log(`${e.from === "you" ? "you" : bot.name}: ${e.text}\n`);
        return 0;
      }
      const text = rest.join(" ").trim();
      if (!text) throw new Error("Nothing to send.");
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      if (!noWait) process.stderr.write(`→ ${bot.name} (the reply also shows in the Grok Bot app)\n`);
      const { done } = await sendToBot(bot, text, {
        wait: !noWait,
        signal: controller.signal,
        onReply: (e) => console.log(`${e.text}\n`),
      });
      if (!noWait && !done) process.stderr.write(`${bot.name} is still working; check the app or \`grokbot bot read\`.\n`);
      return 0;
    }
    console.log(USAGE);
    return cmd ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
