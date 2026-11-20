// When to show a suggestion, chosen on the tuning repo (ollama/ollama) by scripts/tune.mjs,
// from how many issues that were never marked a duplicate would get one.
//   LIKELY: 5% of them would
//   MAYBE: 20% of them would
export const LIKELY = 0.907;
export const MAYBE = 0.841;
// Pull requests, chosen the same way by tests/pr-eval.mjs on the first half of meshery/meshery's
// PRs since 2025. PRs from one repo share far more words than issues do, so the lines sit higher.
export const PR_LIKELY = 1.069;
export const PR_MAYBE = 0.889;
