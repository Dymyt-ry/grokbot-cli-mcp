import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "grok-4.7";

// dist/setup.js and src/setup.ts both sit one level below package.json
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Must run before pi is imported: pi reads these when its config module loads.
export function configureEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.PI_CODING_AGENT_DIR ||= join(homedir(), ".grokbot", "agent");
  // grokbot pins its pi version, so pi's own "update pi" notice would point users at the wrong package.
  env.PI_SKIP_VERSION_CHECK ||= "1";
  if (env.GROK_API_KEY && !env.XAI_API_KEY) env.XAI_API_KEY = env.GROK_API_KEY;
}

/** Make xAI Grok the startup model unless the user already picked one. */
export function seedDefaultModel(agentDir: string): void {
  const file = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // leave a hand-edited file alone; pi reports the parse error itself
    }
  }
  if (settings.defaultProvider || settings.defaultModel) return;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...settings, defaultProvider: "xai", defaultModel: DEFAULT_MODEL }, null, 2)}\n`);
}
