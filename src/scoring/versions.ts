/**
 * FDE Gym — scoring version constants (Task 8).
 *
 * Leaf module with no intra-scoring imports. It exists so `provenance.ts` and
 * `identity.ts` can both consume these version literals without importing each
 * other (breaking the provenance ↔ identity module-init cycle).
 */

/** The persisted score schema version (the `score.computed` shape). */
export const SCORE_SCHEMA_VERSION = 1 as const;
/** The exact scoring formula version (`src/scoring/formulas.ts`). */
export const FORMULA_VERSION = 1 as const;
/** The Coach final-review output schema version that produced the criterion scores. */
export const OUTPUT_SCHEMA_VERSION = 1 as const;
