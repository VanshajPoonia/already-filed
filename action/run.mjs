// The GitHub Action's entry point (see action.yml). Reads the event, loads EmbeddingGemma
// through transformers.js from the cached model folder, and runs check.mjs.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tf from '@huggingface/transformers';
import { embedder, MODELS } from '../src/embed.js';
import { LIKELY, PR_LIKELY } from '../src/threshold.js';
import { check } from './check.mjs';
import { vectorCache } from './vectors.mjs';

const env = process.env;
const number = (s, fallback) => {
  if (s == null || s === '') return fallback;
  const x = Number(s);
  if (!(x > 0 && x < 1)) throw new Error(`A threshold must be between 0 and 1, not "${s}".`);
  return x;
};

const cacheDir = env.ISSUETWIN_CACHE || join(env.HOME || '.', '.cache', 'issuetwin');
tf.env.cacheDir = join(cacheDir, 'models');

const raw = await embedder(tf, 'gemma');
const cache = vectorCache(raw, join(cacheDir, 'vectors', (env.GITHUB_REPOSITORY || 'repo').replace('/', '__')), `${MODELS.gemma.id}:${MODELS.gemma.dtype}:${MODELS.gemma.prefix}`);

const result = await check({
  repo: env.GITHUB_REPOSITORY,
  event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')),
  token: env.ISSUETWIN_TOKEN,
  embed: cache.embed,
  threshold: number(env.ISSUETWIN_THRESHOLD, LIKELY),
  prThreshold: number(env.ISSUETWIN_PR_THRESHOLD, PR_LIKELY),
  dryRun: env.ISSUETWIN_DRY_RUN === 'true',
  log: (s) => console.log(s),
});
cache.save();
console.log(`Vectors: ${cache.stats.embedded} embedded, ${cache.stats.reused} reused from the cache.`);

if (env.GITHUB_OUTPUT) {
  appendFileSync(env.GITHUB_OUTPUT, `comment=${result.action}\nmatches=${(result.matches ?? []).map((m) => m.n).join(',')}\n`);
}
