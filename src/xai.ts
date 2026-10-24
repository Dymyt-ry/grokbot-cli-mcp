// xAI capabilities that pi's chat provider doesn't cover: live search and media generation.
// Ported from superagent-ai/grok-cli (MIT).
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { createXai } from "@ai-sdk/xai";
import { experimental_generateVideo as generateVideo, generateImage, generateText, type ToolSet } from "ai";

export type XaiProvider = ReturnType<typeof createXai>;

export const SEARCH_MODEL = "grok-4.20-non-reasoning";
const IMAGE_MODEL = "grok-imagine-image";
const VIDEO_MODEL = "grok-imagine-video";
export const MEDIA_DIR = join(".grokbot", "generated-media");

export const IMAGE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "auto"] as const;
export const VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const IMAGE_RESOLUTIONS = ["1k", "2k"] as const;
export const VIDEO_RESOLUTIONS = ["480p", "720p"] as const;

export interface Result {
  ok: boolean;
  text: string;
}

export function createProvider(apiKey: string): XaiProvider {
  return createXai({ apiKey, baseURL: process.env.XAI_BASE_URL || "https://api.x.ai/v1" });
}

export interface SearchFilters {
  allowedDomains?: string[];
  excludedDomains?: string[];
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  fromDate?: string;
  toDate?: string;
}

export async function search(
  provider: XaiProvider,
  kind: "web" | "x",
  query: string,
  filters: SearchFilters = {},
  signal?: AbortSignal,
): Promise<Result> {
  const tools: ToolSet =
    kind === "web"
      ? {
          web_search: provider.tools.webSearch({
            allowedDomains: filters.allowedDomains,
            excludedDomains: filters.excludedDomains,
          }),
        }
      : {
          x_search: provider.tools.xSearch({
            allowedXHandles: filters.allowedXHandles,
            excludedXHandles: filters.excludedXHandles,
            fromDate: filters.fromDate,
            toDate: filters.toDate,
          }),
        };
  try {
    const { text, sources } = await generateText({
      model: provider.responses(SEARCH_MODEL),
      maxOutputTokens: 4096,
      prompt: query,
      abortSignal: signal,
      tools,
    });
    const urls = [...new Set(sources.flatMap((s) => (s.sourceType === "url" ? [s.url] : [])))];
    const cited = urls.length ? `\n\nSources:\n${urls.map((u) => `- ${u}`).join("\n")}` : "";
    return { ok: true, text: (text || "No results found.") + cited };
  } catch (err) {
    return fail(`${kind === "web" ? "Web" : "X"} search failed`, err);
  }
}

export interface ImageInput {
  prompt: string;
  source?: string;
  aspect_ratio?: (typeof IMAGE_ASPECT_RATIOS)[number];
  resolution?: (typeof IMAGE_RESOLUTIONS)[number];
  n?: number;
  output_path?: string;
}

export async function createImage(
  provider: XaiProvider,
  input: ImageInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<Result> {
  try {
    const source = input.source ? await loadImage(input.source, cwd, signal) : null;
    const res = await generateImage({
      model: provider.image(IMAGE_MODEL),
      prompt: source ? { text: input.prompt, images: [source.data] } : input.prompt,
      n: input.n,
      aspectRatio: input.aspect_ratio as `${number}:${number}` | undefined,
      abortSignal: signal,
      providerOptions: { xai: input.resolution ? { resolution: input.resolution } : {} },
    });
    const runId = stamp();
    const paths = res.images.map((img, i) => {
      const path = outputPath(cwd, "image", img.mediaType, input.output_path, i, res.images.length, runId);
      writeFileSync(path, img.uint8Array);
      return path;
    });
    return { ok: true, text: summarize("image", paths) };
  } catch (err) {
    return fail("Image generation failed", err);
  }
}

export interface VideoInput {
  prompt: string;
  source?: string;
  duration?: number;
  aspect_ratio?: (typeof VIDEO_ASPECT_RATIOS)[number];
  resolution?: (typeof VIDEO_RESOLUTIONS)[number];
  output_path?: string;
}

export async function createVideo(
  provider: XaiProvider,
  input: VideoInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<Result> {
  try {
    const source = input.source ? await loadImage(input.source, cwd, signal) : null;
    const res = await generateVideo({
      model: provider.video(VIDEO_MODEL),
      prompt: source ? { text: input.prompt, image: source.dataUrl } : input.prompt,
      duration: input.duration,
      aspectRatio: input.aspect_ratio,
      abortSignal: signal,
      providerOptions: { xai: input.resolution ? { resolution: input.resolution } : {} },
    });
    const runId = stamp();
    const paths = res.videos.map((vid, i) => {
      const path = outputPath(cwd, "video", vid.mediaType, input.output_path, i, res.videos.length, runId);
      writeFileSync(path, vid.uint8Array);
      return path;
    });
    return { ok: true, text: summarize("video", paths) };
  } catch (err) {
    return fail("Video generation failed", err);
  }
}

const MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export async function loadImage(source: string, cwd: string, signal?: AbortSignal) {
  let data: Uint8Array;
  let mediaType: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { signal });
    if (!res.ok) throw new Error(`Source image download failed: ${res.status} ${res.statusText}`);
    data = new Uint8Array(await res.arrayBuffer());
    mediaType = res.headers.get("content-type") || MEDIA_TYPES[extname(new URL(source).pathname).toLowerCase()] || "image/png";
  } else {
    const path = isAbsolute(source) ? source : resolve(cwd, source);
    if (!existsSync(path)) throw new Error(`Source image not found: ${source}`);
    data = readFileSync(path);
    mediaType = MEDIA_TYPES[extname(path).toLowerCase()] || "image/png";
  }
  return { data, mediaType, dataUrl: `data:${mediaType};base64,${Buffer.from(data).toString("base64")}` };
}

export function outputPath(
  cwd: string,
  kind: "image" | "video",
  mediaType: string | undefined,
  requested: string | undefined,
  index: number,
  total: number,
  runId: string,
): string {
  const ext = EXTENSIONS[(mediaType || "").toLowerCase()] ?? (kind === "image" ? "png" : "mp4");
  let path = requested ? resolve(cwd, requested) : join(resolve(cwd, MEDIA_DIR), `${kind}-${runId}.${ext}`);
  const current = extname(path);
  if (total > 1) path = `${current ? path.slice(0, -current.length) : path}-${index + 1}.${ext}`;
  else if (!current) path = `${path}.${ext}`;
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function summarize(kind: string, paths: string[]): string {
  return [`Generated ${paths.length} ${kind}${paths.length === 1 ? "" : "s"}:`, ...paths.map((p) => `- ${p}`)].join("\n");
}

function fail(prefix: string, err: unknown): Result {
  return { ok: false, text: `${prefix}: ${err instanceof Error ? err.message : String(err)}` };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
