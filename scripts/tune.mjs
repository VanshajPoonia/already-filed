// Every choice that was made on the tuning repo (ollama/ollama), before the test repos were
// looked at: what gets searched, the prompt, how the three signals are mixed, and the two thresholds.
//   node scripts/tune.mjs
import * as tf from '@huggingface/transformers';
import { loadRepo, questions, texts, embedCached } from './data.mjs';
import { Matcher, candidates, rank, score, thresholdFor, pct } from './measure.mjs';
import { embedder, MODELS } from '../src/embed.js';
import { RECENT_DAYS } from '../src/match.js';

const REPO = 'ollama/ollama';
const key = REPO.replace('/', '__');
const issues = loadRepo(REPO);
const q = questions(issues);
const list = texts(issues, 'clean');
console.log(`${REPO}: ${issues.length} issues, ${q.dups.length} later marked as duplicates of an earlier one\n`);

// 1. What to search. Where was the issue a duplicate points to, when the duplicate was filed?
const created = issues.map((x) => +new Date(x.created));
const closed = issues.map((x) => (x.closed ? +new Date(x.closed) : Infinity));
let open = 0, recent = 0;
for (const i of q.dups) {
  const earlier = issues.map((_, j) => j).filter((j) => j < i && q.g[j] === q.g[i]);
  if (earlier.some((j) => closed[j] > created[i])) open++;
  else if (earlier.some((j) => created[i] - closed[j] < RECENT_DAYS * 864e5)) recent++;
}
console.log(`the earlier issue was still open for ${pct(open / q.dups.length)} of duplicates, closed in the ${RECENT_DAYS} days before for another ${pct(recent / q.dups.length)}`);
console.log(`so each new issue is compared with issues open at the time or closed in the last ${RECENT_DAYS} days\n`);

const embed = await embedder(tf, 'gemma');
const body = await embedCached(`${key}-gemma-clean`, list, embed, MODELS.gemma.dims);
const title = await embedCached(`${key}-gemma-title`, texts(issues, 'title'), embed, MODELS.gemma.dims);
const all = candidates(issues);
const everyone = (i) => Array.from({ length: i }, (_, j) => j);

const row = (name, s) => console.log(`${name.padEnd(52)} top1 ${pct(s.at1).padStart(4)}  top3 ${pct(s.at3).padStart(4)}  top5 ${pct(s.at5).padStart(4)}`);
const dupsOnly = { ...q, others: [] };
const bodyOnly = { body: 1, title: 0, keywords: 0 };

// 2. The prompt. The first version used EmbeddingGemma's "sentence similarity" prompt; its
// retrieval prompt ("search result") turned out much better (scripts/prompts.mjs compares five).
const simEmbed = await embedder(tf, 'gemma', { prefix: 'task: sentence similarity | query: ' });
const simBody = await embedCached(`${key}-gemma-clean-similarity`, list, simEmbed, MODELS.gemma.dims);
console.log('the first version, and what changed:');
row('keywords (BM25), all earlier issues', score(rank(new Matcher(body, title, list, { body: 0, title: 0, keywords: 1 }), q.dups, everyone), dupsOnly));
row('"sentence similarity" prompt, all earlier issues', score(rank(new Matcher(simBody, title, list, bodyOnly), q.dups, everyone), dupsOnly));
row('  ...only issues open then or closed in 30 days', score(rank(new Matcher(simBody, title, list, bodyOnly), q.dups, all), dupsOnly));
row('  ...with the "search result" prompt', score(rank(new Matcher(body, title, list, bodyOnly), q.dups, all), dupsOnly));

// 3. How to mix the signals: a small grid, scored on the duplicates only.
console.log('\nmixing in the title vector and keywords:');
for (const t of [0, 0.3, 0.5]) for (const k of [0, 0.1, 0.2, 0.3]) {
  const m = new Matcher(body, title, list, { body: 1 - t, title: t, keywords: k });
  row(`open/recent; title ${t}, keywords ${k}`, score(rank(m, q.dups, all), { ...q, others: [] }));
}

// 4. Thresholds for the shipped mix (title 0.3, keywords 0.1), from how often an issue that
// was never marked a duplicate would get a suggestion.
const shipped = rank(new Matcher(body, title, list), [...q.dups, ...q.others], all);
console.log('\nshipped mix, as a threshold rises:');
for (const share of [0.02, 0.05, 0.1, 0.2, 0.3]) {
  const t = thresholdFor(shipped, q.others, share);
  const s = score(shipped, q, t);
  console.log(`  t=${t.toFixed(3)}: suggests something for ${pct(s.alarms)} of other issues, shows the right one for ${pct(s.caught)} of duplicates`);
}
