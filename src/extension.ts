// Built-in grokbot extension for pi: Grok-native tools plus grokbot branding.
import { Type } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  keyHint,
  rawKeyHint,
  VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  createImage,
  createProvider,
  createVideo,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  type Result,
  search,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type XaiProvider,
} from "./xai.js";
import { CURSOR_PROVIDER, cursorProvider } from "./cursor.js";
import { VERSION } from "./setup.js";
import { registerSkillSearch } from "./skills.js";
import { registerBotProvider } from "./bot-provider.js";

const oneOf = <T extends string>(values: readonly T[], description?: string) =>
  Type.Union(
    values.map((v) => Type.Literal(v)),
    { description },
  );

async function xaiFor(ctx: ExtensionContext): Promise<XaiProvider> {
  const key = await ctx.modelRegistry.getApiKeyForProvider("xai");
  if (!key) throw new Error(
      "This tool needs xAI credentials (a Cursor sign-in covers chat only). Run /login and pick xAI, or set XAI_API_KEY.",
    );
  return createProvider(key);
}

function toToolResult(result: Result) {
  if (!result.ok) throw new Error(result.text);
  return { content: [{ type: "text" as const, text: result.text }], details: undefined };
}

const webSearch = defineTool({
  name: "web_search",
  label: "Web search",
  description:
    "Search the live web via Grok. Returns a synthesized answer with source URLs. Use for current docs, news, releases, prices.",
  promptSnippet: "web_search: live web search with cited sources",
  parameters: Type.Object({
    query: Type.String({ description: "What to search for" }),
    allowed_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "Only these domains" })),
    excluded_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "Never these domains" })),
  }),
  async execute(_id, p, signal, _onUpdate, ctx) {
    return toToolResult(
      await search(
        await xaiFor(ctx),
        "web",
        p.query,
        { allowedDomains: p.allowed_domains, excludedDomains: p.excluded_domains },
        signal,
      ),
    );
  },
});

const xSearch = defineTool({
  name: "x_search",
  label: "X search",
  description:
    "Real-time search of X (Twitter) posts via Grok: discussions, sentiment, announcements. Returns a synthesized answer with post URLs.",
  promptSnippet: "x_search: real-time X (Twitter) search",
  parameters: Type.Object({
    query: Type.String({ description: "What to search for on X" }),
    handles: Type.Optional(Type.Array(Type.String(), { maxItems: 10, description: "Only these handles (no @)" })),
    excluded_handles: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
    from_date: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
    to_date: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
  }),
  async execute(_id, p, signal, _onUpdate, ctx) {
    return toToolResult(
      await search(
        await xaiFor(ctx),
        "x",
        p.query,
        { allowedXHandles: p.handles, excludedXHandles: p.excluded_handles, fromDate: p.from_date, toDate: p.to_date },
        signal,
      ),
    );
  },
});

const generateImage = defineTool({
  name: "generate_image",
  label: "Generate image",
  description:
    "Generate an image from text with Grok Imagine, or edit an existing image (pass source). Saves files and returns their paths.",
  promptSnippet: "generate_image: create or edit images",
  parameters: Type.Object({
    prompt: Type.String(),
    source: Type.Optional(Type.String({ description: "Path or URL of an image to edit" })),
    aspect_ratio: Type.Optional(oneOf(IMAGE_ASPECT_RATIOS)),
    resolution: Type.Optional(oneOf(IMAGE_RESOLUTIONS)),
    n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    output_path: Type.Optional(Type.String({ description: "Default: .grokbot/generated-media/" })),
  }),
  async execute(_id, p, signal, _onUpdate, ctx) {
    return toToolResult(await createImage(await xaiFor(ctx), p, ctx.cwd, signal));
  },
});

const generateVideo = defineTool({
  name: "generate_video",
  label: "Generate video",
  description:
    "Generate a short video from text with Grok Imagine, or animate an image (pass source). Slow. Saves the file and returns its path.",
  promptSnippet: "generate_video: create short videos",
  parameters: Type.Object({
    prompt: Type.String(),
    source: Type.Optional(Type.String({ description: "Path or URL of an image to animate" })),
    duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 15, description: "Seconds" })),
    aspect_ratio: Type.Optional(oneOf(VIDEO_ASPECT_RATIOS)),
    resolution: Type.Optional(oneOf(VIDEO_RESOLUTIONS)),
    output_path: Type.Optional(Type.String()),
  }),
  async execute(_id, p, signal, _onUpdate, ctx) {
    return toToolResult(await createVideo(await xaiFor(ctx), p, ctx.cwd, signal));
  },
});

/** grokbot only talks to Grok: /login offers Cursor first, then xAI (whose own menu has SuperGrok/X Premium and API key). */
export const LOGIN_CHOICES = [
  ["Cursor (Grok with your Cursor account)", "/login cursor"],
  ["xAI (SuperGrok, X Premium or API key)", "/login xai"],
] as const;

export function isBareLogin(text: string): boolean {
  return text.trim() === "/login";
}

/** pi's editor with a Grok-only /login menu (built-in slash commands run before extensions, so it is intercepted here). */
class GrokEditor extends CustomEditor {
  constructor(select: (title: string, options: string[]) => Promise<string | undefined>, ...args: ConstructorParameters<typeof CustomEditor>) {
    super(...args);
    let wrapped: ((text: string) => unknown) | undefined;
    // pi assigns onSubmit after constructing the editor; wrap whatever it assigns.
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      get: () => wrapped,
      set: (handler?: (text: string) => unknown) => {
        wrapped =
          handler &&
          ((text: string) => {
            if (!isBareLogin(text)) return handler(text);
            void select("Sign in to grokbot:", LOGIN_CHOICES.map(([label]) => label)).then((picked) => {
              const command = LOGIN_CHOICES.find(([label]) => label === picked)?.[1];
              if (command) handler(command);
            });
          });
      },
    });
  }
}

const LOGO = ["▄▀▀ █▀▄ ▄▀▄ █▄▀ ██▄ ▄▀▄ ▀█▀", "▀▄█ █▀▄ ▀▄▀ █ █ █▄█ ▀▄▀  █ "];

export default async function grokbot(pi: ExtensionAPI): Promise<void> {
  for (const tool of [webSearch, xSearch, generateImage, generateVideo]) pi.registerTool(tool);
  pi.registerProvider(CURSOR_PROVIDER, cursorProvider);
  registerSkillSearch(pi);
  await registerBotProvider(pi);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle("grokbot");
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new GrokEditor((title, options) => ctx.ui.select(title, options), tui, theme, keybindings));
    ctx.ui.setHeader((_tui, theme) => ({
      render: () => [
        "",
        ` ${theme.fg("accent", LOGO[0])}  ${theme.fg("dim", `v${VERSION} · pi ${PI_VERSION}`)}`,
        ` ${theme.fg("accent", LOGO[1])}  ${[keyHint("app.interrupt", "interrupt"), rawKeyHint("/", "commands"), rawKeyHint("!", "bash"), keyHint("app.model.select", "model")].join(theme.fg("muted", " · "))}`,
        "",
        theme.fg("dim", " Grok tools: web_search · x_search · generate_image · generate_video"),
        theme.fg("dim", " Sign in: /login (Cursor or xAI) or `grokbot login`, or set XAI_API_KEY"),
        "",
      ],
      invalidate() {},
    }));
  });
}
