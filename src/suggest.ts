/**
 * Live search-demand signals.
 *
 * Autocomplete endpoints are the only keyless source that shows what people
 * are typing right now. The output never claims a search volume: an
 * autocomplete rank is a position in a suggestion list, nothing more.
 */

import { fetchJson, withTimeout, type NetContext } from "./net.ts";
import { parseSuggestionPayload } from "./xml.ts";

export type SuggestEngine = "google" | "bing" | "duckduckgo";

/**
 * Autocomplete endpoints are public and sometimes slow on a cold connection.
 * A cold DNS and TLS handshake can take ten seconds on a busy network, so the
 * deadline sits above that number. An engine that fails gets one more try,
 * because an empty answer costs more than a slow one.
 */
export const SUGGEST_TIMEOUT_MS = 15000;
export const SUGGEST_RETRY_TIMEOUT_MS = 10000;

export const SUGGEST_ENGINES: SuggestEngine[] = [
  "google",
  "bing",
  "duckduckgo",
];

export interface Suggestion {
  text: string;
  engine: SuggestEngine;
  rank: number;
}

export function suggestUrl(engine: SuggestEngine, seed: string): string {
  const query = encodeURIComponent(seed);
  if (engine === "google")
    return `https://suggestqueries.google.com/complete/search?client=firefox&q=${query}`;
  if (engine === "bing")
    return `https://api.bing.com/osjson.aspx?query=${query}`;
  return `https://duckduckgo.com/ac/?q=${query}&type=list`;
}

interface EngineAnswer {
  engine: SuggestEngine;
  suggestions: Suggestion[];
  failed: boolean;
}

/** Asks one autocomplete endpoint for suggestions on one seed. */
async function askEngine(
  engine: SuggestEngine,
  seed: string,
  ctx: NetContext,
): Promise<EngineAnswer> {
  const payload = await fetchJson(
    suggestUrl(engine, seed),
    withTimeout(ctx, SUGGEST_TIMEOUT_MS),
  );
  if (payload === null) return { engine, suggestions: [], failed: true };
  return {
    engine,
    suggestions: parseSuggestionPayload(payload).map(
      (text, index): Suggestion => ({ text, engine, rank: index + 1 }),
    ),
    failed: false,
  };
}

/**
 * Asks every autocomplete endpoint for suggestions on one seed. An endpoint
 * that errors or times out is asked a second time before the answer is
 * treated as empty.
 */
export async function collectSuggestions(
  seed: string,
  ctx: NetContext = {},
): Promise<Suggestion[]> {
  const answers = await Promise.all(
    SUGGEST_ENGINES.map((engine) => askEngine(engine, seed, ctx)),
  );
  const out: Suggestion[] = [];
  const failed: SuggestEngine[] = [];
  for (const answer of answers) {
    out.push(...answer.suggestions);
    if (answer.failed) failed.push(answer.engine);
  }
  if (failed.length === 0) return out;
  const retried = await Promise.all(
    failed.map((engine) =>
      askEngine(engine, seed, withTimeout(ctx, SUGGEST_RETRY_TIMEOUT_MS)),
    ),
  );
  for (const answer of retried) out.push(...answer.suggestions);
  return out;
}

export const EXPANSION_MODIFIERS = ["best", "how to", "vs", "pricing", "tools"];

export type KeywordIntent = "question" | "commercial" | "informational";

const QUESTION_STARTERS = [
  "how",
  "what",
  "why",
  "when",
  "where",
  "who",
  "can",
  "does",
  "is",
  "should",
  "which",
];

const COMMERCIAL_TERMS = [
  "best",
  "top",
  "vs",
  "versus",
  "alternative",
  "alternatives",
  "compare",
  "comparison",
  "pricing",
  "price",
  "cost",
  "cheap",
  "free",
  "review",
  "reviews",
  "download",
  "tool",
  "tools",
  "software",
  "service",
  "services",
  "agency",
  "company",
];

export function classifyIntent(text: string): KeywordIntent {
  const lower = text.toLowerCase().trim();
  if (lower.includes("?")) return "question";
  const first = lower.split(/\s+/)[0] ?? "";
  if (QUESTION_STARTERS.includes(first)) return "question";
  if (COMMERCIAL_TERMS.some((term) => lower.includes(term)))
    return "commercial";
  return "informational";
}

export interface KeywordCandidate {
  keyword: string;
  autocomplete_rank: number;
  engines: SuggestEngine[];
  intent: KeywordIntent;
}

export interface KeywordResearch {
  seed: string;
  candidates: KeywordCandidate[];
  questions: string[];
  seeds_asked: string[];
  engines_answered: SuggestEngine[];
  engines_silent: SuggestEngine[];
  source: "autocomplete";
  note: string;
}

interface Merged {
  text: string;
  bestRank: number;
  engines: Set<SuggestEngine>;
}

function mergeSuggestions(suggestions: Suggestion[]): Merged[] {
  const merged = new Map<string, Merged>();
  for (const suggestion of suggestions) {
    const key = suggestion.text.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.bestRank = Math.min(existing.bestRank, suggestion.rank);
      existing.engines.add(suggestion.engine);
      continue;
    }
    merged.set(key, {
      text: suggestion.text,
      bestRank: suggestion.rank,
      engines: new Set([suggestion.engine]),
    });
  }
  return [...merged.values()];
}

export interface ResearchOptions {
  limit?: number;
  depth?: "quick" | "deep";
  ctx?: NetContext;
}

/**
 * Expands a seed into keyword candidates by asking the autocomplete
 * endpoints for the seed and a set of modifiers.
 */
export async function researchKeywords(
  seed: string,
  options: ResearchOptions = {},
): Promise<KeywordResearch> {
  const limit = options.limit ?? 20;
  const depth = options.depth ?? "deep";
  const ctx = options.ctx ?? {};
  const seeds = [seed];
  if (depth === "deep") {
    for (const modifier of EXPANSION_MODIFIERS) {
      seeds.push(`${seed} ${modifier}`);
    }
  }
  const settled = await Promise.allSettled(
    seeds.map(async (entry) => ({
      seed: entry,
      suggestions: await collectSuggestions(entry, ctx),
    })),
  );
  const all: Suggestion[] = [];
  const asked: string[] = [];
  const answered = new Set<SuggestEngine>();
  for (const entry of settled) {
    if (entry.status !== "fulfilled") continue;
    asked.push(entry.value.seed);
    for (const suggestion of entry.value.suggestions) {
      all.push(suggestion);
      answered.add(suggestion.engine);
    }
  }
  const merged = mergeSuggestions(all).sort((left, right) => {
    if (right.engines.size !== left.engines.size)
      return right.engines.size - left.engines.size;
    if (left.bestRank !== right.bestRank) return left.bestRank - right.bestRank;
    return left.text.localeCompare(right.text);
  });
  const candidates: KeywordCandidate[] = merged
    .slice(0, limit)
    .map((entry) => ({
      keyword: entry.text,
      autocomplete_rank: entry.bestRank,
      engines: [...entry.engines],
      intent: classifyIntent(entry.text),
    }));
  const questions = candidates
    .filter((candidate) => candidate.intent === "question")
    .map((candidate) => candidate.keyword);
  return {
    seed,
    candidates,
    questions,
    seeds_asked: asked,
    engines_answered: [...answered],
    engines_silent: SUGGEST_ENGINES.filter((engine) => !answered.has(engine)),
    source: "autocomplete",
    note: "Autocomplete shows what people type, not search volume. No volume number is available without a paid keyword API.",
  };
}
