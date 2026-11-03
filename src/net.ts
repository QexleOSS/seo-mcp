/**
 * HTTP access for the keyless providers.
 *
 * Every provider takes an optional `NetContext` so tests can inject a fetch
 * implementation. Nothing here captures `globalThis.fetch` at module load, so
 * a test that swaps the global fetch keeps working.
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface NetContext {
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
}

export interface HttpText {
  ok: boolean;
  status: number;
  text: string;
  error: string | null;
  ms: number;
  finalUrl: string;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export const DEFAULT_TIMEOUT_MS = 16000;

/**
 * Caps a request deadline without raising it. A public endpoint that hangs
 * must not hold a whole tool call hostage: the call returns the sources that
 * did answer and says which ones did not.
 */
export function withTimeout(ctx: NetContext, timeoutMs: number): NetContext {
  const current = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return { ...ctx, timeoutMs: Math.min(current, timeoutMs) };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Fetches a URL as text. Network errors come back as data, not exceptions. */
export async function fetchText(
  url: string,
  ctx: NetContext = {},
): Promise<HttpText> {
  const doFetch: FetchLike = ctx.fetch ?? globalThis.fetch;
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await doFetch(url, {
      headers: {
        "User-Agent": ctx.userAgent ?? DEFAULT_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      error: response.ok ? null : `HTTP ${response.status}`,
      ms: Date.now() - started,
      finalUrl: response.url || url,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      error: errorMessage(error),
      ms: Date.now() - started,
      finalUrl: url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches a URL and parses it as JSON. Returns null on any failure. */
export async function fetchJson(
  url: string,
  ctx: NetContext = {},
): Promise<unknown | null> {
  const response = await fetchText(url, ctx);
  if (!response.ok) return null;
  return parseJson(response.text);
}

export function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
