// Duplicate PRs. Replays a repo's pull requests in the order they were filed (since the date the
// snapshot starts) and asks two questions of each new PR:
//   1. Said duplicates: a maintainer called it a repeat of an earlier PR ("duplicate of #456",
//      "superseded by #789", or GitHub's "Duplicate of" event). Is that PR among the suggestions?
//   2. Same issue: it fixes an issue that an earlier PR, open or merged, also fixes. The link
//      rule (src/prs.js sameIssue) finds these by definition, so the question is whether the
//      text alone would: the compared text has every "fixes #N" taken out.
// Each new PR is compared with the PRs open when it was filed, or closed in the 30 days before.
// The recipe is the issue one, frozen: same prompt, same mix, same cleaning. Only the PR
// threshold was chosen here, on the first half of the PRs, and it is measured on the second.
//
//   node tests/pr-eval.mjs                  meshery/meshery
//   PR_REPOS=owner/name node tests/pr-eval.mjs
//   THREADS=4 node tests/pr-eval.mjs        caps the CPU threads the first, slow run uses
import * as tf from '@huggingface/transformers';
import { loadPrs, questions, embedCached } from '../scripts/data.mjs';
import { Matcher, candidates, rank, rankOfRight, score, thresholdFor, pct, VARIANTS } from '../scripts/measure.mjs';
import { embedder, MODELS } from '../src/embed.js';
import { prText, prTemplate } from '../src/prs.js';
import { LIKELY, PR_LIKELY, PR_MAYBE } from '../src/threshold.js';

const REPOS = (process.env.PR_REPOS || 'meshery/meshery').split(',');
const embed = await embedder(tf, 'gemma', { threads: Number(process.env.THREADS) || undefined });
const fails = [];

for (const repo of REPOS) {
  const prs = loadPrs(repo);
  const key = repo.replace('/', '__');
  const template = prTemplate(prs);
  const list = prs.map((p) => prText(p, template));
  const body = await embedCached(`${key}-pr-gemma-clean`, list, embed, MODELS.gemma.dims);
  const title = await embedCached(`${key}-pr-gemma-title`, prs.map((p) => p.title.trim()), embed, MODELS.gemma.dims);
  const all = candidates(prs);
  const since = +new Date(prs.since);
  const created = prs.map((p) => +new Date(p.created));
  const inWindow = prs.map((_, i) => i).filter((i) => created[i] >= since);
  const mid = inWindow[inWindow.length >> 1];

  // 1. Said duplicates.
  const q = questions(prs);
  const said = q.dups.filter((i) => created[i] >= since);

  // 2. Same issue: an earlier candidate PR, open when this one was filed or merged, fixes one of its issues.
  const fixers = new Map();
  for (const i of inWindow) {
    const mine = new Set(prs[i].closes);
    if (!mine.size) continue;
    const by = all(i).filter((j) => prs[j].closes.some((x) => mine.has(x)) && (prs[j].state === 'merged' || !prs[j].closed || +new Date(prs[j].closed) > created[i]));
    if (by.length) fixers.set(i, new Set(by));
  }
  const same = [...fixers.keys()];

  // Never called a duplicate and fixing nothing an earlier PR fixes: any suggestion is a false alarm,
  // as far as the labels know.
  const others = inWindow.filter((i) => q.g[i] === -1 && !fixers.has(i));
  console.log(`\n${repo}: ${prs.length.toLocaleString()} PRs since ${prs.since} (bots left out); ${said.length} called a duplicate of an earlier PR, ${same.length} fix an issue an earlier open or merged PR also fixes, ${others.length.toLocaleString()} neither`);

  const ids = [...new Set([...said, ...same, ...others])];
  const ranks = {
    keywords: rank(new Matcher(body, title, list, VARIANTS.keywords), ids, all),
    bodyOnly: rank(new Matcher(body, title, list, VARIANTS.bodyOnly), ids, all),
    shipped: rank(new Matcher(body, title, list, VARIANTS.shipped), ids, all),
  };
  const names = { keywords: 'keyword search (BM25)', bodyOnly: 'EmbeddingGemma alone', shipped: 'EmbeddingGemma mix (shipped)' };
  const row = (name, s) => console.log(`  ${name.padEnd(34)} top1 ${pct(s.at1).padStart(4)}  top3 ${pct(s.at3).padStart(4)}  top5 ${pct(s.at5).padStart(4)}`);

  // The link rule on said duplicates: does it share a fixed issue with the PR it repeats?
  const linkHit = said.filter((i) => all(i).some((j) => q.g[j] === q.g[i] && prs[j].closes.some((x) => prs[i].closes.includes(x))));
  console.log(`\n  1. called a duplicate (${said.length}). Fix the same linked issue as the PR they repeat: ${linkHit.length} (${pct(linkHit.length / said.length)})`);
  const s1 = {};
  for (const k of Object.keys(ranks)) row(names[k], (s1[k] = score(ranks[k], { ...q, dups: said, others: [] })));
  // Links first, then the mix: what the PR view and the Action show.
  const both = said.filter((i) => linkHit.includes(i) || rankOfRight(ranks.shipped.get(i), i, q.g) <= 3).length;
  console.log(`  ${'links, then the mix'.padEnd(34)}            top3 ${pct(both / said.length).padStart(4)}`);

  // Same issue: right if any earlier fixer is in the top k.
  const sameScore = (r) => {
    let a1 = 0, a3 = 0, a5 = 0;
    for (const i of same) {
      const k = r.get(i).findIndex(([j]) => fixers.get(i).has(j));
      if (k === 0) a1++;
      if (k >= 0 && k < 3) a3++;
      if (k >= 0 && k < 5) a5++;
    }
    return { at1: a1 / same.length, at3: a3 / same.length, at5: a5 / same.length };
  };
  console.log(`\n  2. fix an issue an earlier PR fixes (${same.length}). The link rule finds all of them; the text alone, with links taken out:`);
  const s2 = {};
  for (const k of Object.keys(ranks)) row(names[k], (s2[k] = sameScore(ranks[k])));

  // The thresholds, chosen like the issue ones on the first half: "likely" where 5% of the
  // "neither" PRs would get a suggestion, "maybe" where 20% would.
  const firstOthers = others.filter((i) => i < mid);
  const chosen = thresholdFor(ranks.shipped, firstOthers, 0.05);
  const chosenMaybe = thresholdFor(ranks.shipped, firstOthers, 0.2);
  const later = (xs) => xs.filter((i) => i >= mid);
  const caught = (xs, ok, t) => xs.filter((i) => ranks.shipped.get(i).slice(0, 3).some(([j, s]) => s >= t && ok(i, j))).length / xs.length;
  const alarms = (t) => later(others).filter((i) => (ranks.shipped.get(i)[0]?.[1] ?? -Infinity) >= t).length / later(others).length;
  const okSaid = (i, j) => q.g[j] === q.g[i];
  const okSame = (i, j) => fixers.get(i).has(j);
  console.log(`\n  first half: 5% of "neither" PRs score ${chosen.toFixed(3)} or more, 20% score ${chosenMaybe.toFixed(3)} (src/threshold.js: PR_LIKELY ${PR_LIKELY}, PR_MAYBE ${PR_MAYBE})`);
  for (const [name, t] of [['PR_LIKELY', PR_LIKELY], ['PR_MAYBE', PR_MAYBE], ['issue LIKELY', LIKELY]]) {
    console.log(`  second half at ${name} ${t}: shows the right PR for ${pct(caught(later(said), okSaid, t))} of said duplicates and ${pct(caught(later(same), okSame, t))} of same-issue PRs, on ${pct(alarms(t))} of "neither" PRs`);
  }

  if (!(s1.shipped.at3 > s1.keywords.at3)) fails.push(`${repo}: on said duplicates, the mix should beat keyword search at top 3`);
}

if (fails.length) { console.log('\nFAIL:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('\nPASS: on said duplicate PRs, EmbeddingGemma puts the right earlier PR in the top 3 more often than keyword search');
