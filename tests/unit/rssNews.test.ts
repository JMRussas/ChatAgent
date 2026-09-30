import { describe, expect, it, vi } from "vitest";
import { parseRss, RssNewsSource } from "../../src/sports/rssNews";
import { sportsRecordSchema, type SourceQuery } from "../../src/sports/sources";
const config = { id: "test-news", publisher: "Test publisher", league: "NFL", url: "https://example.invalid/rss" };
const query: SourceQuery = { league: "NFL", kind: "news", team: null, now: "2026-09-30T12:00:00Z",
  window: { fromInclusive: "2026-09-29T12:00:00Z", toExclusive: "2026-09-30T12:00:00Z" }, limit: 5, maxAgeMs: 10000 };
const item = (date = "Wed, 30 Sep 2026 10:00:00 GMT", link = "https://example.invalid/story") => `<item><title>Test &amp; headline</title><description><![CDATA[<p>Reported excerpt</p>]]></description><link>${link}</link><pubDate>${date}</pubDate></item>`;
const feed = (items = item()) => `<rss version="2.0"><channel><title>Test</title>${items}</channel></rss>`;
const transport = (xml = feed()) => vi.fn<typeof fetch>(async () => new Response(xml));
const clock = () => Date.parse(query.now);
describe("RSS source adapted from forex ingestion", () => {
  it("interprets RSS timezone abbreviations as explicit offsets, independent of local daylight saving", () => {
    expect(parseRss(feed(item("Wed, 30 Sep 2026 10:00:00 EST")), 100).articles[0].publishedAt).toBe("2026-09-30T15:00:00.000Z");
    expect(parseRss(feed(item("Wed, 30 Sep 2026 10:00:00 EDT")), 100).articles[0].publishedAt).toBe("2026-09-30T14:00:00.000Z");
  });
  it("normalizes attributed feed excerpts and deduplicates links without fragment differences", async () => {
    const source = new RssNewsSource(config, transport(feed(item() + item(undefined, "https://example.invalid/story#comments"))), clock);
    const result = await source.read(query);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ headline: "Test & headline", summary: "Reported excerpt", publishedAt: "2026-09-30T10:00:00.000Z", provenance: { publisher: "Test publisher", url: "https://example.invalid/story", updatedAt: null } });
    expect(sportsRecordSchema.safeParse(result.records[0]).success).toBe(true);
    expect(result.coverage).toBe("partial"); expect(result.freshness).toBe("unknown"); expect(result.canAdvanceCheckpoint).toBe(false);
  });
  it("keeps missing/ambiguous dates unknown and excludes them from time-bounded results", async () => {
    const xml = feed(item("")); expect(parseRss(xml, 100).articles[0].publishedAt).toBeNull();
    expect(parseRss(feed(item("2026-09-30 10:00:00")), 100).articles[0].publishedAt).toBeNull();
    const result = await new RssNewsSource(config, transport(xml), clock).read(query);
    expect(result.records).toEqual([]); expect(result.limitations).toContain("PUBLICATION_TIME_UNKNOWN");
  });
  it("distinguishes an empty successful feed from HTTP failure and invalid XML", async () => {
    const empty = await new RssNewsSource(config, transport(feed("")), clock).read(query);
    expect(empty.errorCode).toBeNull(); expect(empty.coverage).toBe("partial");
    const bad = await new RssNewsSource(config, transport("<html>wrong format</html>"), clock).read(query);
    expect(bad.coverage).toBe("unavailable");
    const failed = await new RssNewsSource(config, async () => new Response("secret detail", { status: 429 }), clock).read(query);
    expect(failed.errorCode).toBe("RATE_LIMITED"); expect(JSON.stringify(failed)).not.toContain("secret detail");
  });
  it("requires matching configured league/team scope before fetching", async () => {
    const read = transport(), source = new RssNewsSource(config, read, clock);
    await expect(source.read({ ...query, league: "NBA" })).rejects.toThrow();
    await expect(source.read({ ...query, team: { provider: "balldontlie-nfl", id: "1", name: "Test" } })).rejects.toThrow("SPORTS_TEAM_UNRESOLVED");
    expect(read).not.toHaveBeenCalled();
  });
  it("applies exact window bounds, future-date checks and result limits", async () => {
    const xml = feed(item("Tue, 29 Sep 2026 12:00:00 GMT", "https://example.invalid/1") + item(undefined, "https://example.invalid/2") + item("Wed, 30 Sep 2026 12:00:00 GMT", "https://example.invalid/3") + item("Thu, 01 Oct 2026 12:00:00 GMT", "https://example.invalid/4"));
    const result = await new RssNewsSource(config, transport(xml), clock).read({ ...query, limit: 1 });
    expect(result.records).toHaveLength(1); expect(result.records[0].provenance.url).toBe("https://example.invalid/2");
    expect(result.limitations).toContain("RESULT_LIMIT"); expect(result.limitations).toContain("FUTURE_PUBLICATION_TIME");
  });
  it("rejects entity declarations and unsafe links and bounds item/body sizes", async () => {
    expect(() => parseRss('<!DOCTYPE rss [<!ENTITY a "b">]>' + feed(), 10)).toThrow();
    expect(parseRss(feed(item(undefined, "javascript:alert(1)")), 10).articles).toEqual([]);
    expect(parseRss(feed(item() + item(undefined, "https://example.invalid/2")), 1).limitations).toContain("FEED_ITEM_LIMIT");
    const result = await new RssNewsSource({ ...config, maxBytes: 1024 }, transport("x".repeat(2000)), clock).read(query);
    expect(result.errorCode).toBe("UNAVAILABLE");
  });
  it("supports abort and timeout and does not invent a missing excerpt", async () => {
    expect(parseRss(feed('<item><title>Title</title><link>https://example.invalid/story</link></item>'), 10).articles[0].summary).toBe("");
    const read: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    const source = new RssNewsSource({ ...config, timeoutMs: 5 }, read, clock);
    expect((await source.read(query)).limitations).toContain("SOURCE_TIMEOUT");
    await expect(source.read(query, AbortSignal.abort())).rejects.toThrow();
  });
});
