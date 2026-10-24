// Keyword search, the baseline: BM25, the ranking behind most search boxes (GitHub's issue
// search included, roughly). No model, just shared words weighted by how rare they are.

const STOP = new Set('a an and are as at be but by can do does for from has have how i if in is it its me my no not of on or so that the this to was we what when with you your'.split(' '));

export function tokens(text) {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9_.+-]*[a-z0-9]|[a-z0-9]/g)?.filter((t) => !STOP.has(t)) ?? [];
}

/** An index you add documents to in order, and query against everything added so far. */
export class BM25 {
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.postings = new Map(); // term -> [[doc, tf], ...]
    this.len = [];
    this.total = 0;
  }

  add(text) {
    const doc = this.len.length;
    const tf = new Map();
    const ts = tokens(text);
    for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      if (!this.postings.has(t)) this.postings.set(t, []);
      this.postings.get(t).push([doc, n]);
    }
    this.len.push(ts.length);
    this.total += ts.length;
    return doc;
  }

  /** Scores for every document added so far. */
  scores(text) {
    const N = this.len.length;
    const avg = this.total / Math.max(1, N);
    const out = new Float32Array(N);
    for (const t of new Set(tokens(text))) {
      const p = this.postings.get(t);
      if (!p) continue;
      const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5));
      for (const [d, n] of p) {
        out[d] += idf * (n * (this.k1 + 1)) / (n + this.k1 * (1 - this.b + this.b * this.len[d] / avg));
      }
    }
    return out;
  }
}
