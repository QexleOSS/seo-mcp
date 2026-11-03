/**
 * Live search results.
 *
 * DuckDuckGo's lite page is the organic source: it answers without a key, it
 * handles long tail queries properly, and it answers in under a second. Bing's
 * RSS output is the fallback and the news feed. The snapshot reports who ranks
 * right now and scores how hard that looks, and it never calls the score a
 * keyword difficulty in the Ahrefs sense.
 */

import { fetchText, withTimeout, type NetContext } from "./net.ts";
import {
  parseDdgLite,
  parseRightDaoHtml,
  parseRssItems,
  unwrapRedirect,
} from "./xml.ts";

/** Deadlines for the result pages, so a stalled page cannot stall the tool. */
export const SERP_TIMEOUT_MS = 15000;
export const NEWS_TIMEOUT_MS = 15000;

export interface SerpEntry {
  position: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  kind: "organic" | "news";
}

/** Domains that usually own a query. Used for the competition read. */
const AUTHORITY_DOMAINS = [
  "wikipedia.org",
  "britannica.com",
  "google.com",
  "youtube.com",
  "reddit.com",
  "quora.com",
  "medium.com",
  "stackoverflow.com",
  "github.com",
  "npmjs.com",
  "microsoft.com",
  "apple.com",
  "amazon.com",
  "ebay.com",
  "indeed.com",
  "linkedin.com",
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "nytimes.com",
  "wsj.com",
  "forbes.com",
  "bloomberg.com",
  "businessinsider.com",
  "techcrunch.com",
  "theverge.com",
  "wired.com",
  "arstechnica.com",
  "engadget.com",
  "hubspot.com",
  "semrush.com",
  "ahrefs.com",
  "moz.com",
  "zapier.com",
  "notion.so",
  "figma.com",
  "canva.com",
  "shopify.com",
  "stripe.com",
  "coursera.org",
  "udemy.com",
  "skillshare.com",
  "investopedia.com",
  "nerdwallet.com",
  "which.co.uk",
  "g2.com",
  "capterra.com",
  "trustpilot.com",
  "producthunt.com",
  "indeed.co.uk",
  "glassdoor.com",
  "tripadvisor.com",
];

const AUTHORITY_SUFFIXES = [".gov", ".edu", ".mil", ".int"];

export function domainOf(url: string): string {
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isAuthorityDomain(domain: string): boolean {
  if (!domain) return false;
  if (AUTHORITY_DOMAINS.includes(domain)) return true;
  if (AUTHORITY_SUFFIXES.some((suffix) => domain.endsWith(suffix))) return true;
  return AUTHORITY_DOMAINS.some(
    (known) => domain.endsWith(`.${known}`) || domain === known,
  );
}

export async function fetchSerpFeed(
  url: string,
  ctx: NetContext,
): Promise<SerpEntry[]> {
  const response = await fetchText(url, ctx);
  if (!response.ok) return [];
  return parseRssItems(response.text)
    .filter((item) => item.link && item.title)
    .map((item, index) => ({
      position: index + 1,
      title: item.title,
      url: unwrapRedirect(item.link),
      domain: domainOf(unwrapRedirect(item.link)),
      snippet: item.description,
      kind: "organic" as const,
    }));
}

/** Reads the organic results from the DuckDuckGo lite page. */
export async function fetchDdgOrganic(
  query: string,
  ctx: NetContext = {},
): Promise<SerpEntry[]> {
  const response = await fetchText(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    withTimeout(ctx, SERP_TIMEOUT_MS),
  );
  // DuckDuckGo answers a challenge with 202 and a page that holds no results.
  // Treating that as an answer would hand the caller a result page with the
  // wrong pages on it.
  if (!response.ok || response.status === 202) return [];
  if (CHALLENGE_BODY.test(response.text)) return [];
  return parseDdgLite(response.text).map((entry, index) => ({
    position: index + 1,
    title: entry.title,
    url: entry.url,
    domain: domainOf(entry.url),
    snippet: entry.snippet,
    kind: "organic" as const,
  }));
}

/** Reads the organic results from the Right Dao index. */
export async function fetchRightDao(
  query: string,
  ctx: NetContext = {},
): Promise<SerpEntry[]> {
  const response = await fetchText(
    `https://rightdao.com/search?q=${encodeURIComponent(query)}`,
    withTimeout(ctx, SERP_TIMEOUT_MS),
  );
  if (!response.ok) return [];
  return parseRightDaoHtml(response.text).map((entry, index) => ({
    position: index + 1,
    title: entry.title,
    url: entry.url,
    domain: domainOf(entry.url),
    snippet: entry.snippet,
    kind: "organic" as const,
  }));
}

const CHALLENGE_BODY =
  /anomaly-modal|duckduckgo\.com\/anomaly|unusual traffic/i;

/** Words that carry no subject, so they cannot decide whether a page is on topic. */
const QUERY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "you",
  "are",
  "how",
  "what",
  "why",
  "when",
  "where",
  "who",
  "can",
  "does",
  "was",
  "were",
  "best",
  "top",
  "use",
  "using",
  "into",
  "about",
  "more",
  "than",
  "not",
  "but",
  "all",
  "any",
  "get",
  "get",
  "guide",
  "guides",
  "tutorial",
]);

/** The words in a query that decide whether a page is about it. */
export function significantTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((token) => token.length > 2 && !QUERY_STOPWORDS.has(token));
}

/** A page is on topic when it names at least one of the query's own words. */
export function isRelevantToQuery(entry: SerpEntry, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${entry.title} ${entry.url} ${entry.snippet}`.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

/** Keeps the pages that talk about the query and drops the rest. */
export function filterRelevant(
  entries: SerpEntry[],
  tokens: string[],
): SerpEntry[] {
  return entries.filter((entry) => isRelevantToQuery(entry, tokens));
}

export type SerpEndpoint = "duckduckgo" | "rightdao" | "bing" | "none";

export interface OrganicSearch {
  entries: SerpEntry[];
  endpoint: SerpEndpoint;
  silent: string[];
}

/**
 * Reads a live result page. The endpoints are tried in order of answer
 * quality, and every page has to name the query or it is dropped, because a
 * feed that answers with unrelated pages is worse than no answer at all.
 */
export async function fetchOrganic(
  query: string,
  ctx: NetContext = {},
): Promise<OrganicSearch> {
  const tokens = significantTokens(query);
  const silent: string[] = [];

  const duck = filterRelevant(await fetchDdgOrganic(query, ctx), tokens);
  if (duck.length > 0) return { entries: duck, endpoint: "duckduckgo", silent };

  const right = filterRelevant(await fetchRightDao(query, ctx), tokens);
  if (right.length > 0) {
    return { entries: right, endpoint: "rightdao", silent: ["duckduckgo"] };
  }

  const bing = filterRelevant(
    await fetchSerpFeed(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&mkt=en-US&count=20`,
      withTimeout(ctx, SERP_TIMEOUT_MS),
    ),
    tokens,
  );
  if (bing.length > 0) {
    return {
      entries: bing,
      endpoint: "bing",
      silent: ["duckduckgo", "rightdao"],
    };
  }
  return {
    entries: [],
    endpoint: "none",
    silent: ["duckduckgo", "rightdao", "bing"],
  };
}

/** Reads the news pack for a query. */
export async function fetchNews(
  query: string,
  ctx: NetContext = {},
): Promise<SerpEntry[]> {
  const [bing, google] = await Promise.all([
    fetchSerpFeed(
      `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=en-US&count=20`,
      withTimeout(ctx, NEWS_TIMEOUT_MS),
    ),
    fetchGoogleNews(query, ctx),
  ]);
  const merged = [...bing, ...google];
  const seen = new Set<string>();
  const out: SerpEntry[] = [];
  for (const item of merged) {
    const key = item.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, kind: "news" as const });
  }
  return out;
}

/** Reads the Google News feed, used when Bing returns nothing. */
export async function fetchGoogleNews(
  query: string,
  ctx: NetContext = {},
): Promise<SerpEntry[]> {
  const response = await fetchText(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    withTimeout(ctx, NEWS_TIMEOUT_MS),
  );
  if (!response.ok) return [];
  return parseRssItems(response.text)
    .filter((item) => item.link && item.title)
    .map((item, index) => ({
      position: index + 1,
      title: item.title,
      url: item.link,
      domain: domainOf(item.link),
      snippet: item.description,
      kind: "news" as const,
    }));
}

export interface DifficultyComponents {
  authority_share: number;
  domain_concentration: number;
  exact_title_share: number;
  distinct_domains: number;
  results: number;
}

export interface DifficultyEstimate {
  score: number;
  method: string;
  confidence: string;
  components: DifficultyComponents;
  note: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Scores how hard a query looks from the composition of its result page.
 * A page owned by authoritative domains and by few domains is harder to enter.
 */
export function estimateDifficulty(
  query: string,
  entries: SerpEntry[],
): DifficultyEstimate {
  const total = entries.length;
  if (total === 0) {
    return {
      score: 0,
      method: "serp_composition",
      confidence: "none",
      components: {
        authority_share: 0,
        domain_concentration: 0,
        exact_title_share: 0,
        distinct_domains: 0,
        results: 0,
      },
      note: "No results were available, so no competition read was possible.",
    };
  }
  const domains = new Set(entries.map((entry) => entry.domain));
  const authority = entries.filter((entry) =>
    isAuthorityDomain(entry.domain),
  ).length;
  const phrase = query.trim().toLowerCase();
  const exact = entries.filter((entry) =>
    entry.title.toLowerCase().includes(phrase),
  ).length;
  const authorityShare = round2(authority / total);
  const concentration = round2(1 - domains.size / total);
  const exactShare = round2(exact / total);
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(100 * (0.5 * authorityShare + 0.5 * concentration)),
    ),
  );
  return {
    score,
    method: "serp_composition",
    confidence: total >= 8 ? "medium" : "low",
    components: {
      authority_share: authorityShare,
      domain_concentration: concentration,
      exact_title_share: exactShare,
      distinct_domains: domains.size,
      results: total,
    },
    note: "Estimate from the live result page. It is not the Ahrefs keyword difficulty score and it does not use a backlink index.",
  };
}

export interface SerpSnapshot {
  keyword: string;
  generated_at: string;
  results: SerpEntry[];
  news: SerpEntry[];
  difficulty_estimate: DifficultyEstimate;
  source: "serp";
  endpoint: SerpEndpoint;
  endpoints_silent: string[];
  note: string;
}

export interface SerpOptions {
  limit?: number;
  ctx?: NetContext;
  now?: Date;
}

export async function getSerpSnapshot(
  query: string,
  options: SerpOptions = {},
): Promise<SerpSnapshot> {
  const limit = options.limit ?? 10;
  const ctx = options.ctx ?? {};
  const now = options.now ?? new Date();
  const [organic, news] = await Promise.all([
    fetchOrganic(query, ctx),
    fetchNews(query, ctx),
  ]);
  const results = organic.entries.slice(0, limit);
  const note =
    organic.endpoint === "none"
      ? "No public endpoint returned a page about this query, so there is no competition read."
      : "Pages that did not name the query were dropped.";
  return {
    keyword: query,
    generated_at: now.toISOString(),
    results,
    news: news.slice(0, limit),
    difficulty_estimate: estimateDifficulty(query, results),
    source: "serp",
    endpoint: organic.endpoint,
    endpoints_silent: organic.silent,
    note,
  };
}
