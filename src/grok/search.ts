import { generateText, type ToolSet } from "ai";
import type { XaiProvider } from "./client";

export const RESPONSES_SEARCH_MODEL = "grok-4.20-non-reasoning";

export type SearchKind = "web_search" | "x_search";

export interface SearchFilters {
  /** web_search only */
  allowedDomains?: string[];
  excludedDomains?: string[];
  /** x_search only */
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  /** x_search only, ISO date YYYY-MM-DD */
  fromDate?: string;
  toDate?: string;
}

export async function grokSearch(
  provider: XaiProvider,
  kind: SearchKind,
  query: string,
  filters: SearchFilters = {},
  abortSignal?: AbortSignal,
  model: string = RESPONSES_SEARCH_MODEL,
): Promise<{ success: boolean; output: string }> {
  try {
    const tools: ToolSet =
      kind === "web_search"
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
    const { text, sources } = await generateText({
      model: provider.responses(model),
      maxOutputTokens: 4096,
      prompt: query,
      abortSignal,
      tools,
    });

    return { success: true, output: (text || "No search results found.") + formatSources(sources) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `${kind === "web_search" ? "Web search" : "X search"} failed: ${msg}` };
  }
}

function formatSources(sources: ReadonlyArray<{ sourceType: string; url?: string; title?: string }>): string {
  const urls = [...new Set(sources.flatMap((s) => (s.sourceType === "url" && s.url ? [s.url] : [])))];
  return urls.length > 0 ? `\n\nSources:\n${urls.map((u) => `- ${u}`).join("\n")}` : "";
}
