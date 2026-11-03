/**
 * Keyless backlink discovery.
 *
 * Search engines do not offer a free backlink index. What they do offer is
 * the pages that mention a domain, and those pages can be fetched and checked
 * for a real link. Every result here was verified by reading the page.
 */

import { fetchText, withTimeout, type NetContext } from "./net.ts";
import { domainOf, fetchDdgOrganic, SERP_TIMEOUT_MS } from "./serp.ts";
import { parseRssItems } from "./xml.ts";

export interface LinkCandidate {
  url: string;
  title: string;
  snippet: string;
  domain: string;
}

export interface Backlink {
  source_url: string;
  source_domain: string;
  source_title: string;
  anchor: string;
  target: string;
}

export interface BacklinkReport {
  domain: string;
  backlinks: Backlink[];
  referring_domains: string[];
  candidates_checked: number;
  method: string;
  source: "estimate";
  note: string;
}

const BACKLINK_NOTE =
  "Verified by fetching each linking page and reading its anchor text. This is a sample found through public search results, not a complete backlink index.";

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function hostMatchesTarget(host: string, target: string): boolean {
  const normalized = normalizeHost(host);
  const wanted = normalizeHost(target);
  if (!normalized || !wanted) return false;
  return normalized === wanted || normalized.endsWith(`.${wanted}`);
}

/** Reads the anchor text of every link on a page that points at the target. */
export function extractAnchorsTo(
  html: string,
  pageUrl: string,
  target: string,
): string[] {
  const anchors: string[] = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match = pattern.exec(html);
  while (match) {
    const href = match[1] ?? "";
    const text = (match[2] ?? "").replace(/<[^>]*>/g, "").trim();
    if (href && !href.startsWith("#")) {
      let resolved: URL | null = null;
      try {
        resolved = new URL(href, pageUrl);
      } catch {
        resolved = null;
      }
      if (resolved && hostMatchesTarget(resolved.hostname, target)) {
        anchors.push(text || resolved.hostname);
      }
    }
    match = pattern.exec(html);
  }
  return anchors;
}

/** Finds pages that mention the domain, dropping the domain's own pages. */
export async function findLinkingPages(
  domain: string,
  ctx: NetContext = {},
  limit = 10,
): Promise<LinkCandidate[]> {
  const query = `"${domain}" -site:${domain}`;
  const duck = await fetchDdgOrganic(query, ctx);
  if (duck.length > 0) {
    return duck
      .filter((entry) => !hostMatchesTarget(entry.domain, domain))
      .slice(0, limit)
      .map((entry) => ({
        url: entry.url,
        title: entry.title,
        snippet: entry.snippet,
        domain: entry.domain,
      }));
  }
  const response = await fetchText(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&mkt=en-US&count=20`,
    withTimeout(ctx, SERP_TIMEOUT_MS),
  );
  if (!response.ok) return [];
  return parseRssItems(response.text)
    .filter((item) => item.link && item.title)
    .map((item) => ({
      url: item.link,
      title: item.title,
      snippet: item.description,
      domain: domainOf(item.link),
    }))
    .filter((item) => !hostMatchesTarget(item.domain, domain))
    .slice(0, limit);
}

/** Fetches a candidate and keeps it only if it really links to the target. */
export async function verifyBacklink(
  candidate: LinkCandidate,
  target: string,
  ctx: NetContext = {},
): Promise<Backlink | null> {
  const response = await fetchText(candidate.url, ctx);
  if (!response.ok) return null;
  const anchors = extractAnchorsTo(response.text, candidate.url, target);
  const anchor = anchors[0];
  if (!anchor) return null;
  return {
    source_url: candidate.url,
    source_domain: candidate.domain,
    source_title: candidate.title,
    anchor,
    target,
  };
}

export interface BacklinkOptions {
  domain: string;
  limit?: number;
  ctx?: NetContext;
}

/** How many candidate pages are read at the same time. */
const VERIFY_BATCH = 6;

/** A page that has not answered in this long is not worth waiting for. */
const VERIFY_TIMEOUT_MS = 8000;

/** Discovers and verifies backlinks for a domain without any API key. */
export async function getBacklinksEstimate(
  options: BacklinkOptions,
): Promise<BacklinkReport> {
  const { domain } = options;
  const limit = options.limit ?? 5;
  const ctx = options.ctx ?? {};
  const readCtx: NetContext = {
    ...ctx,
    timeoutMs: Math.min(ctx.timeoutMs ?? 9000, VERIFY_TIMEOUT_MS),
  };
  const candidates = await findLinkingPages(domain, ctx, limit * 2);
  const backlinks: Backlink[] = [];
  let checked = 0;
  for (
    let start = 0;
    start < candidates.length && backlinks.length < limit;
    start += VERIFY_BATCH
  ) {
    const batch = candidates.slice(start, start + VERIFY_BATCH);
    const settled = await Promise.allSettled(
      batch.map((candidate) => verifyBacklink(candidate, domain, readCtx)),
    );
    checked += batch.length;
    for (const outcome of settled) {
      if (outcome.status !== "fulfilled" || !outcome.value) continue;
      backlinks.push(outcome.value);
      if (backlinks.length >= limit) break;
    }
  }
  const referring = [...new Set(backlinks.map((entry) => entry.source_domain))];
  return {
    domain,
    backlinks,
    referring_domains: referring,
    candidates_checked: checked,
    method: "search_mentions_verified_by_fetch",
    source: "estimate",
    note: BACKLINK_NOTE,
  };
}

export interface IndexedPage {
  title: string;
  url: string;
}

/** Lists the pages of a domain that the search engine currently shows. */
export async function findIndexedPages(
  domain: string,
  ctx: NetContext = {},
  limit = 10,
): Promise<IndexedPage[]> {
  const response = await fetchText(
    `https://www.bing.com/search?q=${encodeURIComponent(`site:${domain}`)}&format=rss&mkt=en-US&count=20`,
    withTimeout(ctx, SERP_TIMEOUT_MS),
  );
  if (!response.ok) return [];
  return parseRssItems(response.text)
    .filter((item) => item.link)
    .slice(0, limit)
    .map((item) => ({ title: item.title, url: item.link }));
}
