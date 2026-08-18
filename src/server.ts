import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  getBacklinks,
  getSignatureAndOverview,
  loadSignatureFromCache,
} from "./backlinks.ts";
import { getKeywordDifficulty, getKeywordIdeas } from "./keywords.ts";
import { checkTraffic } from "./traffic.ts";
import type { JsonObject } from "./json.ts";

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

export async function getCapsolverToken(
  siteUrl: string,
): Promise<string | null> {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return null;
  try {
    const createResponse = await fetch(CAPSOLVER_CREATE_TASK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "AntiTurnstileTaskProxyLess",
          websiteKey: TURNSTILE_SITE_KEY,
          websiteURL: siteUrl,
          metadata: { action: "" },
        },
      }),
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

    while (true) {
      await sleep(1000);
      const resultResponse = await fetch(CAPSOLVER_TASK_RESULT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
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
  } catch {
    return null;
  }
}

export async function getBacklinksList(domain: string): Promise<JsonObject> {
  let [signature, validUntil, overview] = loadSignatureFromCache(domain);
  if (!signature || !validUntil) {
    const siteUrl = `https://ahrefs.com/backlink-checker/?input=${domain}&mode=subdomains`;
    const token = await getCapsolverToken(siteUrl);
    if (!token)
      throw new Error(`Failed to get verification token for domain: ${domain}`);
    [signature, validUntil, overview] = await getSignatureAndOverview(
      token,
      domain,
    );
    if (!signature || !validUntil)
      throw new Error(`Failed to get signature for domain: ${domain}`);
  }
  return {
    overview,
    backlinks: await getBacklinks(signature, validUntil, domain),
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

export async function getBacklinksTool({ domain }: { domain: string }) {
  return toolResult(await getBacklinksList(domain));
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
  return toolResult(await keywordGenerator(keyword, country, search_engine));
}

export async function getTrafficTool({
  domain_or_url,
  country,
  mode,
}: {
  domain_or_url: string;
  country?: string;
  mode?: "subdomains" | "exact";
}) {
  return toolResult(await getTraffic(domain_or_url, country, mode));
}

export async function keywordDifficultyTool({
  keyword,
  country,
}: {
  keyword: string;
  country?: string;
}) {
  return toolResult(await keywordDifficulty(keyword, country));
}

export const mcp = new McpServer({ name: "SEO Toolkit MCP", version: "0.1.1" });

mcp.registerTool(
  "get_backlinks_list",
  {
    inputSchema: fromJsonSchema<{ domain: string }>({
      type: "object",
      properties: { domain: { type: "string" } },
      required: ["domain"],
    }),
  },
  getBacklinksTool,
);

mcp.registerTool(
  "keyword_generator",
  {
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
  "get_traffic",
  {
    inputSchema: fromJsonSchema<{
      domain_or_url: string;
      country?: string;
      mode?: "subdomains" | "exact";
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
      },
      required: ["domain_or_url"],
    }),
  },
  getTrafficTool,
);

mcp.registerTool(
  "keyword_difficulty",
  {
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
