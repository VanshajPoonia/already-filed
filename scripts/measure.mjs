// Replays a repo's issues in the order they were filed and scores a way of matching them.
import { Matcher, candidates, WEIGHTS } from '../src/match.js';

const K = 5;

/** Top matches among the issues each question would have been compared with. */
export function rank(matcher, ids, candsOf) {
  const out = new Map();
  for (const i of ids) out.set(i, matcher.top(i, candsOf(i), K));
  return out;
}

/** The variants the tests compare, all on the same candidates. */
export const VARIANTS = {
  keywords: { body: 0, title: 0, keywords: 1 },
  bodyOnly: { body: 1, title: 0, keywords: 0 },
  shipped: WEIGHTS,
};

export { Matcher, candidates };

/** Where the first right answer sits in the list (1-based), or Infinity. */
export function rankOfRight(top, i, g) {
  const k = top.findIndex(([j]) => g[j] === g[i]);
  return k === -1 ? Infinity : k + 1;
}

/**
 * Scores a ranking:
 *   at1/at3/at5: share of duplicates whose right answer is in the top 1/3/5
 *   with a threshold t (show up to 3 earlier issues scoring at least t):
 *     caught: share of duplicates where the right answer is shown
 *     alarms: share of never-linked issues that get any suggestion
 */
export function score(ranks, { g, dups, others }, t = -Infinity) {
  let a1 = 0, a3 = 0, a5 = 0, caught = 0, alarms = 0;
  for (const i of dups) {
    const top = ranks.get(i);
    const r = rankOfRight(top, i, g);
    if (r <= 1) a1++;
    if (r <= 3) a3++;
    if (r <= 5) a5++;
    if (r <= 3 && top[r - 1][1] >= t) caught++;
  }
  for (const i of others) if ((ranks.get(i)[0]?.[1] ?? -Infinity) >= t) alarms++;
  return { at1: a1 / dups.length, at3: a3 / dups.length, at5: a5 / dups.length, caught: caught / dups.length, alarms: alarms / others.length };
}

/** The threshold at which a given share of never-linked issues would get a suggestion. */
export function thresholdFor(ranks, others, alarmShare) {
  const tops = others.map((i) => ranks.get(i)[0]?.[1] ?? -Infinity).sort((a, b) => b - a);
  return tops[Math.max(0, Math.floor(tops.length * alarmShare) - 1)];
}

export const pct = (x) => `${(100 * x).toFixed(0)}%`;
