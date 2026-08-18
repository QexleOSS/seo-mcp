import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isArray, isRecord, stringValue, type JsonObject } from "./json.ts";

export const SIGNATURE_CACHE_FILE = "signature_cache.json";

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
    const response = await fetch(
      "https://ahrefs.com/v4/stGetFreeBacklinksOverview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          captcha: token,
          mode: "subdomains",
          url: domain,
        }),
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
  return topBacklinks.backlinks.filter(isRecord).map((backlink) => ({
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
    const response = await fetch(
      "https://ahrefs.com/v4/stGetFreeBacklinksList",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportType: "TopBacklinks",
          signedInput: {
            signature,
            input: { validUntil, mode: "subdomains", url: `${domain}/` },
          },
        }),
      },
    );
    if (response.status !== 200) return null;
    return formatBacklinks(await response.json());
  } catch {
    return null;
  }
}
