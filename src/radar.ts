// The daily radar: one file per day with the demand picture for a niche.
//
//   bunx @qexle/seo-mcp radar --niche "seo tools" --out radar-2026-10-21.md
//
// The numbers come from the same three tools the MCP server exposes, so the
// file and an agent session agree on what the sources said. Every section
// names its source, because a trend and an estimate are not the same thing.
import {
  getKeywordResearchTool,
  getSerpSnapshotTool,
  getTrendingTool,
} from "./server.ts";
import { writeFileSync } from "node:fs";

export const RADAR_CREDIT =
  "Radar built with bunx @qexle/seo-mcp (keyless SEO radar, no API key).";

interface RadarOptions {
  niche: string;
  seed?: string;
  limit: number;
  out?: string;
}

/**
 * The three tools the radar reads. The server functions are the default, and a
 * test can pass its own so the file can be checked without a network.
 */
export interface RadarTools {
  trending(args: { niche: string; limit: number }): Promise<unknown>;
  keywordResearch(args: {
    seed: string;
    limit: number;
    depth: "quick" | "deep";
  }): Promise<unknown>;
  serpSnapshot(args: { keyword: string; limit: number }): Promise<unknown>;
}

const serverTools: RadarTools = {
  trending: getTrendingTool,
  keywordResearch: getKeywordResearchTool,
  serpSnapshot: getSerpSnapshotTool,
};

interface JsonObject {
  [key: string]: unknown;
}

function asObject(value: unknown): JsonObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function asArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.map(asObject);
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function text(value: unknown, fallback = ""): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// The tool results carry a JSON payload inside an MCP content block. The radar
// reads that payload, so a file and an agent session report the same numbers.
function payloadOf(result: unknown): JsonObject {
  const outer = asObject(result);
  const content = Array.isArray(outer.content) ? outer.content : [];
  for (const block of content) {
    const body = asObject(block).text;
    if (typeof body !== "string") continue;
    try {
      const parsed = asObject(JSON.parse(body) as unknown);
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {
      // A tool that returns plain text is not a radar input; skip it.
    }
  }
  return outer;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_Nothing came back for this section._\n";
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return `${lines.join("\n")}\n`;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

export async function buildRadar(
  options: RadarOptions,
  tools: RadarTools = serverTools,
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const parts: string[] = [];

  parts.push(`# SEO radar: ${options.niche}`);
  parts.push(`\n_${date}._`);
  parts.push(`\n${RADAR_CREDIT}\n`);

  const trends = payloadOf(
    await tools.trending({ niche: options.niche, limit: options.limit }),
  );
  const trendRows = asArray(trends.trends).map((item) => [
    text(item.title),
    text(item.source, "unknown"),
    text(item.traffic, "-"),
  ]);
  parts.push(
    section(
      "What people search for now",
      `${table(["term", "source", "traffic"], trendRows)}\nGeo: ${text(
        trends.geo,
        "world",
      )}\n${text(trends.note)}\n`,
    ),
  );

  const seed = options.seed ?? options.niche;
  const research = payloadOf(
    await tools.keywordResearch({
      seed,
      limit: options.limit,
      depth: "quick",
    }),
  );
  const candidates = asArray(research.candidates);
  const candidateRows = candidates.map((item) => [
    text(item.keyword),
    text(item.intent, "unknown"),
    num(item.autocomplete_rank) > 0
      ? String(Math.round(num(item.autocomplete_rank)))
      : "-",
    Array.isArray(item.engines)
      ? item.engines.map((value) => String(value)).join(", ")
      : "-",
  ]);
  parts.push(
    section(
      "Candidate keywords",
      `${table(["keyword", "intent", "autocomplete rank", "engines"], candidateRows)}\n${text(
        research.note,
      )}\n`,
    ),
  );

  const serpKeyword =
    candidates[0] !== undefined ? text(candidates[0].keyword) : seed;
  const serp = payloadOf(
    await tools.serpSnapshot({ keyword: serpKeyword, limit: options.limit }),
  );
  const serpRows = asArray(serp.results).map((item) => [
    String(num(item.position)),
    text(item.domain),
    text(item.title),
  ]);
  const estimate = asObject(serp.difficulty_estimate);
  const serpEndpoint = text(serp.endpoint, "unknown");
  const serpNote = text(serp.note);
  const serpBlock =
    serpRows.length === 0
      ? `${text(serp.note)}\n\nNo competition read was possible for this keyword.\n`
      : `${table(["#", "domain", "title"], serpRows)}\nDifficulty estimate: ${num(
          estimate.score,
        )} (${text(estimate.confidence, "no confidence")} confidence, ${text(
          estimate.method,
          "unknown method",
        )})\n\n${text(estimate.note)}\n`;
  parts.push(
    section(
      `Result page for "${serpKeyword}"`,
      `${serpBlock}\nResult page source: ${serpEndpoint}. ${serpNote}\n`,
    ),
  );

  const sources = [trends.source, research.source, serp.source].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const silent = asStrings(research.engines_silent);
  const serpSilent = asStrings(serp.endpoints_silent);
  parts.push(
    section(
      "Sources",
      `${[...new Set(sources)].map((value) => `- ${value}`).join("\n")}${
        silent.length > 0
          ? `\n\nEngines that stayed silent: ${silent.join(", ")}`
          : ""
      }${
        serpSilent.length > 0
          ? `\n\nResult page endpoints that stayed silent: ${serpSilent.join(", ")}`
          : ""
      }\n\n${RADAR_CREDIT}\n`,
    ),
  );

  return parts.join("\n");
}

export async function runRadar(
  argv: string[],
  tools: RadarTools = serverTools,
): Promise<number> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.set(name, "true");
    } else {
      flags.set(name, value);
      index += 1;
    }
  }

  const niche = flags.get("niche") ?? flags.get("seed");
  if (!niche) {
    process.stderr.write(
      'usage: seo-mcp radar --niche "<topic>" [--out file] [--limit 10]\n',
    );
    return 2;
  }
  const limit = Number.parseInt(flags.get("limit") ?? "8", 10);
  const out = flags.get("out");
  const markdown = await buildRadar(
    {
      niche,
      seed: flags.get("seed"),
      limit: Number.isFinite(limit) && limit > 0 ? limit : 8,
    },
    tools,
  );
  if (out && out !== "true") {
    writeFileSync(out, markdown);
    process.stdout.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(markdown);
  }
  return 0;
}
