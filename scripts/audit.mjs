// Prints a fixed random sample of "false alarms": issues never linked as duplicates that
// still got a confident suggestion. Reading them is how to tell a wrong suggestion from a
// duplicate nobody linked.   node scripts/audit.mjs <owner/name> [n] [threshold] [prs]
// With "prs", the same for the frozen PRs in data/prs, since their snapshot date, leaving out
// pairs that fix the same linked issue (the link rule already shows those).
import { readFileSync } from 'node:fs';
import { loadRepo, loadPrs, questions, texts } from './data.mjs';
import { Matcher, candidates } from './measure.mjs';
import { LIKELY, PR_MAYBE } from '../src/threshold.js';
import { prText, prTemplate } from '../src/prs.js';

const repo = process.argv[2] || 'ollama/ollama';
const n = Number(process.argv[3] || 30);
const prs = process.argv[5] === 'prs';
const t = Number(process.argv[4] || (prs ? PR_MAYBE : LIKELY));
const key = `${repo.replace('/', '__')}${prs ? '-pr' : ''}`;
const issues = prs ? loadPrs(repo) : loadRepo(repo);
const q = questions(issues);
const vec = (name) => { const b = readFileSync(new URL(`../tests/.cache/${key}-${name}.bin`, import.meta.url)); const a = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); return Array.from({ length: issues.length }, (_, i) => a.subarray(i * 768, (i + 1) * 768)); };
const template = prs ? prTemplate(issues) : null;
const m = new Matcher(vec('gemma-clean'), vec('gemma-title'), prs ? issues.map((p) => prText(p, template)) : texts(issues, 'clean'));
const all = candidates(issues);
const since = prs ? +new Date(issues.since) : -Infinity;
const linked = (a, b) => prs && a.closes.some((x) => b.closes.includes(x));

// A fixed shuffle (so the same sample comes out every time), then the first n above the threshold.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const order = q.others.filter((i) => +new Date(issues[i].created) >= since).map((i) => [rand(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
let shown = 0;
for (const i of order) {
  if (shown >= n) break;
  const [j, s] = m.top(i, all(i), 1)[0] ?? [];
  if (j == null || s < t || linked(issues[i], issues[j])) continue;
  shown++;
  const a = issues[i], b = issues[j];
  const short = (x) => (x.body || '').replace(/\s+/g, ' ').slice(0, 220);
  console.log(`\n[${shown}] ${s.toFixed(3)}  #${a.n} (${a.state}) ${a.title}\n      ${short(a)}\n   ~ #${b.n} (${b.state}) ${b.title}\n      ${short(b)}`);
}
