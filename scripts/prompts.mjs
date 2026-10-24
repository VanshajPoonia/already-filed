// Which EmbeddingGemma prompt works best? Tried on the tuning repo's titles only, before the
// test repos were run again.   node scripts/prompts.mjs
import * as tf from '@huggingface/transformers';
import { loadRepo, questions, texts, embedCached } from './data.mjs';
import { Matcher, candidates, rank, score, pct } from './measure.mjs';
import { embedder } from '../src/embed.js';
const is = loadRepo('ollama/ollama'), q = questions(is), list = texts(is, 'clean'), titles = texts(is, 'title'), all = candidates(is);
const variants = { similarity: 'task: sentence similarity | query: ', cluster: 'task: clustering | query: ', search: 'task: search result | query: ', doc: 'title: none | text: ', none: '' };
for (const [name, prefix] of Object.entries(variants)) {
  const e = await embedder(tf, 'gemma', { prefix });
  const t = await embedCached(`ollama__ollama-gemma-title-${name}`, titles, e, 768);
  const s = score(rank(new Matcher(t, t, list, { body: 0, title: 1, keywords: 0 }), q.dups, all), { ...q, others: [] });
  console.log(`gemma title, prompt "${prefix}"`.padEnd(52), 'top1', pct(s.at1), 'top3', pct(s.at3), 'top5', pct(s.at5));
}
