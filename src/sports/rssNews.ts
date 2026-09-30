import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { sourceQuerySchema, teamIdentitySchema, type SourceQuery, type SourceResult, type SportsSource } from "./sources";
const httpUrl = z.string().url().refine(value => {
  const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
});
export const rssConfigSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/), publisher: z.string().trim().min(1).max(200),
  league: z.enum(["NBA", "NFL"]), url: httpUrl.refine(value => value.startsWith("https://")),
  // Explicit feed scope, not a guessed association from keywords or team nicknames.
  team: teamIdentitySchema.nullable().default(null),
  timeoutMs: z.number().int().min(1).max(30000).default(10000),
  maxBytes: z.number().int().min(1024).max(2000000).default(1000000),
  maxItems: z.number().int().min(1).max(500).default(100)
}).strict();
export interface RssArticle { title: string; summary: string; url: string; publishedAt: string | null }
const text = (value: unknown): string => typeof value === "string" ? value : "";
function plain(value: unknown, limit: number) {
  return text(value).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "").replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, limit);
}
/** RSS 2.0 only. A missing date stays unknown rather than becoming retrieval time. */
export function parseRss(xml: string, maxItems: number): { articles: RssArticle[]; limitations: string[] } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("INVALID_RSS_XML");
  const document = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: true }).parse(xml);
  const channel = document?.rss?.channel;
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) throw new Error("UNSUPPORTED_FEED_FORMAT");
  const items: unknown[] = channel.item === undefined ? [] : Array.isArray(channel.item) ? channel.item : [channel.item];
  const limitations = items.length > maxItems ? ["FEED_ITEM_LIMIT"] : [];
  const articles: RssArticle[] = [], seen = new Set<string>();
  for (const raw of items.slice(0, maxItems)) {
    if (!raw || typeof raw !== "object") { limitations.push("INVALID_ARTICLE"); continue; }
    const item = raw as Record<string, unknown>, title = plain(item.title, 500);
    const link = httpUrl.safeParse(text(item.link).trim());
    if (!title || !link.success) { limitations.push("INVALID_ARTICLE"); continue; }
    const identity = new URL(link.data); identity.hash = "";
    if (seen.has(identity.href)) continue;
    seen.add(identity.href);
    const zones: Record<string, string> = { EST: "-0500", EDT: "-0400", CST: "-0600", CDT: "-0500", MST: "-0700", MDT: "-0600", PST: "-0800", PDT: "-0700", UT: "+0000" };
    const date = text(item.pubDate).trim().replace(/\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT|UT)$/i, zone => zones[zone.toUpperCase()]);
    // Require an explicit timezone; avoid machine-local interpretation of ambiguous dates.
    const millis = /(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})$/i.test(date) ? Date.parse(date) : NaN;
    articles.push({ title, summary: plain(item.description, 4000), url: link.data,
      publishedAt: Number.isFinite(millis) ? new Date(millis).toISOString() : null });
  }
  return { articles, limitations: [...new Set(limitations)] };
}

export class RssNewsSource implements SportsSource {
  private readonly config: z.infer<typeof rssConfigSchema>;
  constructor(config: unknown, private readonly transport: typeof fetch = fetch, private readonly clock: () => number = Date.now) {
    this.config = rssConfigSchema.parse(config);
  }
  async read(input: SourceQuery, signal?: AbortSignal): Promise<SourceResult> {
    signal?.throwIfAborted();
    const query = sourceQuerySchema.parse(input), config = this.config;
    if (query.kind !== "news" || (query.league ?? "NBA") !== config.league) throw new Error("SPORTS_SOURCE_SCOPE_MISMATCH");
    if (query.team && (!config.team || query.team.provider !== config.team.provider || query.team.id !== config.team.id)) throw new Error("SPORTS_TEAM_UNRESOLVED");
    const result: SourceResult = { schemaVersion: "chatagent-sports-source-result-v1", mode: "live", query,
      source: { id: config.id, url: config.url, retrievedAt: new Date(this.clock()).toISOString(), dataAsOf: null },
      coverage: "unavailable", freshness: "unknown", limitations: ["UNKNOWN_FRESHNESS"], errorCode: null,
      records: [], canAdvanceCheckpoint: false };
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, config.timeoutMs);
    try {
      const response = await this.transport(config.url, { signal: controller.signal, redirect: "error", headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
      if (!response.ok) {
        await response.body?.cancel();
        result.errorCode = response.status === 429 ? "RATE_LIMITED" : [401, 403].includes(response.status) ? "ACCESS_DENIED" : "UNAVAILABLE";
        result.limitations.push("HTTP_" + response.status); return result;
      }
      if (!response.body) throw new Error("EMPTY_FEED");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > config.maxBytes) { await reader.cancel(); throw new Error("FEED_TOO_LARGE"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const parsed = parseRss(Buffer.concat(chunks).toString("utf8"), config.maxItems);
      result.coverage = "partial";
      result.limitations.push("RSS_WINDOW_COVERAGE_UNVERIFIED", ...parsed.limitations);
      const captured = this.clock(); result.source.retrievedAt = new Date(captured).toISOString();
      for (const article of parsed.articles) {
        if (article.publishedAt === null) { result.limitations.push("PUBLICATION_TIME_UNKNOWN"); continue; }
        const time = Date.parse(article.publishedAt);
        if (time > captured) { result.limitations.push("FUTURE_PUBLICATION_TIME"); continue; }
        if (time < Date.parse(query.window.fromInclusive) || time >= Date.parse(query.window.toExclusive)) continue;
        const identity = new URL(article.url); identity.hash = "";
        result.records.push({ id: createHash("sha256").update(identity.href).digest("hex"), kind: "news",
          publishedAt: article.publishedAt, teams: config.team ? [config.team] : [], headline: article.title,
          summary: article.summary, provenance: { sourceId: config.id, publisher: config.publisher, url: article.url, updatedAt: null } });
      }
      result.records.sort((a, b) => (b.kind === "news" ? b.publishedAt : "").localeCompare(a.kind === "news" ? a.publishedAt : ""));
      if (result.records.length > query.limit) result.limitations.push("RESULT_LIMIT");
      result.records = result.records.slice(0, query.limit);
      result.limitations = [...new Set(result.limitations)];
      return result;
    } catch {
      signal?.throwIfAborted();
      result.errorCode = "UNAVAILABLE"; result.limitations.push(controller.signal.aborted ? "SOURCE_TIMEOUT" : "INVALID_OR_UNAVAILABLE_FEED");
      return result;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
}
