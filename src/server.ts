import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getBacklinks,
  getSignatureAndOverview,
  loadSignatureFromCache,
  normalizeDomain,
} from "./backlinks.ts";
import { getKeywordDifficulty, getKeywordIdeas } from "./keywords.ts";
import { checkTraffic } from "./traffic.ts";
import type { JsonObject } from "./json.ts";
import { auditUrl } from "./audit.ts";
import { findIndexedPages, getBacklinksEstimate } from "./linkcheck.ts";
import { getSerpSnapshot } from "./serp.ts";
import { researchKeywords } from "./suggest.ts";
import { getTrends } from "./trends.ts";
import { hasCapsolverKey } from "./tier.ts";

const CAPSOLVER_CREATE_TASK = "https://api.capsolver.com/createTask";
const CAPSOLVER_TASK_RESULT = "https://api.capsolver.com/getTaskResult";
const TURNSTILE_SITE_KEY = "0x4AAAAAAAAzi9ITzSN9xKMi";

function urlQuote(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("%2F", "/")
    .replaceAll("%2f", "/");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// A single tool call must not poll forever: a task stuck in "processing" (or
// any unrecognized status) would otherwise occupy the handler indefinitely
// while repeating authenticated POSTs with the operator key.
const CAPSOLVER_MAX_POLLS = 60;
const CAPSOLVER_POLL_INTERVAL_MS = 1000;
const CAPSOLVER_FETCH_TIMEOUT_MS = 20_000;

export interface CapsolverPollOptions {
  /** How many times to ask for the task result before giving up. */
  maxPolls?: number;
  /** How long to wait between two polls. */
  pollIntervalMs?: number;
}

function capsolverFetch(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CAPSOLVER_FETCH_TIMEOUT_MS),
  });
}

export async function getCapsolverToken(
  siteUrl: string,
  options: CapsolverPollOptions = {},
): Promise<string | null> {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return null;
  const maxPolls = options.maxPolls ?? CAPSOLVER_MAX_POLLS;
  const pollIntervalMs = options.pollIntervalMs ?? CAPSOLVER_POLL_INTERVAL_MS;
  try {
    const createResponse = await capsolverFetch(CAPSOLVER_CREATE_TASK, {
      clientKey: apiKey,
      task: {
        type: "AntiTurnstileTaskProxyLess",
        websiteKey: TURNSTILE_SITE_KEY,
        websiteURL: siteUrl,
        metadata: { action: "" },
      },
    });
    const created: unknown = await createResponse.json();
    if (
      typeof created !== "object" ||
      created === null ||
      !("taskId" in created)
    )
      return null;
    const taskId = created.taskId;
    if (typeof taskId !== "string" || !taskId) return null;

    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      await sleep(pollIntervalMs);
      const resultResponse = await capsolverFetch(CAPSOLVER_TASK_RESULT, {
        clientKey: apiKey,
        taskId,
      });
      const result: unknown = await resultResponse.json();
      if (typeof result !== "object" || result === null) return null;
      const record = result as {
        status?: unknown;
        errorId?: unknown;
        solution?: unknown;
      };
      if (record.status === "ready") {
        if (typeof record.solution !== "object" || record.solution === null)
          return null;
        const token = (record.solution as { token?: unknown }).token;
        return typeof token === "string" ? token : null;
      }
      if (record.status === "failed" || record.errorId) return null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function getBacklinksList(domain: string): Promise<JsonObject> {
  const normalizedDomain = normalizeDomain(domain);
  let [signature, validUntil, overview] =
    loadSignatureFromCache(normalizedDomain);
  if (!signature || !validUntil) {
    const siteUrl = `https://ahrefs.com/backlink-checker/?input=${normalizedDomain}&mode=subdomains`;
    const token = await getCapsolverToken(siteUrl);
    if (!token)
      throw new Error(`Failed to get verification token for domain: ${domain}`);
    [signature, validUntil, overview] = await getSignatureAndOverview(
      token,
      normalizedDomain,
    );
    if (!signature || !validUntil)
      throw new Error(`Failed to get signature for domain: ${domain}`);
  }
  return {
    overview,
    backlinks: await getBacklinks(signature, validUntil, normalizedDomain),
  };
}

export async function keywordGenerator(
  keyword: string,
  country = "us",
  searchEngine = "Google",
) {
  const siteUrl = `https://ahrefs.com/keyword-generator/?country=${country}&input=${urlQuote(keyword)}`;
  const token = await getCapsolverToken(siteUrl);
  if (!token)
    throw new Error(`Failed to get verification token for keyword: ${keyword}`);
  return getKeywordIdeas(token, keyword, country, searchEngine);
}

export async function getTraffic(
  domainOrUrl: string,
  country = "None",
  mode: "subdomains" | "exact" = "subdomains",
) {
  const siteUrl = `https://ahrefs.com/traffic-checker/?input=${domainOrUrl}&mode=${mode}`;
  const token = await getCapsolverToken(siteUrl);
  if (!token)
    throw new Error(
      `Failed to get verification token for domain: ${domainOrUrl}`,
    );
  return checkTraffic(token, domainOrUrl, mode, country);
}

export async function keywordDifficulty(keyword: string, country = "us") {
  const siteUrl = `https://ahrefs.com/keyword-difficulty/?country=${country}&input=${urlQuote(keyword)}`;
  const token = await getCapsolverToken(siteUrl);
  if (!token)
    throw new Error(`Failed to get verification token for keyword: ${keyword}`);
  return getKeywordDifficulty(token, keyword, country);
}

export function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

/** Reads the package version so the server reports the release it ships in. */
export function readVersion(directory?: string): string {
  try {
    const path = join(directory ?? import.meta.dir, "..", "package.json");
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    )
      return (parsed as { version: string }).version;
    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function getTrendingTool({
  niche,
  geo,
  limit,
}: {
  niche?: string;
  geo?: string;
  limit?: number;
}) {
  return toolResult(await getTrends({ niche, geo, limit }));
}

export async function getKeywordResearchTool({
  seed,
  limit,
  depth,
}: {
  seed: string;
  limit?: number;
  depth?: "quick" | "deep";
}) {
  return toolResult(await researchKeywords(seed, { limit, depth }));
}

export async function getSerpSnapshotTool({
  keyword,
  limit,
}: {
  keyword: string;
  limit?: number;
}) {
  return toolResult(await getSerpSnapshot(keyword, { limit }));
}

export async function getTechnicalAuditTool({
  url,
  include_performance,
}: {
  url: string;
  include_performance?: boolean;
}) {
  return toolResult(
    await auditUrl(url, { includePerformance: include_performance }),
  );
}

export async function getBacklinksTool({
  domain,
  limit,
}: {
  domain: string;
  limit?: number;
}) {
  if (hasCapsolverKey()) {
    return toolResult({
      source: "ahrefs",
      tier: "ahrefs",
      ...(await getBacklinksList(domain)),
    });
  }
  const report = await getBacklinksEstimate({ domain, limit });
  return toolResult({ tier: "keyless", ...report });
}

export async function getTrafficTool({
  domain_or_url,
  country,
  mode,
  limit,
}: {
  domain_or_url: string;
  country?: string;
  mode?: "subdomains" | "exact";
  limit?: number;
}) {
  if (hasCapsolverKey()) {
    return toolResult({
      source: "ahrefs",
      tier: "ahrefs",
      ...(await getTraffic(domain_or_url, country, mode)),
    });
  }
  const domain = normalizeDomain(domain_or_url);
  const [report, indexed] = await Promise.all([
    getBacklinksEstimate({ domain, limit }),
    findIndexedPages(domain),
  ]);
  return toolResult({
    tier: "keyless",
    source: "estimate",
    domain,
    referring_domains: report.referring_domains,
    backlinks: report.backlinks,
    indexed_pages: indexed,
    note: "Traffic numbers come from a clickstream model that no keyless source has. What is here is measurable: verified backlinks, referring domains, and the pages the search engine currently shows.",
  });
}

export async function keywordGeneratorTool({
  keyword,
  country,
  search_engine,
}: {
  keyword: string;
  country?: string;
  search_engine?: string;
}) {
  if (hasCapsolverKey()) {
    return toolResult({
      source: "ahrefs",
      tier: "ahrefs",
      keyword: keyword,
      keyword_ideas: await keywordGenerator(keyword, country, search_engine),
    });
  }
  return getKeywordResearchTool({ seed: keyword });
}

export async function keywordDifficultyTool({
  keyword,
  country,
}: {
  keyword: string;
  country?: string;
}) {
  if (hasCapsolverKey()) {
    return toolResult({
      source: "ahrefs",
      tier: "ahrefs",
      ...(await keywordDifficulty(keyword, country)),
    });
  }
  const snapshot = await getSerpSnapshot(keyword);
  return toolResult({
    source: "estimate",
    tier: "keyless",
    keyword,
    difficulty_estimate: snapshot.difficulty_estimate,
    note: "This is a composition read of the live result page, not the Ahrefs keyword difficulty score.",
  });
}

export const mcp = new McpServer({
  name: "SEO Radar MCP",
  version: readVersion(),
});

mcp.registerTool(
  "get_trending",
  {
    description:
      "What people are searching for right now. Google Trends daily searches, Wikipedia pageviews, and niche news. Filter with a niche keyword.",
    inputSchema: fromJsonSchema<{
      niche?: string;
      geo?: string;
      limit?: number;
    }>({
      type: "object",
      properties: {
        niche: {
          type: "string",
          description:
            'Optional filter, for example "ai seo" or "running shoes"',
        },
        geo: {
          type: "string",
          default: "US",
          description: "Two letter country code for the Trends feed",
        },
        limit: { type: "number", default: 20 },
      },
    }),
  },
  getTrendingTool,
);

mcp.registerTool(
  "get_keyword_research",
  {
    description:
      "Keyword candidates from live autocomplete on Google, Bing, and DuckDuckGo, expanded with question and commercial modifiers. Returns an autocomplete rank, never a made up volume.",
    inputSchema: fromJsonSchema<{
      seed: string;
      limit?: number;
      depth?: "quick" | "deep";
    }>({
      type: "object",
      properties: {
        seed: { type: "string", description: "The seed keyword" },
        limit: { type: "number", default: 20 },
        depth: {
          type: "string",
          enum: ["quick", "deep"],
          default: "deep",
          description:
            "quick asks the seed only, deep adds modifier expansions",
        },
      },
      required: ["seed"],
    }),
  },
  getKeywordResearchTool,
);

mcp.registerTool(
  "get_serp_snapshot",
  {
    description:
      "Who ranks for a keyword right now, the news pack next to it, and a competition read built from the composition of the result page.",
    inputSchema: fromJsonSchema<{ keyword: string; limit?: number }>({
      type: "object",
      properties: {
        keyword: { type: "string" },
        limit: { type: "number", default: 10 },
      },
      required: ["keyword"],
    }),
  },
  getSerpSnapshotTool,
);

mcp.registerTool(
  "get_technical_audit",
  {
    description:
      "On page audit of any public URL: title, description, canonical, viewport, headings, structured data, image alts, indexability, word count, and response time.",
    inputSchema: fromJsonSchema<{
      url: string;
      include_performance?: boolean;
    }>({
      type: "object",
      properties: {
        url: { type: "string", description: "The page to audit" },
        include_performance: {
          type: "boolean",
          default: false,
          description:
            "Also ask the public PageSpeed endpoint, which is quota limited",
        },
      },
      required: ["url"],
    }),
  },
  getTechnicalAuditTool,
);

mcp.registerTool(
  "get_backlinks",
  {
    description:
      "Backlinks for a domain. With a CapSolver key it uses the Ahrefs free tool, without one it finds pages that mention the domain and verifies each link by reading the page.",
    inputSchema: fromJsonSchema<{ domain: string; limit?: number }>({
      type: "object",
      properties: {
        domain: { type: "string" },
        limit: { type: "number", default: 5 },
      },
      required: ["domain"],
    }),
  },
  getBacklinksTool,
);

mcp.registerTool(
  "get_traffic",
  {
    description:
      "Traffic and reach for a domain. With a CapSolver key it returns the Ahrefs traffic estimate, without one it returns verified backlinks, referring domains, and the pages the search engine shows.",
    inputSchema: fromJsonSchema<{
      domain_or_url: string;
      country?: string;
      mode?: "subdomains" | "exact";
      limit?: number;
    }>({
      type: "object",
      properties: {
        domain_or_url: { type: "string" },
        country: { type: "string", default: "None" },
        mode: {
          type: "string",
          enum: ["subdomains", "exact"],
          default: "subdomains",
        },
        limit: { type: "number", default: 5 },
      },
      required: ["domain_or_url"],
    }),
  },
  getTrafficTool,
);

mcp.registerTool(
  "get_backlinks_list",
  {
    description: "Deprecated, use get_backlinks.",
    inputSchema: fromJsonSchema<{ domain: string; limit?: number }>({
      type: "object",
      properties: {
        domain: { type: "string" },
        limit: { type: "number", default: 5 },
      },
      required: ["domain"],
    }),
  },
  getBacklinksTool,
);

mcp.registerTool(
  "keyword_generator",
  {
    description: "Deprecated, use get_keyword_research.",
    inputSchema: fromJsonSchema<{
      keyword: string;
      country?: string;
      search_engine?: string;
    }>({
      type: "object",
      properties: {
        keyword: { type: "string" },
        country: { type: "string", default: "us" },
        search_engine: { type: "string", default: "Google" },
      },
      required: ["keyword"],
    }),
  },
  keywordGeneratorTool,
);

mcp.registerTool(
  "keyword_difficulty",
  {
    description: "Deprecated, use get_serp_snapshot.",
    inputSchema: fromJsonSchema<{ keyword: string; country?: string }>({
      type: "object",
      properties: {
        keyword: { type: "string" },
        country: { type: "string", default: "us" },
      },
      required: ["keyword"],
    }),
  },
  keywordDifficultyTool,
);

export async function main(run: typeof serveStdio = serveStdio): Promise<void> {
  await run(() => mcp);
}
