import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isArray, isRecord, stringValue, type JsonObject } from "./json.ts";

export const SIGNATURE_CACHE_FILE = "signature_cache.json";
const MAX_DOMAIN_LENGTH = 253;
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// The domain string is model-controlled MCP input that becomes a persistent
// cache key and selects a paid CapSolver task, so it must be a plausible
// hostname before it fans out to disk or the network.
export function normalizeDomain(domain: unknown): string {
  if (typeof domain !== "string") throw new Error("Invalid domain");
  const normalized = domain.trim().toLowerCase();
  if (normalized.length > MAX_DOMAIN_LENGTH || !DOMAIN_RE.test(normalized)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  return normalized;
}

// The cache key is model-controlled input, so the persisted map must stay
// bounded: expired entries are pruned on every save and the oldest entries
// are evicted past the cap instead of growing signature_cache.json forever.
export const MAX_CACHE_ENTRIES = 500;
export const MAX_BACKLINKS = 100;

const AHREFS_FETCH_TIMEOUT_MS = 30_000;

function ahrefsFetch(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AHREFS_FETCH_TIMEOUT_MS),
  });
}

function pruneCacheEntries(cacheData: Record<string, CacheEntry>): void {
  const now = Date.now() / 1000;
  for (const [domain, entry] of Object.entries(cacheData)) {
    const validUntil = entry?.valid_until;
    if (
      typeof validUntil !== "string" ||
      !validUntil ||
      now >= isoToTimestamp(validUntil)
    ) {
      delete cacheData[domain];
    }
  }
  const keys = Object.keys(cacheData);
  if (keys.length > MAX_CACHE_ENTRIES) {
    const byAge = keys
      .map((key) => [key, cacheData[key]?.timestamp ?? 0] as const)
      .sort((left, right) => left[1] - right[1]);
    for (const [key] of byAge.slice(0, keys.length - MAX_CACHE_ENTRIES)) {
      delete cacheData[key];
    }
  }
}

type Overview = JsonObject;
type CacheEntry = {
  signature?: string;
  valid_until?: string;
  overview_data?: Overview;
  timestamp?: number;
};

export function isoToTimestamp(value: string): number {
  const normalized = value.endsWith("Z")
    ? `${value.slice(0, -1)}+00:00`
    : value;
  return new Date(normalized).getTime() / 1000;
}

export function saveSignatureToCache(
  signature: string,
  validUntil: string,
  overviewData: Overview,
  domain: string,
): boolean {
  let cacheData: Record<string, CacheEntry> = {};
  if (existsSync(SIGNATURE_CACHE_FILE)) {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(SIGNATURE_CACHE_FILE, "utf8"),
      );
      if (isRecord(parsed)) cacheData = parsed as Record<string, CacheEntry>;
    } catch {
      cacheData = {};
    }
  }

  cacheData[domain] = {
    signature,
    valid_until: validUntil,
    overview_data: overviewData,
    timestamp: Date.now() / 1000,
  };
  pruneCacheEntries(cacheData);

  try {
    writeFileSync(SIGNATURE_CACHE_FILE, JSON.stringify(cacheData));
    return true;
  } catch {
    return false;
  }
}

export function loadSignatureFromCache(
  domain: string,
): [string | null, string | null, Overview | null] {
  if (!existsSync(SIGNATURE_CACHE_FILE)) return [null, null, null];

  try {
    const parsed: unknown = JSON.parse(
      readFileSync(SIGNATURE_CACHE_FILE, "utf8"),
    );
    if (!isRecord(parsed)) return [null, null, null];
    const entry = parsed[domain];
    if (!isRecord(entry)) return [null, null, null];
    const validUntil = stringValue(entry.valid_until);
    if (!validUntil || Date.now() / 1000 >= isoToTimestamp(validUntil))
      return [null, null, null];
    const signature = stringValue(entry.signature);
    const overview = isRecord(entry.overview_data) ? entry.overview_data : null;
    return [signature || null, validUntil, overview];
  } catch {
    return [null, null, null];
  }
}

export async function getSignatureAndOverview(
  token: string,
  domain: string,
): Promise<[string | null, string | null, Overview | null]> {
  try {
    const response = await ahrefsFetch(
      "https://ahrefs.com/v4/stGetFreeBacklinksOverview",
      {
        captcha: token,
        mode: "subdomains",
        url: domain,
      },
    );
    if (response.status !== 200) return [null, null, null];
    const data: unknown = await response.json();
    if (!isArray(data) || data.length < 2 || !isRecord(data[1]))
      return [null, null, null];
    const signedInput = data[1].signedInput;
    const overviewData = data[1].data;
    if (
      !isRecord(signedInput) ||
      !isRecord(signedInput.input) ||
      !isRecord(overviewData)
    ) {
      return [null, null, null];
    }
    const signature = stringValue(signedInput.signature);
    const validUntil = stringValue(signedInput.input.validUntil);
    if (!signature || !validUntil) return [null, null, null];
    saveSignatureToCache(signature, validUntil, overviewData, domain);
    return [signature, validUntil, overviewData];
  } catch {
    return [null, null, null];
  }
}

export function formatBacklinks(backlinksData: unknown): JsonObject[] {
  if (
    !isArray(backlinksData) ||
    backlinksData.length < 2 ||
    !isRecord(backlinksData[1])
  )
    return [];
  const topBacklinks = backlinksData[1].topBacklinks;
  if (!isRecord(topBacklinks) || !isArray(topBacklinks.backlinks)) return [];
  return topBacklinks.backlinks
    .filter(isRecord)
    .slice(0, MAX_BACKLINKS)
    .map((backlink) => ({
      anchor: stringValue(backlink.anchor),
      domainRating:
        typeof backlink.domainRating === "number" ? backlink.domainRating : 0,
      title: stringValue(backlink.title),
      urlFrom: stringValue(backlink.urlFrom),
      urlTo: stringValue(backlink.urlTo),
      edu: typeof backlink.edu === "boolean" ? backlink.edu : false,
      gov: typeof backlink.gov === "boolean" ? backlink.gov : false,
    }));
}

export async function getBacklinks(
  signature: string,
  validUntil: string,
  domain: string,
): Promise<JsonObject[] | null> {
  if (!signature || !validUntil) return null;
  try {
    const response = await ahrefsFetch(
      "https://ahrefs.com/v4/stGetFreeBacklinksList",
      {
        reportType: "TopBacklinks",
        signedInput: {
          signature,
          input: { validUntil, mode: "subdomains", url: `${domain}/` },
        },
      },
    );
    if (response.status !== 200) return null;
    return formatBacklinks(await response.json());
  } catch {
    return null;
  }
}
