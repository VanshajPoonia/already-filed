// Remembers vectors between Action runs, keyed by a hash of the exact text embedded, so a
// rerun only embeds what is new or edited. The workflow's cache step keeps the file.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const hash = (t) => createHash('sha1').update(t).digest('hex').slice(0, 20);

/** Wraps an embedder with a store; `save` keeps only the vectors this run used. */
export function vectorCache(embed, file, tag) {
  const store = new Map();
  const used = new Set();
  if (file && existsSync(`${file}.json`) && existsSync(`${file}.bin`)) {
    const meta = JSON.parse(readFileSync(`${file}.json`, 'utf8'));
    if (meta.tag === tag) {
      const buf = readFileSync(`${file}.bin`);
      const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      meta.keys.forEach((k, i) => store.set(k, all.slice(i * meta.dims, (i + 1) * meta.dims)));
    }
  }
  const stats = { reused: 0, embedded: 0 };
  const cachedEmbed = async (texts) => {
    const keys = texts.map(hash);
    const miss = [...new Map(keys.map((k, i) => [k, texts[i]])).entries()].filter(([k]) => !store.has(k));
    if (miss.length) {
      const vecs = await embed(miss.map(([, t]) => t));
      miss.forEach(([k], i) => store.set(k, vecs[i]));
    }
    stats.embedded += miss.length;
    stats.reused += new Set(keys).size - miss.length;
    keys.forEach((k) => used.add(k));
    return keys.map((k) => store.get(k));
  };
  const save = () => {
    if (!file || !used.size) return;
    const keys = [...used];
    const dims = store.get(keys[0]).length;
    const all = new Float32Array(keys.length * dims);
    keys.forEach((k, i) => all.set(store.get(k), i * dims));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.bin`, Buffer.from(all.buffer));
    writeFileSync(`${file}.json`, JSON.stringify({ tag, dims, keys }));
  };
  return { embed: cachedEmbed, save, stats };
}
