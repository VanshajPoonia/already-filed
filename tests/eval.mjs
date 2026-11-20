// Replays two repos the method was never tuned on, issue by issue in the order they were
// filed, and asks for each new issue: is the issue its maintainers later marked it a
// duplicate of among the suggestions? Reproduces the README's table.
//
//   npm test                 zed-industries/zed and neovim/neovim (the test repos)
//   REPOS=ollama/ollama npm test   the tuning repo, for comparison
//   THREADS=4 npm test             caps the CPU threads the first, slow run uses
//
// Each new issue is compared with the issues that were open when it was filed, or closed in
// the 30 days before. Four ways of ranking them, all scored the same way:
//   1. Keyword search (BM25) alone, roughly what GitHub's own search box does.
//   2. EmbeddingGemma alone, on the title and cleaned body.
//   3. The shipped mix: EmbeddingGemma's body and title vectors plus a little keyword score.
//   4. The same mix with bge-small, a general-purpose embedding model a sixth of the size.
// The mix and the thresholds in src/threshold.js were chosen on ollama/ollama (scripts/tune.mjs).
import * as tf from '@huggingface/transformers';
import { loadRepo, questions, texts, embedCached } from '../scripts/data.mjs';
import { Matcher, candidates, rank, rankOfRight, score, pct, VARIANTS } from '../scripts/measure.mjs';
import { embedder, MODELS } from '../src/embed.js';
import { LIKELY, MAYBE } from '../src/threshold.js';

const REPOS = (process.env.REPOS || 'zed-industries/zed,neovim/neovim').split(',');
const embedders = {};
const getEmbed = async (key) => (embedders[key] ??= await embedder(tf, key, { threads: Number(process.env.THREADS) || undefined }));
const fails = [];

for (const repo of REPOS) {
  const issues = loadRepo(repo);
  const q = questions(issues);
  const ids = [...q.dups, ...q.others];
  const list = texts(issues, 'clean');
  console.log(`\n${repo}: ${issues.length.toLocaleString()} issues; ${q.dups.length} were later marked as duplicates of an earlier one, ${q.others.length.toLocaleString()} never were`);

  // How far back a maintainer has to remember: the gap between a duplicate and the first
  // issue of its group.
  const gaps = q.dups.map((i) => i - issues.findIndex((_, j) => q.g[j] === q.g[i])).sort((a, b) => a - b);
  const days = q.dups.map((i) => (new Date(issues[i].created) - new Date(issues[issues.findIndex((_, j) => q.g[j] === q.g[i])].created)) / 864e5).sort((a, b) => a - b);
  console.log(`  the original was filed a median ${gaps[gaps.length >> 1].toLocaleString()} issues (${Math.round(days[days.length >> 1])} days) earlier`);

  const rows = [];
  const show = (name, r, thresholds) => {
    const s = score(r, q);
    let line = `  ${name.padEnd(30)} top1 ${pct(s.at1).padStart(4)}  top3 ${pct(s.at3).padStart(4)}  top5 ${pct(s.at5).padStart(4)}`;
    if (thresholds) {
      const l = score(r, q, LIKELY), m = score(r, q, MAYBE);
      line += `  | "likely": catches ${pct(l.caught)}, on ${pct(l.alarms)} of other issues  | "maybe": ${pct(m.caught)}, ${pct(m.alarms)}`;
    }
    console.log(line);
    rows.push([name, s]);
    return s;
  };

  const vecs = async (model, mode, l) => embedCached(`${repo.replace('/', '__')}-${model}-${mode}`, l, await getEmbed(model), MODELS[model].dims);
  const titles = texts(issues, 'title');
  const gB = await vecs('gemma', 'clean', list), gT = await vecs('gemma', 'title', titles);
  const bB = await vecs('bge', 'clean', list), bT = await vecs('bge', 'title', titles);
  const all = candidates(issues);
  const kw = rank(new Matcher(gB, gT, list, VARIANTS.keywords), ids, all);
  const sKw = show('keyword search (BM25)', kw);
  show('EmbeddingGemma alone', rank(new Matcher(gB, gT, list, VARIANTS.bodyOnly), ids, all));
  show('bge-small, same mix', rank(new Matcher(bB, bT, list, VARIANTS.shipped), ids, all));
  const gem = rank(new Matcher(gB, gT, list, VARIANTS.shipped), ids, all);
  const sGem = show('EmbeddingGemma mix (shipped)', gem, true);

  // Where the two disagree: duplicates only one of them puts in the top 3.
  let gOnly = 0, kOnly = 0;
  for (const i of q.dups) {
    const a = rankOfRight(gem.get(i), i, q.g) <= 3, b = rankOfRight(kw.get(i), i, q.g) <= 3;
    if (a && !b) gOnly++;
    if (b && !a) kOnly++;
  }
  console.log(`  top 3 has the right issue for EmbeddingGemma only: ${gOnly}, keywords only: ${kOnly}`);

  if (!(sGem.at3 > sKw.at3)) fails.push(`${repo}: EmbeddingGemma should beat keyword search at top 3`);
}

if (fails.length) { console.log('\nFAIL:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('\nPASS: on every test repo, EmbeddingGemma puts the right earlier issue in the top 3 more often than keyword search');
