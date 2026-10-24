// xAI capabilities that pi's chat provider doesn't cover: live search and media generation.
// Ported from superagent-ai/grok-cli (MIT).
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
      writeFileSync(path, img.uint8Array, { flag: "wx" });
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
      writeFileSync(path, vid.uint8Array, { flag: "wx" });
      return path;
    });
    return { ok: true, text: summarize("video", paths) };
  } catch (err) {
    return fail("Video generation failed", err);
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

// Tool arguments come from a model (and through MCP, from whatever steers it), so `source` and `output_path`
// are untrusted: sources must really be images, downloads must reach public hosts, outputs stay inside cwd.

/** Real image type from magic bytes, so a "source image" can't be ~/.ssh/id_rsa or a .env file. */
export function sniffImage(data: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
  if (data[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export async function loadImage(source: string, cwd: string, signal?: AbortSignal) {
  const data = /^https?:\/\//i.test(source) ? await fetchImage(source, signal) : readLocalImage(source, cwd);
  const mediaType = sniffImage(data);
  if (!mediaType) throw new Error(`Not a PNG, JPEG, GIF or WebP image: ${source}`);
  return { data, mediaType, dataUrl: `data:${mediaType};base64,${Buffer.from(data).toString("base64")}` };
}

function readLocalImage(source: string, cwd: string): Uint8Array {
  const path = resolve(cwd, source);
  if (!existsSync(path)) throw new Error(`Source image not found: ${source}`);
  if (statSync(path).size > MAX_SOURCE_BYTES) throw new Error(`Source image is larger than 20 MB: ${source}`);
  return readFileSync(path);
}

// Separate lists: in one BlockList the ::ffff:0:0/96 rule would also match every IPv4 address.
const PRIVATE_V4 = new BlockList();
const PRIVATE_V6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3], // multicast + reserved, up to 255.255.255.255
] as const) {
  PRIVATE_V4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 127], // unspecified and loopback
  ["::ffff:0:0", 96], // IPv4-mapped, in any notation (the URL parser rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1)
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["2002::", 16], // 6to4 embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  PRIVATE_V6.addSubnet(net, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  return isIP(address) === 4 ? PRIVATE_V4.check(address, "ipv4") : PRIVATE_V6.check(address, "ipv6");
}

async function fetchImage(source: string, signal?: AbortSignal): Promise<Uint8Array> {
  const url = new URL(source);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  // ponytail: checked at lookup time, so DNS rebinding between lookup and fetch is not covered; pin the IP if that matters.
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`Refusing to download from a private or local address: ${url.host}`);
  }
  const res = await fetch(url, { signal, redirect: "error" });
  if (!res.ok) throw new Error(`Source image download failed: ${res.status} ${res.statusText}`);
  if (!res.headers.get("content-type")?.startsWith("image/")) throw new Error(`URL is not an image: ${source}`);
  if (Number(res.headers.get("content-length")) > MAX_SOURCE_BYTES) throw new Error("Source image is larger than 20 MB");
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length > MAX_SOURCE_BYTES) throw new Error("Source image is larger than 20 MB");
  return data;
}

/** Where to save generated media; never outside cwd. Write with flag "wx" so existing files are not overwritten. */
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
  assertInside(cwd, path);
  mkdirSync(dirname(path), { recursive: true });
  assertInside(realpathSync(cwd), join(realpathSync(dirname(path)), basename(path))); // no escape via symlinked dirs
  return path;
}

function assertInside(root: string, path: string): void {
  const rel = relative(resolve(root), path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`output_path must be inside the working directory (${root})`);
  }
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
