/**
 * On-page audit.
 *
 * Everything here comes from the page itself, so it works for any public URL
 * with no key. The optional PageSpeed read uses Google's public endpoint,
 * which is quota limited and often busy, so a failure is reported instead of
 * being hidden.
 */

import { fetchJson, fetchText, withTimeout, type NetContext } from "./net.ts";
import { stripTags } from "./xml.ts";

/** Deadlines for the audit reads. */
export const PAGE_TIMEOUT_MS = 15000;
export const PAGESPEED_TIMEOUT_MS = 8000;

export type CheckStatus = "pass" | "warn" | "fail";

export interface AuditCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface PerformanceReport {
  score: number;
  strategy: string;
  field: string | null;
  fcp: string | null;
  lcp: string | null;
  cls: string | null;
}

export interface AuditReport {
  url: string;
  final_url: string;
  status: number;
  https: boolean;
  response_ms: number;
  title: string;
  word_count: number;
  checks: AuditCheck[];
  score: number;
  performance: PerformanceReport | null;
  source: "http";
  notes: string[];
}

export interface PageFacts {
  title: string;
  description: string;
  canonical: string;
  viewport: boolean;
  robots: string;
  ogTitle: boolean;
  h1Count: number;
  jsonLdCount: number;
  imagesMissingAlt: number;
  imageCount: number;
  wordCount: number;
}

function attributesOf(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']([^"']*)["']/g;
  let match = pattern.exec(tag);
  while (match) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? "";
    if (!(name in attributes)) attributes[name] = value;
    match = pattern.exec(tag);
  }
  return attributes;
}

/** Pulls the facts an audit needs out of a page's HTML. */
export function extractPageFacts(html: string): PageFacts {
  const titleMatch = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1] ?? "") : "";
  const metas: Record<string, string> = {};
  let ogTitle = false;
  const metaPattern = /<meta\b[^>]*>/gi;
  let metaMatch = metaPattern.exec(html);
  while (metaMatch) {
    const attributes = attributesOf(metaMatch[0]);
    const key = (
      attributes["name"] ??
      attributes["property"] ??
      ""
    ).toLowerCase();
    if (key && !(key in metas)) metas[key] = attributes["content"] ?? "";
    if (key === "og:title" || key === "og:title:") ogTitle = true;
    metaMatch = metaPattern.exec(html);
  }
  const canonicalMatch = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.exec(html);
  const canonical = canonicalMatch
    ? (attributesOf(canonicalMatch[0])["href"] ?? "")
    : "";
  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  const jsonLdCount = (
    html.match(/<script\b[^>]*type=["']application\/ld\+json["']/gi) ?? []
  ).length;
  const imagePattern = /<img\b[^>]*>/gi;
  let imageCount = 0;
  let imagesMissingAlt = 0;
  let imageMatch = imagePattern.exec(html);
  while (imageMatch) {
    imageCount += 1;
    const attributes = attributesOf(imageMatch[0]);
    if (!("alt" in attributes)) imagesMissingAlt += 1;
    imageMatch = imagePattern.exec(html);
  }
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const body = bodyMatch ? (bodyMatch[1] ?? "") : html;
  const text = stripTags(body);
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
  return {
    title,
    description: metas["description"] ?? "",
    canonical,
    viewport: "viewport" in metas,
    robots: metas["robots"] ?? "",
    ogTitle,
    h1Count,
    jsonLdCount,
    imagesMissingAlt,
    imageCount,
    wordCount,
  };
}

function statusFor(passed: boolean, warned: boolean): CheckStatus {
  if (passed) return "pass";
  return warned ? "warn" : "fail";
}

export function buildChecks(
  facts: PageFacts,
  https: boolean,
  ms: number,
): AuditCheck[] {
  const titleLength = facts.title.length;
  const descriptionLength = facts.description.length;
  return [
    {
      name: "title",
      status: statusFor(
        titleLength >= 10 && titleLength <= 60,
        titleLength > 0,
      ),
      detail: `title is ${titleLength} characters`,
    },
    {
      name: "meta_description",
      status: statusFor(
        descriptionLength >= 50 && descriptionLength <= 160,
        descriptionLength > 0,
      ),
      detail: `meta description is ${descriptionLength} characters`,
    },
    {
      name: "canonical",
      status: facts.canonical ? "pass" : "warn",
      detail: facts.canonical
        ? `canonical points at ${facts.canonical}`
        : "no canonical link found",
    },
    {
      name: "viewport",
      status: facts.viewport ? "pass" : "fail",
      detail: facts.viewport
        ? "viewport meta tag found"
        : "no viewport meta tag found",
    },
    {
      name: "h1",
      status: statusFor(facts.h1Count === 1, facts.h1Count > 0),
      detail: `${facts.h1Count} h1 headings`,
    },
    {
      name: "open_graph",
      status: facts.ogTitle ? "pass" : "warn",
      detail: facts.ogTitle ? "og:title found" : "no og:title found",
    },
    {
      name: "structured_data",
      status: statusFor(facts.jsonLdCount > 0, false),
      detail: `${facts.jsonLdCount} JSON-LD blocks`,
    },
    {
      name: "image_alt",
      status: statusFor(
        facts.imagesMissingAlt === 0,
        facts.imagesMissingAlt <= 3,
      ),
      detail: `${facts.imagesMissingAlt} of ${facts.imageCount} images have no alt attribute`,
    },
    {
      name: "indexable",
      status: facts.robots.toLowerCase().includes("noindex") ? "fail" : "pass",
      detail: facts.robots
        ? `robots meta says "${facts.robots}"`
        : "no robots meta tag, page is indexable by default",
    },
    {
      name: "content_depth",
      status: statusFor(facts.wordCount >= 300, facts.wordCount >= 120),
      detail: `${facts.wordCount} words in the body`,
    },
    {
      name: "https",
      status: https ? "pass" : "fail",
      detail: https ? "served over https" : "not served over https",
    },
    {
      name: "response_time",
      status: statusFor(ms <= 2500, ms <= 5000),
      detail: `${ms} ms to first byte`,
    },
  ];
}

export function scoreChecks(checks: AuditCheck[]): number {
  if (checks.length === 0) return 0;
  const total = checks.reduce((sum, check) => {
    if (check.status === "pass") return sum + 1;
    if (check.status === "warn") return sum + 0.5;
    return sum;
  }, 0);
  return Math.round((total / checks.length) * 100);
}

export async function fetchPageSpeed(
  url: string,
  strategy: "mobile" | "desktop" = "mobile",
  ctx: NetContext = {},
): Promise<PerformanceReport | null> {
  const payload = await fetchJson(
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=PERFORMANCE`,
    withTimeout(ctx, PAGESPEED_TIMEOUT_MS),
  );
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const categories = record["categories"] as
    Record<string, unknown> | undefined;
  const performance = categories?.["performance"] as
    Record<string, unknown> | undefined;
  const rawScore = performance?.["score"];
  const audits = (record["audits"] ?? {}) as Record<string, unknown>;
  const metric = (id: string): string | null => {
    const entry = audits[id] as Record<string, unknown> | undefined;
    const value = entry?.["displayValue"];
    return typeof value === "string" ? value : null;
  };
  if (typeof rawScore !== "number") return null;
  return {
    score: Math.round(rawScore * 100),
    strategy,
    field: metric("field-performance"),
    fcp: metric("first-contentful-paint"),
    lcp: metric("largest-contentful-paint"),
    cls: metric("cumulative-layout-shift"),
  };
}

export interface AuditOptions {
  includePerformance?: boolean;
  ctx?: NetContext;
  now?: Date;
}

export async function auditUrl(
  url: string,
  options: AuditOptions = {},
): Promise<AuditReport> {
  const ctx = options.ctx ?? {};
  const response = await fetchText(url, withTimeout(ctx, PAGE_TIMEOUT_MS));
  const notes: string[] = [];
  if (!response.ok) {
    notes.push(
      `the page could not be read: ${response.error ?? "unknown error"}`,
    );
    return {
      url,
      final_url: response.finalUrl,
      status: response.status,
      https: response.finalUrl.startsWith("https://"),
      response_ms: response.ms,
      title: "",
      word_count: 0,
      checks: [],
      score: 0,
      performance: null,
      source: "http",
      notes,
    };
  }
  const facts = extractPageFacts(response.text);
  const https = response.finalUrl.startsWith("https://");
  const checks = buildChecks(facts, https, response.ms);
  let performance: PerformanceReport | null = null;
  if (options.includePerformance) {
    performance = await fetchPageSpeed(response.finalUrl, "mobile", ctx);
    if (!performance) {
      notes.push(
        "the PageSpeed endpoint refused the request, its anonymous quota is shared and often exhausted",
      );
    }
  }
  return {
    url,
    final_url: response.finalUrl,
    status: response.status,
    https,
    response_ms: response.ms,
    title: facts.title,
    word_count: facts.wordCount,
    checks,
    score: scoreChecks(checks),
    performance,
    source: "http",
    notes,
  };
}
