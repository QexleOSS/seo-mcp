import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRadar,
  RADAR_CREDIT,
  runRadar,
  type RadarTools,
} from "../src/radar.ts";

/** Wraps a payload the way the MCP server does, so the radar reads it the same. */
function toolResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

const TRENDS = {
  source: "trends",
  geo: "US",
  note: "No daily search trend matched the niche, so the unfiltered daily feed is shown.",
  trends: [
    { title: "seo audit checklist", source: "google_trends", traffic: "1000+" },
  ],
};

const RESEARCH = {
  source: "autocomplete",
  note: "Autocomplete shows what people type, not search volume.",
  engines_silent: ["brave"],
  candidates: [
    {
      keyword: "seo audit",
      intent: "informational",
      autocomplete_rank: 1,
      engines: ["google", "bing"],
    },
  ],
};

const SERP = {
  source: "serp",
  endpoint: "rightdao",
  endpoints_silent: ["duckduckgo"],
  note: "Pages that did not name the query were dropped.",
  results: [
    { position: 1, domain: "semrush.com", title: "Technical SEO Audit" },
    { position: 2, domain: "moz.com", title: "Site Audit Checklist" },
  ],
  difficulty_estimate: {
    score: 20,
    method: "serp_composition",
    confidence: "low",
    note: "Estimate from the live result page.",
  },
};

function fakeTools(overrides: Partial<RadarTools> = {}): RadarTools {
  return {
    trending: async () => toolResult(TRENDS),
    keywordResearch: async () => toolResult(RESEARCH),
    serpSnapshot: async () => toolResult(SERP),
    ...overrides,
  };
}

describe("radar", () => {
  test("writes one section per tool and names every source", async () => {
    const markdown = await buildRadar(
      { niche: "technical seo audit", limit: 5 },
      fakeTools(),
    );
    expect(markdown).toContain("# SEO radar: technical seo audit");
    expect(markdown).toContain("## What people search for now");
    expect(markdown).toContain("## Candidate keywords");
    expect(markdown).toContain('## Result page for "seo audit"');
    expect(markdown).toContain("## Sources");
    expect(markdown).toContain(
      "| seo audit checklist | google_trends | 1000+ |",
    );
    expect(markdown).toContain(
      "| seo audit | informational | 1 | google, bing |",
    );
    expect(markdown).toContain("| 1 | semrush.com | Technical SEO Audit |");
    expect(markdown).toContain("- trends");
    expect(markdown).toContain("- autocomplete");
    expect(markdown).toContain("- serp");
    expect(markdown).toContain(RADAR_CREDIT);
  });

  test("carries the note of each tool into the file", async () => {
    const markdown = await buildRadar(
      { niche: "technical seo audit", limit: 5 },
      fakeTools(),
    );
    expect(markdown).toContain("Autocomplete shows what people type");
    expect(markdown).toContain(
      "No daily search trend matched the niche, so the unfiltered daily feed is shown.",
    );
    expect(markdown).toContain("Engines that stayed silent: brave");
    expect(markdown).toContain(
      "Result page endpoints that stayed silent: duckduckgo",
    );
    expect(markdown).toContain("Result page source: rightdao.");
  });

  test("says so when no endpoint returned a result page", async () => {
    const markdown = await buildRadar(
      { niche: "technical seo audit", limit: 5 },
      fakeTools({
        serpSnapshot: async () =>
          toolResult({
            source: "serp",
            endpoint: "none",
            endpoints_silent: ["duckduckgo", "rightdao", "bing"],
            note: "No public endpoint returned a page about this query, so there is no competition read.",
            results: [],
            difficulty_estimate: {
              score: 0,
              method: "serp_composition",
              confidence: "none",
              note: "No results were available, so no competition read was possible.",
            },
          }),
      }),
    );
    expect(markdown).toContain(
      "No public endpoint returned a page about this query, so there is no competition read.",
    );
    expect(markdown).toContain(
      "No competition read was possible for this keyword.",
    );
    expect(markdown).not.toContain("Difficulty estimate:");
  });

  test("uses the seed keyword for the result page when there are no candidates", async () => {
    let asked = "";
    const markdown = await buildRadar(
      { niche: "seo audit", seed: "site audit", limit: 5 },
      fakeTools({
        keywordResearch: async () =>
          toolResult({ source: "autocomplete", candidates: [] }),
        serpSnapshot: async (args) => {
          asked = args.keyword;
          return toolResult(SERP);
        },
      }),
    );
    expect(asked).toBe("site audit");
    expect(markdown).toContain('## Result page for "site audit"');
  });

  test("survives a tool that answers with plain text", async () => {
    const markdown = await buildRadar(
      { niche: "seo audit", limit: 5 },
      fakeTools({
        trending: async () => ({
          content: [{ type: "text", text: "no data" }],
        }),
      }),
    );
    expect(markdown).toContain("# SEO radar: seo audit");
    expect(markdown).toContain("Nothing came back for this section.");
  });

  test("survives a tool that answers with something that is not an object", async () => {
    const markdown = await buildRadar(
      { niche: "seo audit", limit: 5 },
      fakeTools({
        trending: async () => "no data at all",
      }),
    );
    expect(markdown).toContain("# SEO radar: seo audit");
    expect(markdown).toContain("Nothing came back for this section.");
  });

  test("runRadar writes the file and prints the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seo-radar-"));
    const out = join(dir, "radar.md");
    const code = await runRadar(
      ["--niche", "seo audit", "--out", out, "--limit", "3"],
      fakeTools(),
    );
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("# SEO radar: seo audit");
    rmSync(dir, { recursive: true, force: true });
  });

  test("runRadar prints the markdown when no file is given", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      written.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    };
    try {
      const code = await runRadar(["--niche", "seo audit"], fakeTools());
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(written.join("")).toContain("# SEO radar: seo audit");
  });

  test("runRadar treats a flag without a value as a switch", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      written.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    };
    try {
      expect(await runRadar(["--niche"], fakeTools())).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(written.join("")).toContain("# SEO radar: true");
  });

  test("runRadar refuses to run without a niche", async () => {
    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      errors.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    };
    try {
      expect(await runRadar([], fakeTools())).toBe(2);
    } finally {
      process.stderr.write = original;
    }
    expect(errors.join("")).toContain("usage: seo-mcp radar");
  });
});
