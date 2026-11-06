import { describe, expect, test as bunTest } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditUrl,
  buildChecks,
  extractPageFacts,
  fetchPageSpeed,
  scoreChecks,
} from "../src/audit.ts";
import {
  extractAnchorsTo,
  findIndexedPages,
  findLinkingPages,
  getBacklinksEstimate,
  verifyBacklink,
} from "../src/linkcheck.ts";
import { errorMessage, fetchJson, fetchText, parseJson } from "../src/net.ts";
import {
  domainOf,
  estimateDifficulty,
  fetchNews,
  fetchOrganic,
  getSerpSnapshot,
  isAuthorityDomain,
} from "../src/serp.ts";
import {
  classifyIntent,
  collectSuggestions,
  researchKeywords,
  suggestUrl,
} from "../src/suggest.ts";
import { hasCapsolverKey, resolveTier } from "../src/tier.ts";
import {
  fetchNicheNews,
  fetchTrends,
  fetchWikipediaTop,
  filterByNiche,
  getTrends,
  parseTrends,
  wikiTopDate,
} from "../src/trends.ts";
import {
  decodeEntities,
  namespacedTagValue,
  parseDdgLite,
  parseRightDaoHtml,
  parseRssItems,
  parseSuggestionPayload,
  parseWikipediaTop,
  stripTags,
  tagValue,
  unwrapRedirect,
} from "../src/xml.ts";

const test = bunTest.serial;

const originalFetch = globalThis.fetch;

interface Route {
  match: string;
  status?: number;
  body: string;
}

function mockRoutes(routes: Route[]): Request[] {
  const requests: Request[] = [];
  const fetchMock = async (
    input: string | Request | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    requests.push(new Request(url, init));
    const route = routes.find((entry) => url.includes(entry.match));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body, { status: route.status ?? 200 });
  };
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  return requests;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function mockSequence(bodies: { status?: number; body: string }[]): Request[] {
  const requests: Request[] = [];
  const fetchMock = async (
    input: string | Request | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push(new Request(String(input), init));
    const next = bodies.shift();
    if (!next) return new Response("exhausted", { status: 500 });
    return new Response(next.body, { status: next.status ?? 200 });
  };
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  return requests;
}

const originalCwd = process.cwd();
const testDirectory = join(originalCwd, ".keyless-test-cache");

function useCacheDirectory(): void {
  rmSync(testDirectory, { recursive: true, force: true });
  mkdirSync(testDirectory, { recursive: true });
  process.chdir(testDirectory);
}

function restoreDirectory(): void {
  process.chdir(originalCwd);
  rmSync(testDirectory, { recursive: true, force: true });
}

const SUGGEST_PAYLOADS: Record<string, string> = {
  "suggestqueries.google.com": JSON.stringify([
    "seo tools",
    ["seo tools", "seo tools free", "seo tools ai", "how to do seo"],
  ]),
  "api.bing.com": JSON.stringify([
    "seo tools",
    ["seo tools", "seo tools pricing"],
  ]),
  "duckduckgo.com": JSON.stringify([
    "seo tools",
    ["seo tools", "seo tools free", "seo tools meaning"],
  ]),
};

const TRENDS_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel>
<title>Daily Search Trends</title>
<item>
  <title>seo audit</title>
  <ht:approx_traffic>2000+</ht:approx_traffic>
  <link>https://trends.google.com/trending/rss?geo=US</link>
  <pubDate>Tue, 20 Oct 2026 16:10:00 -0700</pubDate>
  <ht:news_item>
    <ht:news_item_title>Seo audit tools compared</ht:news_item_title>
    <ht:news_item_url>https://news.example.com/seo-audit</ht:news_item_url>
  </ht:news_item>
</item>
<item>
  <title>weather tomorrow</title>
  <ht:approx_traffic>100K+</ht:approx_traffic>
  <pubDate>Tue, 20 Oct 2026 15:00:00 -0700</pubDate>
</item>
</channel></rss>`;

const BING_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
<title>Bing: seo tools</title>
<item><title>Free SEO tool</title><link>https://www.example.com/seo</link><description>An example result.</description><pubDate>Tue, 20 Oct 2026 04:53:00 GMT</pubDate></item>
<item><title>SEO tools guide</title><link>https://en.wikipedia.org/wiki/Search_engine_optimization</link><description>Background.</description><pubDate>Tue, 20 Oct 2026 04:53:00 GMT</pubDate></item>
<item><title>Guide site</title><link>https://blog.example.org/seo</link><description>Community post.</description><pubDate>Tue, 20 Oct 2026 04:53:00 GMT</pubDate></item>
</channel></rss>`;

const DDG_LITE = `<!DOCTYPE html><html><body><table>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fseo&amp;rut=abc" class='result-link'>Free SEO tool</a></td></tr>
<tr><td class='result-snippet'>An example result from the lite page.</td></tr>
<tr><td><a rel="nofollow" href="https://en.wikipedia.org/wiki/Search_engine_optimization" class='result-link'>SEO tools guide</a></td></tr>
<tr><td class='result-snippet'>Background on search engines.</td></tr>
<tr><td><a rel="nofollow" href="https://weather.example.com/forecast" class='result-link'>Weather forecast</a></td></tr>
<tr><td class='result-snippet'>Nothing to do with the query.</td></tr>
</table></body></html>`;

const RIGHT_DAO = `<!DOCTYPE html><html><body><div class="results">
<div class="item">
  <div class="title"><a href="https://www.example.org/seo-tools" target="_blank"><div class="ellipsis-lg" >SEO tools directory<s></s></div></a></div>
  <div class="description"><span class="date">Oct 20, 2026 - </span>Every tool in one list.</div>
  <div class="info"><span class="url">https://www.example.org/seo-tools</span></div>
</div>
</div></body></html>`;

const GOOGLE_NEWS_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
<item><title>Free SEO tool</title><link>https://news.google.com/rss/articles/abc</link><description>Also on the news feed.</description><pubDate>Tue, 20 Oct 2026 04:53:00 GMT</pubDate></item>
<item><title>Seo audit coverage - Example News</title><link>https://news.google.com/rss/articles/def</link><description>A report.</description><pubDate>Tue, 20 Oct 2026 05:53:00 GMT</pubDate></item>
</channel></rss>`;

const WIKIPEDIA_TOP = JSON.stringify({
  items: [
    {
      project: "en.wikipedia",
      articles: [
        { article: "Main_Page", views: 6401058, rank: 1 },
        { article: "Ying", views: 886855, rank: 2 },
      ],
    },
  ],
});

const PAGE_HTML = `<!doctype html><html><head>
<title>A page about search engines</title>
<meta name="description" content="A description that is long enough to pass the length check for a search result snippet.">
<meta property="og:title" content="A page about search engines">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://example.com/page">
<script type="application/ld+json">{"@type":"Article"}</script>
</head><body>
<h1>Search engines</h1>
<p>${"word ".repeat(320)}</p>
<img src="/a.png" alt="chart">
<img src="/b.png">
</body></html>`;

describe("net layer", () => {
  test("reads a page and reports the status", async () => {
    mockRoutes([{ match: "example.com", body: "hello" }]);
    const response = await fetchText("https://example.com/page");
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.text).toBe("hello");
    expect(response.error).toBeNull();
    expect(response.finalUrl).toBe("https://example.com/page");
    restoreFetch();
  });

  test("reports http errors and network failures as data", async () => {
    mockRoutes([{ match: "example.com", status: 500, body: "boom" }]);
    const failed = await fetchText("https://example.com/page");
    expect(failed.ok).toBe(false);
    expect(failed.status).toBe(500);
    expect(failed.error).toBe("HTTP 500");
    restoreFetch();

    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("network down");
      },
      { preconnect: originalFetch.preconnect },
    );
    const broken = await fetchText("https://example.com/page");
    expect(broken.ok).toBe(false);
    expect(broken.status).toBe(0);
    expect(broken.error).toBe("network down");
    expect(broken.finalUrl).toBe("https://example.com/page");
    restoreFetch();
  });

  test("parses json payloads and rejects broken ones", async () => {
    mockRoutes([{ match: "api.example", body: '{"a":1}' }]);
    expect(await fetchJson("https://api.example/x")).toEqual({ a: 1 });
    restoreFetch();
    mockRoutes([{ match: "api.example", body: "not json" }]);
    expect(await fetchJson("https://api.example/x")).toBeNull();
    restoreFetch();
    expect(parseJson("{")).toBeNull();
    expect(parseJson("{}")).toEqual({});
  });

  test("formats error messages", () => {
    expect(errorMessage(new Error("bad"))).toBe("bad");
    expect(errorMessage("plain")).toBe("plain");
  });
});

describe("xml helpers", () => {
  test("decodes named, decimal, and hex entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe(
      'a & b <c> "d"',
    );
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("&unknown;")).toBe("&unknown;");
  });

  test("strips tags and reads tag values", () => {
    expect(stripTags("<p>hello <b>world</b></p>")).toBe("hello world");
    expect(tagValue("<item><title>A &amp; B</title></item>", "title")).toBe(
      "A & B",
    );
    expect(tagValue("<item><title>A</title></item>", "missing")).toBe("");
    expect(
      namespacedTagValue(
        "<ht:approx_traffic>2000+</ht:approx_traffic>",
        "ht:approx_traffic",
      ),
    ).toBe("2000+");
  });

  test("parses rss items", () => {
    const items = parseRssItems(BING_RSS);
    expect(items).toHaveLength(3);
    expect(items[0]?.title).toBe("Free SEO tool");
    expect(items[0]?.link).toBe("https://www.example.com/seo");
    expect(items[0]?.description).toBe("An example result.");
  });

  test("parses the duckduckgo lite page", () => {
    const results = parseDdgLite(DDG_LITE);
    expect(results).toHaveLength(3);
    expect(results[0]?.title).toBe("Free SEO tool");
    expect(results[0]?.url).toBe("https://www.example.com/seo");
    expect(results[0]?.snippet).toBe("An example result from the lite page.");
    expect(results[1]?.url).toBe(
      "https://en.wikipedia.org/wiki/Search_engine_optimization",
    );
    expect(parseDdgLite("<html><body>nothing here</body></html>")).toEqual([]);
  });

  test("parses the right dao result page", () => {
    const results = parseRightDaoHtml(RIGHT_DAO);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("SEO tools directory");
    expect(results[0]?.url).toBe("https://www.example.org/seo-tools");
    expect(results[0]?.snippet).toBe("Every tool in one list.");
  });

  test("unwraps the known redirect wrappers only", () => {
    expect(
      unwrapRedirect(
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=xyz",
      ),
    ).toBe("https://example.com/a");
    expect(
      unwrapRedirect(
        "http://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fforbes.com%2Fx&c=1",
      ),
    ).toBe("https://forbes.com/x");
    expect(unwrapRedirect("https://example.com/page?url=other")).toBe(
      "https://example.com/page?url=other",
    );
    expect(unwrapRedirect("http://[bad")).toBe("http://[bad");
    expect(unwrapRedirect("")).toBe("");
  });

  test("parses suggestion payloads and wikipedia tops", () => {
    expect(parseSuggestionPayload(["q", ["a", "b"]])).toEqual(["a", "b"]);
    expect(parseSuggestionPayload(["q", [1, "b", "  "]])).toEqual(["b"]);
    expect(parseSuggestionPayload("nope")).toEqual([]);
    expect(parseSuggestionPayload(["q"])).toEqual([]);
    expect(parseWikipediaTop(JSON.parse(WIKIPEDIA_TOP))).toEqual([
      { article: "Main Page", views: 6401058, rank: 1 },
      { article: "Ying", views: 886855, rank: 2 },
    ]);
    expect(parseWikipediaTop({})).toEqual([]);
    expect(parseWikipediaTop({ items: [{ articles: [{}] }] })).toEqual([]);
  });
});

describe("suggestions", () => {
  test("builds an endpoint url per engine", () => {
    expect(suggestUrl("google", "seo tools")).toContain(
      "suggestqueries.google.com",
    );
    expect(suggestUrl("bing", "seo tools")).toContain("api.bing.com");
    expect(suggestUrl("duckduckgo", "seo tools")).toContain(
      "duckduckgo.com/ac",
    );
    expect(suggestUrl("google", "a b")).toContain("a%20b");
  });

  test("collects suggestions from every engine", async () => {
    mockRoutes([
      {
        match: "suggestqueries.google.com",
        body: SUGGEST_PAYLOADS["suggestqueries.google.com"] as string,
      },
      {
        match: "api.bing.com",
        body: SUGGEST_PAYLOADS["api.bing.com"] as string,
      },
      {
        match: "duckduckgo.com",
        body: SUGGEST_PAYLOADS["duckduckgo.com"] as string,
      },
    ]);
    const suggestions = await collectSuggestions("seo tools");
    expect(suggestions.length).toBeGreaterThan(4);
    expect(suggestions.some((entry) => entry.engine === "bing")).toBe(true);
    expect(suggestions.every((entry) => entry.rank > 0)).toBe(true);
    restoreFetch();
  });

  test("asks a failed engine a second time", async () => {
    let calls = 0;
    const fetchMock = async (): Promise<Response> => {
      calls += 1;
      if (calls <= 3) return new Response("down", { status: 500 });
      return new Response(
        SUGGEST_PAYLOADS["suggestqueries.google.com"] as string,
        { status: 200 },
      );
    };
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    const suggestions = await collectSuggestions("seo tools");
    expect(calls).toBe(6);
    expect(suggestions.length).toBe(12);
    expect(new Set(suggestions.map((entry) => entry.engine)).size).toBe(3);
    restoreFetch();
  });

  test("classifies intent", () => {
    expect(classifyIntent("how to audit a site")).toBe("question");
    expect(classifyIntent("best seo tools")).toBe("commercial");
    expect(classifyIntent("what is a canonical tag?")).toBe("question");
    expect(classifyIntent("search engine history")).toBe("informational");
  });

  test("expands a seed into ranked candidates", async () => {
    mockRoutes([
      {
        match: "suggestqueries.google.com",
        body: SUGGEST_PAYLOADS["suggestqueries.google.com"] as string,
      },
      {
        match: "api.bing.com",
        body: SUGGEST_PAYLOADS["api.bing.com"] as string,
      },
      {
        match: "duckduckgo.com",
        body: SUGGEST_PAYLOADS["duckduckgo.com"] as string,
      },
    ]);
    const research = await researchKeywords("seo tools", { limit: 10 });
    expect(research.source).toBe("autocomplete");
    expect(research.candidates.length).toBeGreaterThan(0);
    expect(research.candidates.length).toBeLessThanOrEqual(10);
    expect(research.candidates[0]?.keyword).toBe("seo tools");
    expect(research.candidates[0]?.engines.length).toBe(3);
    expect(research.engines_answered.length).toBe(3);
    expect(research.questions).toContain("how to do seo");
    expect(research.note).toContain("not search volume");
    expect(research.seeds_asked.length).toBeGreaterThan(1);
    restoreFetch();
  });

  test("quick depth asks the seed only and survives dead endpoints", async () => {
    mockRoutes([
      {
        match: "suggestqueries.google.com",
        body: SUGGEST_PAYLOADS["suggestqueries.google.com"] as string,
      },
    ]);
    const research = await researchKeywords("seo tools", { depth: "quick" });
    expect(research.seeds_asked).toEqual(["seo tools"]);
    expect(research.engines_answered).toEqual(["google"]);
    expect(research.questions).toEqual(["how to do seo"]);
    restoreFetch();
  });
});

describe("trends", () => {
  test("parses the trends rss", () => {
    const items = parseTrends(TRENDS_RSS);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("seo audit");
    expect(items[0]?.traffic).toBe("2000+");
    expect(items[0]?.url).toBe("https://news.example.com/seo-audit");
    expect(items[1]?.title).toBe("weather tomorrow");
  });

  test("asks for a wikipedia date with a lag", () => {
    expect(wikiTopDate(new Date("2026-10-21T00:00:00Z"))).toBe("2026/10/18");
  });

  test("reads trends, wikipedia and niche news", async () => {
    mockRoutes([
      { match: "trends.google.com", body: TRENDS_RSS },
      { match: "wikimedia.org", body: WIKIPEDIA_TOP },
      { match: "bing.com/news", body: BING_RSS },
    ]);
    const now = new Date("2026-10-21T00:00:00Z");
    const trends = await fetchTrends("US");
    expect(trends).toHaveLength(2);
    const wiki = await fetchWikipediaTop({}, now);
    expect(wiki[0]?.title).toBe("Main Page");
    const news = await fetchNicheNews("seo");
    expect(news[0]?.title).toBe("Free SEO tool");
    restoreFetch();
  });

  test("filters items by niche", () => {
    const items = parseTrends(TRENDS_RSS);
    expect(filterByNiche(items, "seo")).toHaveLength(1);
    expect(filterByNiche(items, "")).toHaveLength(2);
  });

  test("builds the full trending report", async () => {
    mockRoutes([
      { match: "trends.google.com", body: TRENDS_RSS },
      { match: "wikimedia.org", body: WIKIPEDIA_TOP },
      { match: "bing.com/news", body: BING_RSS },
    ]);
    const report = await getTrends({
      niche: "seo",
      geo: "GB",
      limit: 5,
      now: new Date("2026-10-21T00:00:00Z"),
    });
    expect(report.source).toBe("trends");
    expect(report.geo).toBe("GB");
    expect(report.trends).toHaveLength(1);
    expect(report.wikipedia_top.length).toBeGreaterThan(0);
    expect(report.niche_news.length).toBeGreaterThan(0);
    expect(report.generated_at).toBe("2026-10-21T00:00:00.000Z");
    expect(report.note).toBeUndefined();
    restoreFetch();
  });

  test("falls back to the daily feed when the niche has no match", async () => {
    mockRoutes([
      { match: "trends.google.com", body: TRENDS_RSS },
      { match: "wikimedia.org", body: WIKIPEDIA_TOP },
      { match: "bing.com/news", body: BING_RSS },
    ]);
    const report = await getTrends({
      niche: "cooking",
      limit: 5,
      now: new Date("2026-10-21T00:00:00Z"),
    });
    expect(report.trends).toHaveLength(2);
    expect(report.note).toContain("cooking");
    restoreFetch();
  });

  test("returns empty lists when the feeds fail", async () => {
    mockRoutes([{ match: "trends.google.com", status: 503, body: "down" }]);
    expect(await fetchTrends("US")).toEqual([]);
    expect(await fetchNicheNews("seo")).toEqual([]);
    restoreFetch();
  });
});

describe("serp", () => {
  test("reads the host of a url", () => {
    expect(domainOf("https://www.Example.com/path?x=1")).toBe("example.com");
    expect(domainOf("https://blog.example.com")).toBe("blog.example.com");
    expect(domainOf("not a url")).toBe("");
  });

  test("spots authoritative domains", () => {
    expect(isAuthorityDomain("en.wikipedia.org")).toBe(true);
    expect(isAuthorityDomain("mit.edu")).toBe(true);
    expect(isAuthorityDomain("city.gov")).toBe(true);
    expect(isAuthorityDomain("reddit.com")).toBe(true);
    expect(isAuthorityDomain("myblog.example")).toBe(false);
    expect(isAuthorityDomain("")).toBe(false);
  });

  test("scores an empty result page", () => {
    const estimate = estimateDifficulty("seo tools", []);
    expect(estimate.score).toBe(0);
    expect(estimate.confidence).toBe("none");
    expect(estimate.components.results).toBe(0);
  });

  test("scores competition from the result page", () => {
    const entries = [
      {
        position: 1,
        title: "SEO tools",
        url: "https://en.wikipedia.org/wiki/SEO",
        domain: "en.wikipedia.org",
        snippet: "",
        kind: "organic" as const,
      },
      {
        position: 2,
        title: "SEO tools guide",
        url: "https://blog.example.org/seo",
        domain: "blog.example.org",
        snippet: "",
        kind: "organic" as const,
      },
    ];
    const estimate = estimateDifficulty("seo tools", entries);
    expect(estimate.method).toBe("serp_composition");
    expect(estimate.components.results).toBe(2);
    expect(estimate.components.distinct_domains).toBe(2);
    expect(estimate.components.authority_share).toBe(0.5);
    expect(estimate.components.domain_concentration).toBe(0);
    expect(estimate.components.exact_title_share).toBe(1);
    expect(estimate.score).toBe(25);
    expect(estimate.confidence).toBe("low");
    expect(estimate.note).toContain("not the Ahrefs");
  });

  test("takes a snapshot of organic results and the news pack", async () => {
    mockRoutes([
      { match: "bing.com/news", body: BING_RSS },
      { match: "bing.com/search", body: BING_RSS },
    ]);
    const snapshot = await getSerpSnapshot("seo tools", {
      limit: 3,
      now: new Date("2026-10-21T00:00:00Z"),
    });
    expect(snapshot.source).toBe("serp");
    expect(snapshot.results).toHaveLength(3);
    expect(snapshot.results[0]?.domain).toBe("example.com");
    expect(snapshot.news[0]?.kind).toBe("news");
    expect(snapshot.difficulty_estimate.components.results).toBe(3);
    restoreFetch();
  });

  test("says so when no endpoint returns a result page", async () => {
    mockRoutes([]);
    const snapshot = await getSerpSnapshot("zzzz no such query", {
      now: new Date("2026-10-21T00:00:00Z"),
    });
    expect(snapshot.endpoint).toBe("none");
    expect(snapshot.results).toHaveLength(0);
    expect(snapshot.note).toBe(
      "No public endpoint returned a page about this query, so there is no competition read.",
    );
    restoreFetch();
  });

  test("reads organic results from the duckduckgo lite page", async () => {
    mockRoutes([{ match: "lite.duckduckgo.com", body: DDG_LITE }]);
    const search = await fetchOrganic("seo tools");
    expect(search.endpoint).toBe("duckduckgo");
    expect(search.entries).toHaveLength(2);
    expect(search.entries[0]?.domain).toBe("example.com");
    expect(search.entries[0]?.snippet).toBe(
      "An example result from the lite page.",
    );
    expect(search.entries[1]?.domain).toBe("en.wikipedia.org");
    restoreFetch();
  });

  test("drops the pages that do not name the query", async () => {
    mockRoutes([{ match: "lite.duckduckgo.com", body: DDG_LITE }]);
    const search = await fetchOrganic("seo tools");
    expect(
      search.entries.some((entry) => entry.domain === "weather.example.com"),
    ).toBe(false);
    restoreFetch();
  });

  test("treats a duckduckgo challenge as no answer", async () => {
    mockRoutes([
      { match: "lite.duckduckgo.com", status: 202, body: "challenge" },
      { match: "rightdao.com", body: RIGHT_DAO },
    ]);
    const search = await fetchOrganic("seo tools");
    expect(search.endpoint).toBe("rightdao");
    expect(search.entries).toHaveLength(1);
    expect(search.entries[0]?.url).toBe("https://www.example.org/seo-tools");
    expect(search.silent).toContain("duckduckgo");
    restoreFetch();
  });

  test("falls back to the bing feed when the other endpoints answer nothing", async () => {
    mockRoutes([
      { match: "lite.duckduckgo.com", status: 500, body: "down" },
      { match: "rightdao.com", status: 500, body: "down" },
      { match: "bing.com/search", body: BING_RSS },
    ]);
    const search = await fetchOrganic("seo tools");
    expect(search.endpoint).toBe("bing");
    expect(search.entries).toHaveLength(3);
    expect(search.entries[0]?.title).toBe("Free SEO tool");
    expect(search.silent).toEqual(["duckduckgo", "rightdao"]);
    restoreFetch();
  });

  test("merges the bing and google news feeds without duplicates", async () => {
    mockRoutes([
      { match: "bing.com/news", body: BING_RSS },
      { match: "news.google.com", body: GOOGLE_NEWS_RSS },
    ]);
    const news = await fetchNews("seo tools");
    expect(news).toHaveLength(4);
    expect(news[0]?.kind).toBe("news");
    expect(news[0]?.url).toBe("https://www.example.com/seo");
    expect(news[3]?.url).toBe("https://news.google.com/rss/articles/def");
    restoreFetch();
  });

  test("returns no entries when every endpoint fails", async () => {
    mockRoutes([{ match: "bing.com", status: 500, body: "down" }]);
    const search = await fetchOrganic("seo tools");
    expect(search.entries).toEqual([]);
    expect(search.endpoint).toBe("none");
    expect(search.silent).toEqual(["duckduckgo", "rightdao", "bing"]);
    expect(await fetchNews("seo tools")).toEqual([]);
    restoreFetch();
  });
});

describe("link discovery", () => {
  const linkingPage = `<html><body>
    <a href="https://www.example.com/docs">the example docs</a>
    <a href="//www.example.com/relative">protocol relative</a>
    <a href="/relative">same host link</a>
    <a href="https://other.test/page">unrelated</a>
    <a href="#anchor">anchor only</a>
  </body></html>`;

  test("reads the anchors that point at the target", () => {
    expect(
      extractAnchorsTo(
        linkingPage,
        "https://blog.example.org/post",
        "example.com",
      ),
    ).toEqual(["the example docs", "protocol relative"]);
    expect(
      extractAnchorsTo(
        linkingPage,
        "https://blog.example.org/post",
        "nothing.test",
      ),
    ).toEqual([]);
  });

  test("finds pages that mention the domain", async () => {
    mockRoutes([{ match: "bing.com/search", body: BING_RSS }]);
    const candidates = await findLinkingPages("example.com", {}, 10);
    expect(candidates.length).toBe(2);
    expect(candidates.every((entry) => entry.domain !== "example.com")).toBe(
      true,
    );
    restoreFetch();
  });

  test("reads the linking pages from the duckduckgo lite page", async () => {
    mockRoutes([{ match: "lite.duckduckgo.com", body: DDG_LITE }]);
    const candidates = await findLinkingPages("example.com", {}, 10);
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.domain).toBe("en.wikipedia.org");
    expect(candidates[0]?.url).toBe(
      "https://en.wikipedia.org/wiki/Search_engine_optimization",
    );
    restoreFetch();
  });

  test("reads a second batch of candidates when the first batch finds nothing", async () => {
    const many = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
${[1, 2, 3, 4, 5, 6, 7, 8]
  .map(
    (index) =>
      `<item><title>Post ${index}</title><link>https://blog${index}.example.org/post</link><description>Community post.</description><pubDate>Tue, 20 Oct 2026 04:53:00 GMT</pubDate></item>`,
  )
  .join("\n")}
</channel></rss>`;
    mockRoutes([
      { match: "bing.com/search", body: many },
      {
        match: ".example.org",
        body: "<html><body>no links here</body></html>",
      },
    ]);
    const report = await getBacklinksEstimate({
      domain: "example.com",
      limit: 5,
    });
    expect(report.backlinks).toHaveLength(0);
    expect(report.candidates_checked).toBe(8);
    restoreFetch();
  });

  test("verifies a candidate by reading the page", async () => {
    mockRoutes([{ match: "blog.test", body: linkingPage }]);
    const candidate = {
      url: "https://blog.test/post",
      title: "A post",
      snippet: "",
      domain: "blog.test",
    };
    const backlink = await verifyBacklink(candidate, "example.com");
    expect(backlink?.anchor).toBe("the example docs");
    expect(backlink?.source_domain).toBe("blog.test");
    restoreFetch();

    mockRoutes([
      { match: "blog.test", body: "<html><body>no links here</body></html>" },
    ]);
    expect(await verifyBacklink(candidate, "example.com")).toBeNull();
    restoreFetch();

    mockRoutes([{ match: "blog.test", status: 404, body: "gone" }]);
    expect(await verifyBacklink(candidate, "example.com")).toBeNull();
    restoreFetch();
  });

  test("builds a backlink report", async () => {
    mockRoutes([
      { match: "bing.com/search", body: BING_RSS },
      { match: "blog.example.org", body: linkingPage },
      { match: "en.wikipedia.org", body: "<html><body>nothing</body></html>" },
    ]);
    const report = await getBacklinksEstimate({
      domain: "example.com",
      limit: 5,
    });
    expect(report.source).toBe("estimate");
    expect(report.backlinks).toHaveLength(1);
    expect(report.referring_domains).toEqual(["blog.example.org"]);
    expect(report.candidates_checked).toBe(2);
    expect(report.method).toBe("search_mentions_verified_by_fetch");
    restoreFetch();
  });

  test("lists the pages of a domain the engine shows", async () => {
    mockRoutes([{ match: "bing.com/search", body: BING_RSS }]);
    const pages = await findIndexedPages("example.com");
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]?.url).toContain("http");
    restoreFetch();
  });
});

describe("audit", () => {
  test("reads the facts of a page", () => {
    const facts = extractPageFacts(PAGE_HTML);
    expect(facts.title).toBe("A page about search engines");
    expect(facts.description.length).toBeGreaterThan(50);
    expect(facts.canonical).toBe("https://example.com/page");
    expect(facts.viewport).toBe(true);
    expect(facts.ogTitle).toBe(true);
    expect(facts.h1Count).toBe(1);
    expect(facts.jsonLdCount).toBe(1);
    expect(facts.imageCount).toBe(2);
    expect(facts.imagesMissingAlt).toBe(1);
    expect(facts.wordCount).toBeGreaterThan(300);
  });

  test("reads a page with a bare meta tag and no canonical link", () => {
    const facts = extractPageFacts(
      `<html><head><meta charset="utf-8"><title>Bare page</title></head><body><p>hi</p></body></html>`,
    );
    expect(facts.canonical).toBe("");
    expect(facts.viewport).toBe(false);
    expect(facts.ogTitle).toBe(false);
  });

  test("builds checks and a score", () => {
    const facts = extractPageFacts(PAGE_HTML);
    const checks = buildChecks(facts, true, 900);
    expect(checks.length).toBeGreaterThan(8);
    expect(checks.every((check) => check.detail.length > 0)).toBe(true);
    expect(scoreChecks(checks)).toBeGreaterThan(0);
    expect(scoreChecks([])).toBe(0);
    const failing = buildChecks(
      {
        ...facts,
        title: "",
        description: "",
        canonical: "",
        viewport: false,
        h1Count: 0,
        ogTitle: false,
        jsonLdCount: 0,
        imagesMissingAlt: 9,
        robots: "noindex, nofollow",
        wordCount: 3,
      },
      false,
      9000,
    );
    expect(scoreChecks(failing)).toBeLessThan(20);
  });

  test("reads pagespeed when it answers", async () => {
    mockRoutes([
      {
        match: "pagespeedonline",
        body: JSON.stringify({
          categories: { performance: { score: 0.87 } },
          audits: {
            "first-contentful-paint": { displayValue: "1.2 s" },
            "largest-contentful-paint": { displayValue: "2.4 s" },
            "cumulative-layout-shift": { displayValue: "0.05" },
          },
        }),
      },
    ]);
    const report = await fetchPageSpeed("https://example.com");
    expect(report?.score).toBe(87);
    expect(report?.fcp).toBe("1.2 s");
    expect(report?.lcp).toBe("2.4 s");
    expect(report?.cls).toBe("0.05");
    expect(report?.field).toBeNull();
    restoreFetch();

    mockRoutes([{ match: "pagespeedonline", status: 429, body: "quota" }]);
    expect(await fetchPageSpeed("https://example.com")).toBeNull();
    restoreFetch();
  });

  test("audits a page", async () => {
    mockRoutes([{ match: "example.com", body: PAGE_HTML }]);
    const report = await auditUrl("https://example.com/page");
    expect(report.source).toBe("http");
    expect(report.status).toBe(200);
    expect(report.https).toBe(true);
    expect(report.title).toBe("A page about search engines");
    expect(report.checks.length).toBeGreaterThan(8);
    expect(report.performance).toBeNull();
    expect(report.notes).toEqual([]);
    restoreFetch();
  });

  test("reports a page that cannot be read", async () => {
    mockRoutes([{ match: "example.com", status: 404, body: "missing" }]);
    const report = await auditUrl("https://example.com/page");
    expect(report.score).toBe(0);
    expect(report.status).toBe(404);
    expect(report.notes.length).toBe(1);
    restoreFetch();
  });

  test("notes a refused pagespeed call", async () => {
    mockRoutes([
      { match: "example.com", body: PAGE_HTML },
      { match: "pagespeedonline", status: 429, body: "quota" },
    ]);
    const report = await auditUrl("https://example.com/page", {
      includePerformance: true,
    });
    expect(report.performance).toBeNull();
    expect(report.notes[0]).toContain("PageSpeed");
    restoreFetch();
  });
});

describe("tiers", () => {
  test("reads the capsolver key from the environment", () => {
    const previous = process.env.CAPSOLVER_API_KEY;
    delete process.env.CAPSOLVER_API_KEY;
    expect(hasCapsolverKey()).toBe(false);
    expect(resolveTier()).toBe("keyless");
    process.env.CAPSOLVER_API_KEY = "test-key";
    expect(hasCapsolverKey()).toBe(true);
    expect(resolveTier()).toBe("ahrefs");
    if (previous === undefined) delete process.env.CAPSOLVER_API_KEY;
    else process.env.CAPSOLVER_API_KEY = previous;
  });
});

describe("package version", () => {
  test("reads the version from the package manifest", async () => {
    const { readVersion } = await import("../src/server.ts");
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(readVersion()).toBe(manifest.version);
    expect(readVersion("/nowhere/at/all")).toBe("0.0.0");
  });

  test("falls back when the manifest has no version string", async () => {
    const { readVersion } = await import("../src/server.ts");
    const root = mkdtempSync(join(tmpdir(), "seo-version-"));
    mkdirSync(join(root, "app"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "no-version" }),
    );
    try {
      expect(readVersion(join(root, "app"))).toBe("0.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tool surface", () => {
  test("serves every keyless tool without any api key", async () => {
    delete process.env.CAPSOLVER_API_KEY;
    mockRoutes([
      { match: "trends.google.com", body: TRENDS_RSS },
      { match: "wikimedia.org", body: WIKIPEDIA_TOP },
      { match: "bing.com/news", body: BING_RSS },
      { match: "bing.com/search", body: BING_RSS },
      {
        match: "suggestqueries.google.com",
        body: SUGGEST_PAYLOADS["suggestqueries.google.com"] as string,
      },
      {
        match: "api.bing.com",
        body: SUGGEST_PAYLOADS["api.bing.com"] as string,
      },
      {
        match: "duckduckgo.com",
        body: SUGGEST_PAYLOADS["duckduckgo.com"] as string,
      },
      { match: "example.com", body: PAGE_HTML },
      {
        match: "blog.test",
        body: '<html><body><a href="https://example.com/x">anchor</a></body></html>',
      },
    ]);
    const server = await import("../src/server.ts");

    const trending = JSON.parse(
      (await server.getTrendingTool({ niche: "seo", geo: "US", limit: 5 }))
        .content[0]!.text,
    );
    expect(trending.source).toBe("trends");
    expect(trending.geo).toBe("US");

    const keywords = JSON.parse(
      (
        await server.getKeywordResearchTool({
          seed: "seo tools",
          limit: 3,
          depth: "quick",
        })
      ).content[0]!.text,
    );
    expect(keywords.source).toBe("autocomplete");
    expect(keywords.candidates.length).toBeGreaterThan(0);

    const serp = JSON.parse(
      (await server.getSerpSnapshotTool({ keyword: "seo tools", limit: 3 }))
        .content[0]!.text,
    );
    expect(serp.source).toBe("serp");
    expect(serp.difficulty_estimate.method).toBe("serp_composition");

    const audit = JSON.parse(
      (await server.getTechnicalAuditTool({ url: "https://example.com/page" }))
        .content[0]!.text,
    );
    expect(audit.source).toBe("http");
    expect(audit.checks.length).toBeGreaterThan(8);

    const backlinks = JSON.parse(
      (await server.getBacklinksTool({ domain: "example.com", limit: 2 }))
        .content[0]!.text,
    );
    expect(backlinks.tier).toBe("keyless");
    expect(backlinks.source).toBe("estimate");

    const traffic = JSON.parse(
      (await server.getTrafficTool({ domain_or_url: "example.com", limit: 2 }))
        .content[0]!.text,
    );
    expect(traffic.tier).toBe("keyless");
    expect(traffic.source).toBe("estimate");
    expect(traffic.note).toContain("clickstream");

    const legacyKeywords = JSON.parse(
      (await server.keywordGeneratorTool({ keyword: "seo tools" })).content[0]!
        .text,
    );
    expect(legacyKeywords.source).toBe("autocomplete");

    const legacyDifficulty = JSON.parse(
      (await server.keywordDifficultyTool({ keyword: "seo tools" })).content[0]!
        .text,
    );
    expect(legacyDifficulty.source).toBe("estimate");
    expect(legacyDifficulty.difficulty_estimate.score).toBeGreaterThanOrEqual(
      0,
    );
    restoreFetch();
  });

  test("uses the ahrefs tier when a capsolver key is present", async () => {
    process.env.CAPSOLVER_API_KEY = "test-key";
    useCacheDirectory();
    const { saveSignatureToCache } = await import("../src/backlinks.ts");
    saveSignatureToCache(
      "sig",
      "2999-01-01T00:00:00Z",
      { total: 1 },
      "example.com",
    );
    mockSequence([
      { body: JSON.stringify(["Ok", { topBacklinks: { backlinks: [] } }]) },
    ]);
    const server = await import("../src/server.ts");
    const backlinks = JSON.parse(
      (await server.getBacklinksTool({ domain: "example.com" })).content[0]!
        .text,
    );
    expect(backlinks.tier).toBe("ahrefs");
    expect(backlinks.source).toBe("ahrefs");
    expect(backlinks.overview).toEqual({ total: 1 });
    restoreFetch();

    mockSequence([
      { body: JSON.stringify({ taskId: "task" }) },
      {
        body: JSON.stringify({ status: "ready", solution: { token: "token" } }),
      },
      { body: JSON.stringify(["Ok", { traffic: { trafficMonthlyAvg: 10 } }]) },
    ]);
    const traffic = JSON.parse(
      (await server.getTrafficTool({ domain_or_url: "example.com" }))
        .content[0]!.text,
    );
    expect(traffic.tier).toBe("ahrefs");
    expect(traffic.traffic.trafficMonthlyAvg).toBe(10);
    restoreFetch();
    restoreDirectory();
    delete process.env.CAPSOLVER_API_KEY;
  });
});
