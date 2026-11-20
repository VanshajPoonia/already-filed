// When to show a suggestion, chosen on the tuning repo (ollama/ollama) by scripts/tune.mjs,
// from how many issues that were never marked a duplicate would get one.
//   LIKELY: 5% of them would
//   MAYBE: 20% of them would
export const LIKELY = 0.907;
export const MAYBE = 0.841;
// Pull requests start on the same lines, until tests/pr-eval.mjs measures their own.
export const PR_LIKELY = LIKELY;
export const PR_MAYBE = MAYBE;
