/**
 * Canonical JSON serialization: a pure, dependency-free helper for hashing.
 *
 * Kept in its own leaf module so hashing code (e.g. `src/scoring/identity.ts`)
 * can depend on it without pulling in the event-chain/domain module graph —
 * which would otherwise create an import cycle (`provenance` → `identity` →
 * `event-chain` → `domain`/`versioning` → `provenance`).
 */

/**
 * Canonical JSON: object keys sorted recursively, then `JSON.stringify`. This
 * is the byte-stability contract for hashing — independent of how an object
 * was constructed or parsed.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
