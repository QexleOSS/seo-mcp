import { describe, expect, test as bunTest } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_CACHE_ENTRIES,
  SIGNATURE_CACHE_FILE,
  loadSignatureFromCache,
  normalizeDomain,
  saveSignatureToCache,
} from "../src/backlinks.ts";
import { extractAnchorsTo } from "../src/linkcheck.ts";
import { fetchText, withTimeout } from "../src/net.ts";

const test = bunTest.serial;

const originalFetch = globalThis.fetch;
const originalCwd = process.cwd();
const workDirectory = join(originalCwd, ".edge-test-cache");

function useWorkDirectory(): void {
  rmSync(workDirectory, { recursive: true, force: true });
  mkdirSync(workDirectory, { recursive: true });
  process.chdir(workDirectory);
}

function restoreDirectory(): void {
  process.chdir(originalCwd);
  rmSync(workDirectory, { recursive: true, force: true });
}

function readCache(): Record<string, unknown> {
  return JSON.parse(readFileSync(SIGNATURE_CACHE_FILE, "utf8")) as Record<
    string,
    unknown
  >;
}

function mockSequence(bodies: { status?: number; body: string }[]): void {
  const queue = [...bodies];
  const fetchMock = async (
    input: string | Request | URL,
  ): Promise<Response> => {
    void input;
    const next = queue.shift();
    if (!next) return new Response("exhausted", { status: 500 });
    return new Response(next.body, { status: next.status ?? 200 });
  };
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

describe("domain validation", () => {
  test("rejects anything that is not a hostname", () => {
    expect(() => normalizeDomain("not a domain")).toThrow("Invalid domain");
    expect(() => normalizeDomain("http://example.com")).toThrow(
      "Invalid domain",
    );
    expect(() => normalizeDomain(42)).toThrow("Invalid domain");
    expect(normalizeDomain("  Example.COM ")).toBe("example.com");
  });
});

describe("signature cache", () => {
  test("prunes expired entries when it saves", () => {
    useWorkDirectory();
    writeFileSync(
      SIGNATURE_CACHE_FILE,
      JSON.stringify({
        "expired.example.com": {
          signature: "old",
          valid_until: "2000-01-01T00:00:00Z",
          timestamp: 1,
        },
        "alive.example.com": {
          signature: "keep",
          valid_until: "2999-01-01T00:00:00Z",
          timestamp: 2,
        },
      }),
    );
    saveSignatureToCache(
      "fresh",
      "2999-01-01T00:00:00Z",
      { total: 1 },
      "new.example.com",
    );
    const cache = readCache();
    expect(cache["expired.example.com"]).toBeUndefined();
    expect(cache["alive.example.com"]).toBeDefined();
    expect(cache["new.example.com"]).toBeDefined();
    restoreDirectory();
  });

  test("evicts the oldest entries past the cap", () => {
    useWorkDirectory();
    const seeded: Record<string, unknown> = {};
    for (let index = 0; index < MAX_CACHE_ENTRIES + 1; index += 1) {
      seeded[`seed-${index}.example.com`] = {
        signature: "s",
        valid_until: "2999-01-01T00:00:00Z",
        timestamp: index + 1,
      };
    }
    writeFileSync(SIGNATURE_CACHE_FILE, JSON.stringify(seeded));
    saveSignatureToCache(
      "fresh",
      "2999-01-01T00:00:00Z",
      { total: 1 },
      "new.example.com",
    );
    const cache = readCache();
    const keys = Object.keys(cache);
    expect(keys.length).toBe(MAX_CACHE_ENTRIES);
    expect(cache["seed-0.example.com"]).toBeUndefined();
    expect(cache["seed-1.example.com"]).toBeUndefined();
    expect(cache["new.example.com"]).toBeDefined();
    restoreDirectory();
  });

  test("reads back a saved signature and rejects an unknown domain", () => {
    useWorkDirectory();
    saveSignatureToCache(
      "sig",
      "2999-01-01T00:00:00Z",
      { total: 3 },
      "example.com",
    );
    const [signature, validUntil, overview] =
      loadSignatureFromCache("example.com");
    expect(signature).toBe("sig");
    expect(validUntil).toBe("2999-01-01T00:00:00Z");
    expect(overview).toEqual({ total: 3 });
    expect(loadSignatureFromCache("other.example.com")).toEqual([
      null,
      null,
      null,
    ]);
    restoreDirectory();
  });
});

describe("link extraction", () => {
  test("skips hrefs that are not valid urls", () => {
    const html =
      '<a href="http://[bad">broken</a><a href="https://example.com/x">good</a>';
    const anchors = extractAnchorsTo(
      html,
      "https://page.test/post",
      "example.com",
    );
    expect(anchors).toEqual(["good"]);
  });
});

describe("network timeouts", () => {
  test("caps a deadline without raising it", () => {
    const capped = withTimeout({}, 2000);
    expect(capped.timeoutMs).toBe(2000);
    const tighter = withTimeout({ timeoutMs: 500 }, 2000);
    expect(tighter.timeoutMs).toBe(500);
    const fetchMock = async (): Promise<Response> => new Response("ok");
    const kept = withTimeout({ fetch: fetchMock, userAgent: "ua" }, 2000);
    expect(kept.fetch).toBe(fetchMock);
    expect(kept.userAgent).toBe("ua");
    expect(kept.timeoutMs).toBe(2000);
  });

  test("aborts a request that runs past its timeout", async () => {
    const result = await fetchText("https://example.com", {
      timeoutMs: 10,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted");
    expect(result.status).toBe(0);
  });
});

describe("capsolver polling", () => {
  test("gives up when the task never leaves processing", async () => {
    process.env.CAPSOLVER_API_KEY = "test-key";
    mockSequence([
      { body: JSON.stringify({ taskId: "task" }) },
      { body: JSON.stringify({ status: "processing" }) },
      { body: JSON.stringify({ status: "processing" }) },
    ]);
    const { getCapsolverToken } = await import("../src/server.ts");
    const token = await getCapsolverToken("https://ahrefs.com", {
      maxPolls: 2,
      pollIntervalMs: 0,
    });
    expect(token).toBeNull();
    restoreFetch();
    delete process.env.CAPSOLVER_API_KEY;
  });

  test("serves the ahrefs keyword tools when a key is present", async () => {
    process.env.CAPSOLVER_API_KEY = "test-key";
    useWorkDirectory();
    mockSequence([
      { body: JSON.stringify({ taskId: "task" }) },
      {
        body: JSON.stringify({ status: "ready", solution: { token: "token" } }),
      },
      {
        body: JSON.stringify([
          "Ok",
          {
            allIdeas: {
              results: [
                {
                  keyword: "seo tools",
                  country: "us",
                  difficultyLabel: "12",
                  volumeLabel: "100",
                  updatedAt: "2026-10-01",
                },
              ],
            },
          },
        ]),
      },
      { body: JSON.stringify({ taskId: "task" }) },
      {
        body: JSON.stringify({ status: "ready", solution: { token: "token" } }),
      },
      {
        body: JSON.stringify([
          "Ok",
          {
            difficulty: 33,
            shortage: 0,
            lastUpdate: "2026-10-01",
            serp: { results: [] },
          },
        ]),
      },
    ]);
    const server = await import("../src/server.ts");
    const ideas = JSON.parse(
      (await server.keywordGeneratorTool({ keyword: "seo tools" })).content[0]!
        .text,
    );
    expect(ideas.tier).toBe("ahrefs");
    expect(ideas.source).toBe("ahrefs");
    expect(ideas.keyword_ideas[0].value.keyword).toBe("seo tools");

    const difficulty = JSON.parse(
      (await server.keywordDifficultyTool({ keyword: "seo tools" })).content[0]!
        .text,
    );
    expect(difficulty.tier).toBe("ahrefs");
    expect(difficulty.source).toBe("ahrefs");
    expect(difficulty.difficulty).toBe(33);
    restoreFetch();
    restoreDirectory();
    delete process.env.CAPSOLVER_API_KEY;
  });
});
