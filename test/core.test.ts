import { describe, expect, test as bunTest } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatBacklinks,
  getBacklinks,
  getSignatureAndOverview,
  isoToTimestamp,
  loadSignatureFromCache,
  saveSignatureToCache,
} from "../src/backlinks.ts";
import {
  isArray,
  isRecord,
  numberValue,
  stringValue,
  boolValue,
} from "../src/json.ts";
import {
  formatKeywordIdeas,
  getKeywordDifficulty,
  getKeywordIdeas,
} from "../src/keywords.ts";
import { checkTraffic } from "../src/traffic.ts";

process.env.CAPSOLVER_API_KEY = "test-key";
const {
  getBacklinksList,
  getCapsolverToken,
  getTraffic,
  keywordDifficulty,
  keywordGenerator,
  main,
  mcp,
  toolResult,
} = await import("../src/server.ts");

const test = bunTest.serial;

const originalFetch = globalThis.fetch;
const originalCwd = process.cwd();
const testDirectory = join(originalCwd, ".coverage-test-cache");

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function mockFetch(...responses: Response[]): Request[] {
  const requests: Request[] = [];
  const fetchMock = async (
    input: string | Request | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push(new Request(String(input), init));
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  };
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  return requests;
}

function mockFetchFailure(): void {
  const fetchMock = async (): Promise<Response> => {
    throw new Error("network");
  };
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
}

function useCacheDirectory(): void {
  rmSync(testDirectory, { recursive: true, force: true });
  mkdirSync(testDirectory, { recursive: true });
  process.chdir(testDirectory);
}

function restoreEnvironment(): void {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  rmSync(testDirectory, { recursive: true, force: true });
}

describe("JSON helpers", () => {
  test("recognize JSON values and apply typed fallbacks", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isArray([])).toBe(true);
    expect(isArray({})).toBe(false);
    expect(stringValue("value")).toBe("value");
    expect(stringValue(1, "fallback")).toBe("fallback");
    expect(numberValue(1)).toBe(1);
    expect(numberValue("1", 2)).toBe(2);
    expect(boolValue(true)).toBe(true);
    expect(boolValue("true", true)).toBe(true);
  });
});

describe("backlink cache", () => {
  test("converts ISO timestamps with and without UTC suffix", () => {
    expect(isoToTimestamp("2025-04-12T14:59:18Z")).toBe(1744469958);
    expect(isoToTimestamp("2025-04-12T14:59:18+00:00")).toBe(1744469958);
  });

  test("saves and loads a valid signature cache entry", () => {
    useCacheDirectory();
    expect(
      saveSignatureToCache(
        "sig",
        "2999-01-01T00:00:00Z",
        { links: 1 },
        "example.com",
      ),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync("signature_cache.json", "utf8"))["example.com"]
        .signature,
    ).toBe("sig");
    expect(loadSignatureFromCache("example.com")).toEqual([
      "sig",
      "2999-01-01T00:00:00Z",
      { links: 1 },
    ]);
    restoreEnvironment();
  });

  test("handles missing, malformed, expired, and incomplete cache entries", () => {
    useCacheDirectory();
    expect(loadSignatureFromCache("missing.com")).toEqual([null, null, null]);
    writeFileSync("signature_cache.json", "not json");
    expect(loadSignatureFromCache("example.com")).toEqual([null, null, null]);
    writeFileSync("signature_cache.json", JSON.stringify([]));
    expect(loadSignatureFromCache("example.com")).toEqual([null, null, null]);
    writeFileSync("signature_cache.json", JSON.stringify({ example: "wrong" }));
    expect(loadSignatureFromCache("example")).toEqual([null, null, null]);
    writeFileSync(
      "signature_cache.json",
      JSON.stringify({ example: { valid_until: "2000-01-01T00:00:00Z" } }),
    );
    expect(loadSignatureFromCache("example")).toEqual([null, null, null]);
    writeFileSync(
      "signature_cache.json",
      JSON.stringify({
        example: { valid_until: "2999-01-01T00:00:00Z", signature: 1 },
      }),
    );
    expect(loadSignatureFromCache("example")).toEqual([
      null,
      "2999-01-01T00:00:00Z",
      null,
    ]);
    restoreEnvironment();
  });

  test("returns false when the cache path cannot be written", () => {
    useCacheDirectory();
    mkdirSync("signature_cache.json");
    expect(
      saveSignatureToCache("sig", "2999-01-01T00:00:00Z", {}, "example.com"),
    ).toBe(false);
    restoreEnvironment();
  });
});

describe("backlink API", () => {
  test("gets and caches a valid signature overview", async () => {
    useCacheDirectory();
    const requests = mockFetch(
      response([
        "Ok",
        {
          signedInput: {
            signature: "sig",
            input: { validUntil: "2999-01-01T00:00:00Z" },
          },
          data: { total: 2 },
        },
      ]),
    );
    expect(await getSignatureAndOverview("token", "example.com")).toEqual([
      "sig",
      "2999-01-01T00:00:00Z",
      { total: 2 },
    ]);
    expect(requests[0].method).toBe("POST");
    expect(JSON.parse(await requests[0].text())).toEqual({
      captcha: "token",
      mode: "subdomains",
      url: "example.com",
    });
    restoreEnvironment();
  });

  test("rejects invalid signature responses and network failures", async () => {
    for (const value of [
      response({}, 500),
      response(["Ok"]),
      response(["Ok", { signedInput: {}, data: {} }]),
      response(["Ok", { signedInput: { input: {} }, data: {} }]),
    ]) {
      mockFetch(value);
      expect(await getSignatureAndOverview("token", "example.com")).toEqual([
        null,
        null,
        null,
      ]);
      restoreEnvironment();
      useCacheDirectory();
    }
    mockFetchFailure();
    expect(await getSignatureAndOverview("token", "example.com")).toEqual([
      null,
      null,
      null,
    ]);
    restoreEnvironment();
  });

  test("formats backlink records and filters invalid entries", () => {
    expect(formatBacklinks(null)).toEqual([]);
    expect(formatBacklinks(["Ok", {}])).toEqual([]);
    expect(formatBacklinks(["Ok", { topBacklinks: {} }])).toEqual([]);
    expect(
      formatBacklinks([
        "Ok",
        {
          topBacklinks: {
            backlinks: [
              null,
              {
                anchor: "anchor",
                domainRating: 5,
                title: "title",
                urlFrom: "from",
                urlTo: "to",
                edu: true,
                gov: false,
              },
              {},
            ],
          },
        },
      ]),
    ).toEqual([
      {
        anchor: "anchor",
        domainRating: 5,
        title: "title",
        urlFrom: "from",
        urlTo: "to",
        edu: true,
        gov: false,
      },
      {
        anchor: "",
        domainRating: 0,
        title: "",
        urlFrom: "",
        urlTo: "",
        edu: false,
        gov: false,
      },
    ]);
  });

  test("gets backlinks only with complete credentials", async () => {
    expect(await getBacklinks("", "valid", "example.com")).toBeNull();
    expect(await getBacklinks("sig", "", "example.com")).toBeNull();
    mockFetch(response({}, 500));
    expect(await getBacklinks("sig", "valid", "example.com")).toBeNull();
    mockFetch(response(["Ok", { topBacklinks: { backlinks: [] } }]));
    expect(await getBacklinks("sig", "valid", "example.com")).toEqual([]);
    mockFetchFailure();
    expect(await getBacklinks("sig", "valid", "example.com")).toBeNull();
    restoreEnvironment();
  });
});

describe("keyword API", () => {
  test("formats keyword and question ideas with defaults", () => {
    expect(formatKeywordIdeas(null)).toEqual([
      "\n❌ No valid keyword ideas retrieved",
    ]);
    expect(formatKeywordIdeas(["Ok", {}])).toEqual([
      "\n❌ No valid keyword ideas retrieved",
    ]);
    expect(
      formatKeywordIdeas([
        "Ok",
        {
          allIdeas: {},
          questionIdeas: { results: [null, { keyword: "question" }] },
        },
      ]),
    ).toEqual([
      {
        label: "question ideas",
        value: {
          keyword: "question",
          country: "-",
          difficulty: "Unknown",
          volume: "Unknown",
          updatedAt: "-",
        },
      },
    ]);
    expect(formatKeywordIdeas(["Ok", { allIdeas: { results: [{}] } }])).toEqual(
      [
        {
          label: "keyword ideas",
          value: {
            keyword: "No keyword",
            country: "-",
            difficulty: "Unknown",
            volume: "Unknown",
            updatedAt: "-",
          },
        },
      ],
    );
  });

  test("gets keyword ideas with defaults and handles failures", async () => {
    expect(await getKeywordIdeas("", "seo")).toBeNull();
    const requests = mockFetch(response(["Ok", { allIdeas: { results: [] } }]));
    expect(await getKeywordIdeas("token", "seo")).toEqual([
      "\n❌ No valid keyword ideas retrieved",
    ]);
    expect(JSON.parse(await requests[0].text())).toEqual({
      withQuestionIdeas: true,
      captcha: "token",
      searchEngine: "Google",
      country: "us",
      keyword: ["Some", "seo"],
    });
    mockFetch(response({}, 500));
    expect(await getKeywordIdeas("token", "seo")).toBeNull();
    mockFetchFailure();
    expect(await getKeywordIdeas("token", "seo")).toBeNull();
    restoreEnvironment();
  });

  test("formats difficulty data and all SERP validation branches", async () => {
    expect(await getKeywordDifficulty("", "seo")).toBeNull();
    mockFetch(response(["No", {}]));
    expect(await getKeywordDifficulty("token", "seo")).toBeNull();
    mockFetch(
      response([
        "Ok",
        { difficulty: 4, shortage: "bad", lastUpdate: 1, serp: {} },
      ]),
    );
    expect(await getKeywordDifficulty("token", "seo")).toEqual({
      difficulty: 4,
      shortage: 0,
      lastUpdate: "",
      serp: { results: [] },
    });
    mockFetch(
      response([
        "Ok",
        {
          serp: {
            results: [
              null,
              { content: [] },
              { content: ["organic", {}] },
              { content: ["organic", { link: [] }] },
              { content: ["organic", { link: ["Some", {}] }] },
              {
                content: [
                  "organic",
                  {
                    link: [
                      "Some",
                      {
                        title: "title",
                        url: ["Some", { url: "https://example.com" }],
                        metrics: {},
                      },
                    ],
                  },
                ],
                pos: 2,
              },
            ],
          },
        },
      ]),
    );
    expect(await getKeywordDifficulty("token", "seo")).toEqual({
      difficulty: 0,
      shortage: 0,
      lastUpdate: "",
      serp: {
        results: [
          { title: "", url: "", position: 0 },
          {
            title: "title",
            url: "https://example.com",
            position: 2,
            domainRating: 0,
            urlRating: 0,
            traffic: 0,
            keywords: 0,
            topKeyword: "",
            topVolume: 0,
          },
        ],
      },
    });
    mockFetch(
      response([
        "Ok",
        {
          serp: {
            results: [
              {
                content: [
                  "organic",
                  {
                    link: [
                      "Some",
                      {
                        title: "full",
                        url: [],
                        metrics: {
                          domainRating: 3,
                          urlRating: 4,
                          traffic: 5,
                          keywords: 6,
                          topKeyword: "best",
                          topVolume: 7,
                        },
                      },
                    ],
                  },
                ],
                pos: 1,
              },
            ],
          },
        },
      ]),
    );
    expect(await getKeywordDifficulty("token", "seo")).toEqual({
      difficulty: 0,
      shortage: 0,
      lastUpdate: "",
      serp: {
        results: [
          {
            title: "full",
            url: "",
            position: 1,
            domainRating: 3,
            urlRating: 4,
            traffic: 5,
            keywords: 6,
            topKeyword: "best",
            topVolume: 7,
          },
        ],
      },
    });
    mockFetch(response({}, 500));
    expect(await getKeywordDifficulty("token", "seo")).toBeNull();
    mockFetchFailure();
    expect(await getKeywordDifficulty("token", "seo")).toBeNull();
    restoreEnvironment();
  });
});

describe("traffic API", () => {
  test("handles missing token, bad responses, and valid traffic", async () => {
    expect(await checkTraffic("", "example.com")).toBeNull();
    mockFetch(response({}, 500));
    expect(await checkTraffic("token", "example.com")).toBeNull();
    for (const value of [null, ["Ok"], ["No", {}]]) {
      mockFetch(response(value));
      expect(
        await checkTraffic("token", "example.com", "exact", "us"),
      ).toBeNull();
    }
    mockFetch(response(["Ok", { traffic: null }]));
    expect(await checkTraffic("token", "example.com", "exact", "us")).toEqual({
      traffic_history: [],
      traffic: { trafficMonthlyAvg: 0, costMontlyAvg: 0 },
      top_pages: [],
      top_countries: [],
      top_keywords: [],
    });
    const requests = mockFetch(
      response([
        "Ok",
        {
          traffic: { trafficMonthlyAvg: 10, costMontlyAvg: 20 },
          traffic_history: [],
          top_pages: [],
          top_countries: [],
          top_keywords: [],
        },
      ]),
    );
    expect(await checkTraffic("token", "example.com")).toEqual({
      traffic_history: [],
      traffic: { trafficMonthlyAvg: 10, costMontlyAvg: 20 },
      top_pages: [],
      top_countries: [],
      top_keywords: [],
    });
    expect(requests[0].url).toContain("stGetFreeTrafficOverview");
    mockFetchFailure();
    expect(await checkTraffic("token", "example.com")).toBeNull();
    restoreEnvironment();
  });
});

describe("MCP server wrappers", () => {
  test("returns null without a CapSolver key", async () => {
    delete process.env.CAPSOLVER_API_KEY;
    expect(await getCapsolverToken("https://example.com")).toBeNull();
    await expect(getBacklinksList("example.com")).rejects.toThrow(
      "Failed to get verification token",
    );
    await expect(keywordGenerator("seo")).rejects.toThrow(
      "Failed to get verification token",
    );
    await expect(getTraffic("example.com")).rejects.toThrow(
      "Failed to get verification token",
    );
    await expect(keywordDifficulty("seo")).rejects.toThrow(
      "Failed to get verification token",
    );
    process.env.CAPSOLVER_API_KEY = "test-key";
  });

  test("handles CapSolver task validation and ready responses", async () => {
    mockFetch(response({}));
    expect(await getCapsolverToken("https://example.com")).toBeNull();
    mockFetch(response({ taskId: "" }));
    expect(await getCapsolverToken("https://example.com")).toBeNull();
    mockFetch(
      response({ taskId: "task" }),
      response({ status: "ready", solution: { token: "token" } }),
    );
    expect(await getCapsolverToken("https://example.com")).toBe("token");
    restoreEnvironment();
    process.env.CAPSOLVER_API_KEY = "test-key";
  });

  test("handles CapSolver polling failures and malformed solutions", async () => {
    mockFetch(response({ taskId: "task" }), response(null));
    expect(await getCapsolverToken("https://example.com")).toBeNull();
    mockFetch(response({ taskId: "task" }), response({ status: "failed" }));
    expect(await getCapsolverToken("https://example.com")).toBeNull();
    mockFetch(response({ taskId: "task" }), response({ errorId: 1 }));
    expect(await getCapsolverToken("https://example.com")).toBeNull();
    restoreEnvironment();
    process.env.CAPSOLVER_API_KEY = "test-key";
  });

  test("rejects malformed ready solutions and fetch failures", async () => {
    mockFetch(
      response({ taskId: "task" }),
      response({ status: "ready", solution: null }),
    );
    expect(await getCapsolverToken("https://example.com")).toBeNull();
    mockFetch(
      response({ taskId: "task" }),
      response({ status: "ready", solution: { token: 1 } }),
    );
    expect(await getCapsolverToken("https://example.com")).toBeNull();
    mockFetchFailure();
    expect(await getCapsolverToken("https://example.com")).toBeNull();
    restoreEnvironment();
    process.env.CAPSOLVER_API_KEY = "test-key";
  });

  test("serves cached backlinks and calls the API wrappers", async () => {
    useCacheDirectory();
    saveSignatureToCache(
      "sig",
      "2999-01-01T00:00:00Z",
      { total: 1 },
      "example.com",
    );
    mockFetch(response(["Ok", { topBacklinks: { backlinks: [] } }]));
    expect(await getBacklinksList("example.com")).toEqual({
      overview: { total: 1 },
      backlinks: [],
    });

    mockFetch(
      response({ taskId: "task" }),
      response({ status: "ready", solution: { token: "token" } }),
      response(["No", {}]),
    );
    await expect(getBacklinksList("missing.com")).rejects.toThrow(
      "Failed to get signature",
    );

    mockFetch(
      response({ taskId: "task" }),
      response({ status: "ready", solution: { token: "token" } }),
      response(["Ok", { allIdeas: { results: [] } }]),
    );
    expect(await keywordGenerator("seo", "ca", "Bing")).toEqual([
      "\n❌ No valid keyword ideas retrieved",
    ]);

    mockFetch(
      response({ taskId: "task" }),
      response({ status: "ready", solution: { token: "token" } }),
      response(["Ok", { traffic: {} }]),
    );
    expect(await getTraffic("example.com", "ca", "exact")).toEqual({
      traffic_history: [],
      traffic: { trafficMonthlyAvg: 0, costMontlyAvg: 0 },
      top_pages: [],
      top_countries: [],
      top_keywords: [],
    });

    mockFetch(
      response({ taskId: "task" }),
      response({ status: "ready", solution: { token: "token" } }),
      response(["Ok", { difficulty: 10 }]),
    );
    expect(await keywordDifficulty("seo", "ca")).toEqual({
      difficulty: 10,
      shortage: 0,
      lastUpdate: "",
      serp: { results: [] },
    });
    restoreEnvironment();
  });

  test("passes the registered MCP instance to stdio and serializes tool results", async () => {
    expect(toolResult({ answer: 42 })).toEqual({
      content: [{ type: "text", text: '{"answer":42}' }],
    });
    let received = false;
    await main((factory) => {
      received = factory(undefined as never) === mcp;
      return { close: async () => {} };
    });
    expect(received).toBe(true);
  });
});
