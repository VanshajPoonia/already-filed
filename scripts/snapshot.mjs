// Freezes the demo: the same issues the app would fetch for a repo (open, or closed in the 30
// days before the snapshot), their cleaned text, and EmbeddingGemma's vectors as 8-bit
// numbers, so the "Try one" button opens instantly instead of reading 2,600 issues live.
//   node scripts/snapshot.mjs ollama/ollama
import { writeFileSync, mkdirSync } from 'node:fs';
import * as tf from '@huggingface/transformers';
import { loadRepo, texts, embedCached } from './data.mjs';
import { embedder, MODELS } from '../src/embed.js';
import { RECENT_DAYS } from '../src/match.js';

const repo = process.argv[2] || 'ollama/ollama';
const key = repo.replace('/', '__');
const all = loadRepo(repo);
const taken = all.fetched;
const since = +new Date(taken) - RECENT_DAYS * 864e5;
// The vectors and the text cleaning are the ones the tests used for this repo.
const embed = await embedder(tf, 'gemma');
const body = await embedCached(`${key}-gemma-clean`, texts(all, 'clean'), embed, MODELS.gemma.dims);
const title = await embedCached(`${key}-gemma-title`, texts(all, 'title'), embed, MODELS.gemma.dims);
const clean = texts(all, 'clean');

const keep = all.map((x, i) => i).filter((i) => !all[i].closed || +new Date(all[i].closed) >= since);
const d = MODELS.gemma.dims;
const q = new Int8Array(keep.length * d * 2);
keep.forEach((i, k) => {
  for (let x = 0; x < d; x++) {
    q[(2 * k) * d + x] = Math.max(-127, Math.min(127, Math.round(body[i][x] * 127 / 0.34)));
    q[(2 * k + 1) * d + x] = Math.max(-127, Math.min(127, Math.round(title[i][x] * 127 / 0.34)));
  }
});
mkdirSync(new URL('../data/snapshots/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../data/snapshots/${key}.bin`, import.meta.url), Buffer.from(q.buffer));
writeFileSync(new URL(`../data/snapshots/${key}.json`, import.meta.url), JSON.stringify({
  repo, taken, dims: d, scale: 0.34 / 127,
  issues: keep.map((i) => ({ n: all[i].n, title: all[i].title, created: all[i].created, closed: all[i].closed, state: all[i].state })),
  texts: keep.map((i) => clean[i]),
}));
console.log(`${repo}: ${keep.length} issues (open, or closed after ${new Date(since).toISOString().slice(0, 10)})`);
