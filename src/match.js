// How similar two issues are. Shared by the browser and the tests.
//
// Three signals, mixed with weights chosen on the tuning repo (ollama/ollama, scripts/tune.mjs):
//   - EmbeddingGemma's vector of the title and cleaned body: same problem, different words.
//   - its vector of the title alone: titles are where people name the bug.
//   - keyword search (BM25), scaled so the query's best match scores 1: the exact error
//     string, flag or model name that an embedding blurs.
import { BM25 } from './bm25.js';

export const WEIGHTS = { body: 0.7, title: 0.3, keywords: 0.1 };

// Duplicates point at issues that are still open, or were closed recently: on the tuning repo,
// 91% of the issues maintainers pointed to were open when the duplicate was filed, and 98%
// were open or closed in the previous 30 days. So that is what gets searched.
export const RECENT_DAYS = 30;

/** Packs unit vectors into one matrix so comparing against thousands of issues is a tight loop. */
export function pack(vecs) {
  const d = vecs[0]?.length ?? 0;
  const m = new Float32Array(vecs.length * d);
  vecs.forEach((v, i) => m.set(v, i * d));
  return { m, d, n: vecs.length };
}

function dot({ m, d }, j, v, vo = 0) {
  let s = 0;
  const jo = j * d;
  for (let x = 0; x < d; x++) s += m[jo + x] * v[vo + x];
  return s;
}

export class Matcher {
  /**
   * @param {Float32Array[]} body   vectors of each issue's title and cleaned body
   * @param {Float32Array[]} title  vectors of each issue's title
   * @param {string[]} texts        the cleaned texts, for keyword search
   */
  constructor(body, title, texts, weights = WEIGHTS) {
    this.B = pack(body);
    this.T = pack(title);
    this.w = weights;
    this.ix = new BM25();
    for (const t of texts) this.ix.add(t);
    this.texts = texts;
  }

  /**
   * The best k candidates for a query, best first, as [row, score] pairs.
   * The query is either a row of the matrix (a number) or { body, title, text } for a draft.
   */
  top(query, candidates, k = 5) {
    const own = typeof query === 'number';
    const qb = own ? this.B.m.subarray(query * this.B.d, (query + 1) * this.B.d) : query.body;
    const qt = own ? this.T.m.subarray(query * this.T.d, (query + 1) * this.T.d) : query.title;
    const kw = this.w.keywords ? this.ix.scores(own ? this.texts[query] : query.text) : null;
    let max = 1e-9;
    if (kw) for (const j of candidates) if (kw[j] > max) max = kw[j];
    const top = [];
    for (const j of candidates) {
      if (j === query) continue;
      let s = 0;
      if (this.w.body) s += this.w.body * dot(this.B, j, qb);
      if (this.w.title) s += this.w.title * dot(this.T, j, qt);
      if (kw) s += (this.w.keywords * kw[j]) / max;
      if (top.length < k || s > top[top.length - 1][1]) {
        top.push([j, s]);
        top.sort((a, b) => b[1] - a[1]);
        if (top.length > k) top.pop();
      }
    }
    return top;
  }
}

/**
 * The issues each question is compared with: filed before it, and still open then or closed
 * less than RECENT_DAYS before. `closed` is null for issues still open.
 * @returns {(i: number) => number[]}
 */
export function candidates(issues) {
  const created = issues.map((x) => +new Date(x.created));
  const closed = issues.map((x) => (x.closed ? +new Date(x.closed) : Infinity));
  return (i) => {
    const since = created[i] - RECENT_DAYS * 864e5;
    const c = [];
    for (let j = 0; j < i; j++) if (closed[j] > since) c.push(j);
    return c;
  };
}
