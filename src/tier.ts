/** Tiers: the Ahrefs path needs a paid key, the keyless path does not. */

export type Tier = "ahrefs" | "keyless";

export type Source =
  "ahrefs" | "autocomplete" | "trends" | "serp" | "http" | "estimate";

export function hasCapsolverKey(): boolean {
  return Boolean(process.env.CAPSOLVER_API_KEY);
}

export function resolveTier(): Tier {
  return hasCapsolverKey() ? "ahrefs" : "keyless";
}
