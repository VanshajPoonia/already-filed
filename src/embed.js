// Turns issues into vectors. Shared by the browser and by the Node scripts that test it, so
// both run exactly the same model, prompt and quantisation. The caller passes in
// transformers.js (from jsDelivr in the browser, from npm in Node).

export const MODELS = {
  // What ships. EmbeddingGemma's ONNX export ends in its own pooling and projection layers
  // and returns a normalised `sentence_embedding`, so it is called as a model, not through
  // the feature-extraction pipeline. The 4-bit build's quantised token lookup
  // (GatherBlockQuantized) is missing from the browser's WASM runtime, so browsers without
  // WebGPU load the "no_gather" 4-bit build, which keeps that table unquantised.
  gemma: {
    id: 'onnx-community/embeddinggemma-300m-ONNX',
    wasmFile: 'model_no_gather',
    dtype: 'q4',
    // EmbeddingGemma's retrieval prompt. On the tuning repo's titles it found the right earlier
    // issue in the top 3 for 51% of duplicates, against 41% with "sentence similarity", 40%
    // with "clustering", 48% with the document prompt and 47% with none (node scripts/prompts.mjs).
    prefix: 'task: search result | query: ',
    dims: 768,
    mb: 197,
  },
  // The comparison: a model a sixth of the size.
  bge: {
    id: 'Xenova/bge-small-en-v1.5',
    dtype: 'q8',
    prefix: '',
    dims: 384,
    mb: 34,
  },
};

export const MAX_TOKENS = 256;
const BATCH = 16;

/**
 * @param {object} tf  the transformers.js module
 * @param {'gemma'|'bge'} key
 * @returns {Promise<(texts: string[], onBatch?: (done:number)=>void) => Promise<Float32Array[]>>}
 */
export async function embedder(tf, key, { device, file, prefix, maxTokens = MAX_TOKENS, progress_callback } = {}) {
  const m = MODELS[key];
  const model_file_name = file ?? (device === 'wasm' ? m.wasmFile : undefined);
  const tokenizer = await tf.AutoTokenizer.from_pretrained(m.id, { progress_callback });
  const model = await tf.AutoModel.from_pretrained(m.id, { dtype: m.dtype, model_file_name, device, progress_callback });
  const pre = prefix ?? m.prefix;

  return async (texts, onBatch) => {
    // Batches of similar length waste far less work on padding.
    const order = texts.map((t, i) => i).sort((a, b) => texts[a].length - texts[b].length);
    const out = new Array(texts.length);
    for (let i = 0; i < order.length; i += BATCH) {
      const ids = order.slice(i, i + BATCH);
      const inputs = await tokenizer(ids.map((j) => pre + texts[j]), { padding: true, truncation: true, max_length: maxTokens });
      const res = await model(inputs);
      let vecs;
      if (res.sentence_embedding) {
        vecs = res.sentence_embedding;
      } else {
        // BERT-style: the [CLS] token, normalised (what bge was trained for).
        vecs = res.last_hidden_state.slice(null, 0, null).normalize(2, -1);
      }
      const d = vecs.dims[1];
      const data = vecs.data;
      ids.forEach((j, k) => { out[j] = Float32Array.from(data.subarray(k * d, (k + 1) * d)); });
      onBatch?.(Math.min(i + BATCH, texts.length));
    }
    return out;
  };
}
