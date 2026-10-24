// Prints a fixed random sample of "false alarms": issues never linked as duplicates that
// still got a confident suggestion. Reading them is how to tell a wrong suggestion from a
// duplicate nobody linked.   node scripts/audit.mjs <owner/name> [n] [threshold]
import { readFileSync } from 'node:fs';
import { loadRepo, questions, texts } from './data.mjs';
import { Matcher, candidates } from './measure.mjs';
import { LIKELY } from '../src/threshold.js';

const repo = process.argv[2] || 'ollama/ollama';
const n = Number(process.argv[3] || 30);
const t = Number(process.argv[4] || LIKELY);
const key = repo.replace('/', '__');
const issues = loadRepo(repo);
const q = questions(issues);
const vec = (name) => { const b = readFileSync(new URL(`../tests/.cache/${key}-${name}.bin`, import.meta.url)); const a = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); return Array.from({ length: issues.length }, (_, i) => a.subarray(i * 768, (i + 1) * 768)); };
const m = new Matcher(vec('gemma-clean'), vec('gemma-title'), texts(issues, 'clean'));
const all = candidates(issues);

// A fixed shuffle (so the same sample comes out every time), then the first n above the threshold.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const order = q.others.map((i) => [rand(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
let shown = 0;
for (const i of order) {
  if (shown >= n) break;
  const [j, s] = m.top(i, all(i), 1)[0] ?? [];
  if (j == null || s < t) continue;
  shown++;
  const a = issues[i], b = issues[j];
  const short = (x) => (x.body || '').replace(/\s+/g, ' ').slice(0, 220);
  console.log(`\n[${shown}] ${s.toFixed(3)}  #${a.n} (${a.state}) ${a.title}\n      ${short(a)}\n   ~ #${b.n} (${b.state}) ${b.title}\n      ${short(b)}`);
}
