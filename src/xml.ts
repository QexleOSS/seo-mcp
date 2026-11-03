/**
 * Small XML/HTML helpers. The providers speak RSS and plain HTML, so the
 * project carries a focused parser instead of a dependency.
 */

import { isRecord } from "./json.ts";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/** Decodes the entity set that RSS and page titles actually use. */
export function decodeEntities(value: string): string {
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, entity: string) => {
      const key = entity.toLowerCase();
      if (key.startsWith("#x")) {
        const code = Number.parseInt(key.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (key.startsWith("#")) {
        const code = Number.parseInt(key.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      const named = NAMED_ENTITIES[key];
      return named ?? match;
    },
  );
}

/** Removes tags and collapses whitespace. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads the text of the first `<tag>...</tag>` inside a block. */
export function tagValue(block: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(
    block,
  );
  if (!match) return "";
  return stripTags(match[1] ?? "");
}

/** Reads a self-closing or attribute-style tag such as `<ht:approx_traffic>`. */
export function namespacedTagValue(block: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(
    block,
  );
  if (!match) return "";
  return stripTags(match[1] ?? "");
}

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

/** Parses the `<item>` blocks of an RSS feed. */
export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const pattern = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let match = pattern.exec(xml);
  while (match) {
    const block = match[1] ?? "";
    items.push({
      title: tagValue(block, "title"),
      link: tagValue(block, "link"),
      description: tagValue(block, "description"),
      pubDate: tagValue(block, "pubDate"),
    });
    match = pattern.exec(xml);
  }
  return items;
}

/**
 * Unwraps the redirect wrappers that search engines put around result links.
 * Only the two known wrappers are unwrapped, so a result URL that happens to
 * carry its own `url` query parameter is left alone.
 */
export function unwrapRedirect(url: string): string {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url, "https://duckduckgo.com");
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  const isDuck =
    host.endsWith("duckduckgo.com") && parsed.pathname.startsWith("/l/");
  const isBing =
    host.endsWith("bing.com") && parsed.pathname.includes("apiclick");
  if (!isDuck && !isBing) return url;
  const target = parsed.searchParams.get(isDuck ? "uddg" : "url");
  return target ?? url;
}

export interface LiteResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parses the DuckDuckGo lite page. The markup is a plain table, one anchor per
 * result with the class `result-link`, followed by a snippet cell.
 */
export function parseDdgLite(html: string): LiteResult[] {
  const links: { title: string; url: string }[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  let match = anchor.exec(html);
  while (match) {
    const attributes = match[1] ?? "";
    if (/class=['"][^'"]*result-link/.test(attributes)) {
      const href = /href=['"]([^'"]+)['"]/.exec(attributes)?.[1] ?? "";
      const title = stripTags(match[2] ?? "");
      const url = unwrapRedirect(href);
      if (title && url) links.push({ title, url });
    }
    match = anchor.exec(html);
  }
  const snippets: string[] = [];
  const snippetPattern =
    /<td[^>]*class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/g;
  let snippetMatch = snippetPattern.exec(html);
  while (snippetMatch) {
    snippets.push(stripTags(snippetMatch[1] ?? ""));
    snippetMatch = snippetPattern.exec(html);
  }
  return links.map((link, index) => ({
    title: link.title,
    url: link.url,
    snippet: snippets[index] ?? "",
  }));
}

/**
 * Parses the Right Dao result page. Each result sits in an `item` block with a
 * title anchor, a description and the display URL.
 */
export function parseRightDaoHtml(html: string): LiteResult[] {
  const results: LiteResult[] = [];
  const blocks = html.split(/<div class="item"/).slice(1);
  for (const block of blocks) {
    const href = /<div class="title"[^>]*>\s*<a[^>]*href="([^"]+)"/.exec(
      block,
    )?.[1];
    if (!href || !/^https?:\/\//.test(href)) continue;
    const title = stripTags(
      /<div class="ellipsis-lg"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "",
    ).trim();
    if (!title) continue;
    const description = stripTags(
      /<div class="description"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "",
    )
      .replace(/^\s*\w{3}\s+\d{1,2},\s+\d{4}\s*-\s*/, "")
      .trim();
    results.push({ title, url: href, snippet: description });
  }
  return results;
}

/** Parses a JSON array payload shaped like `[query, [suggestions]]`. */
export function parseSuggestionPayload(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  const list = payload[1];
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (text) out.push(text);
  }
  return out;
}

/** Parses the Wikipedia top-pageviews payload. */
export function parseWikipediaTop(
  payload: unknown,
): { article: string; views: number; rank: number }[] {
  if (!isRecord(payload) || !Array.isArray(payload["items"])) return [];
  const out: { article: string; views: number; rank: number }[] = [];
  for (const item of payload["items"]) {
    if (!isRecord(item) || !Array.isArray(item["articles"])) continue;
    for (const article of item["articles"]) {
      if (!isRecord(article)) continue;
      const name = article["article"];
      if (typeof name !== "string" || !name) continue;
      const views = article["views"];
      const rank = article["rank"];
      out.push({
        article: name.replace(/_/g, " "),
        views: typeof views === "number" ? views : 0,
        rank: typeof rank === "number" ? rank : 0,
      });
    }
  }
  return out;
}
