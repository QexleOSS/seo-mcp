/**
 * What is moving right now.
 *
 * Google Trends' daily RSS is the only keyless feed that publishes a ranked
 * list of live searches with a traffic band. Wikipedia's pageview API adds a
 * slower-moving editorial signal, and Bing's news RSS covers a specific niche
 * on demand.
 */

import { fetchJson, fetchText, withTimeout, type NetContext } from "./net.ts";
import {
  namespacedTagValue,
  parseRssItems,
  parseWikipediaTop,
  tagValue,
} from "./xml.ts";

/** Deadlines for the trend feeds, so a stalled feed cannot stall the tool. */
export const TRENDS_TIMEOUT_MS = 15000;
export const NEWS_TIMEOUT_MS = 15000;

export interface TrendItem {
  title: string;
  source: "google_trends" | "wikipedia" | "bing_news";
  traffic?: string;
  views?: number;
  published_at?: string;
  url?: string;
}

export interface TrendsResult {
  geo: string;
  generated_at: string;
  trends: TrendItem[];
  wikipedia_top: TrendItem[];
  niche_news: TrendItem[];
  source: "trends";
  note?: string;
}

/** Parses the Google Trends daily RSS. */
export function parseTrends(xml: string): TrendItem[] {
  const pattern = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  const items: TrendItem[] = [];
  let match = pattern.exec(xml);
  while (match) {
    const block = match[1] ?? "";
    const title = tagValue(block, "title");
    if (title) {
      const newsBlock =
        /<ht:news_item(?:\s[^>]*)?>([\s\S]*?)<\/ht:news_item>/.exec(block)?.[1];
      const traffic = namespacedTagValue(block, "ht:approx_traffic");
      const pubDate = tagValue(block, "pubDate");
      items.push({
        title,
        source: "google_trends",
        ...(traffic ? { traffic } : {}),
        ...(pubDate ? { published_at: pubDate } : {}),
        ...(newsBlock
          ? {
              url: namespacedTagValue(newsBlock, "ht:news_item_url"),
            }
          : {}),
      });
    }
    match = pattern.exec(xml);
  }
  return items;
}

export async function fetchTrends(
  geo: string,
  ctx: NetContext = {},
): Promise<TrendItem[]> {
  const response = await fetchText(
    `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`,
    withTimeout(ctx, TRENDS_TIMEOUT_MS),
  );
  if (!response.ok) return [];
  return parseTrends(response.text);
}

/** The pageview API publishes with a lag, so ask for a few days back. */
export function wikiTopDate(now: Date): string {
  const shifted = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3),
  );
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

export async function fetchWikipediaTop(
  ctx: NetContext = {},
  now: Date = new Date(),
): Promise<TrendItem[]> {
  const payload = await fetchJson(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${wikiTopDate(now)}`,
    withTimeout(ctx, TRENDS_TIMEOUT_MS),
  );
  return parseWikipediaTop(payload).map((entry) => ({
    title: entry.article,
    source: "wikipedia" as const,
    views: entry.views,
  }));
}

export async function fetchNicheNews(
  niche: string,
  ctx: NetContext = {},
): Promise<TrendItem[]> {
  const response = await fetchText(
    `https://www.bing.com/news/search?q=${encodeURIComponent(niche)}&format=rss&mkt=en-US`,
    withTimeout(ctx, NEWS_TIMEOUT_MS),
  );
  if (!response.ok) return [];
  return parseRssItems(response.text)
    .filter((item) => item.title)
    .map((item) => ({
      title: item.title,
      source: "bing_news" as const,
      published_at: item.pubDate,
      url: item.link,
    }));
}

/** Keeps the items that mention the niche. */
export function filterByNiche(items: TrendItem[], niche: string): TrendItem[] {
  const needle = niche.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => item.title.toLowerCase().includes(needle));
}

export interface TrendsOptions {
  geo?: string;
  niche?: string;
  limit?: number;
  ctx?: NetContext;
  now?: Date;
}

export async function getTrends(
  options: TrendsOptions = {},
): Promise<TrendsResult> {
  const geo = options.geo ?? "US";
  const limit = options.limit ?? 20;
  const ctx = options.ctx ?? {};
  const now = options.now ?? new Date();
  const [daily, wiki, news] = await Promise.all([
    fetchTrends(geo, ctx),
    fetchWikipediaTop(ctx, now),
    options.niche ? fetchNicheNews(options.niche, ctx) : Promise.resolve([]),
  ]);
  const matched = options.niche ? filterByNiche(daily, options.niche) : daily;
  // The daily feed holds roughly twenty searches for the whole country. A niche
  // that does not appear in it gets the unfiltered feed instead of nothing.
  const useFallback =
    Boolean(options.niche) && matched.length === 0 && daily.length > 0;
  const trends = useFallback ? daily : matched;
  return {
    geo,
    generated_at: now.toISOString(),
    trends: trends.slice(0, limit),
    wikipedia_top: wiki.slice(0, limit),
    niche_news: news.slice(0, limit),
    source: "trends",
    ...(useFallback
      ? {
          note: `No daily search trend matched "${options.niche}", so the unfiltered daily feed is shown. The niche news list below is filtered.`,
        }
      : {}),
  };
}
