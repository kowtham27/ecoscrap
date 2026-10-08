// On-device e-scrap classifier: YOLO11s-cls fine-tuned on e-waste photos, run in the browser
// with ONNX Runtime Web (vendor/onnxruntime-web). No network call and no API key, so it is
// free, answers in well under a second and keeps working offline. See models/README.md for
// how the model was trained.
//
// Pre-processing mirrors Ultralytics' classify transforms: resize the short side to 224,
// centre-crop 224x224, RGB scaled to 0..1, NCHW. The exported model already ends in softmax.

const YoloScrap = {
  MODEL_URL: 'models/escrap-yolo11s-cls.onnx',
  LABELS_URL: 'models/escrap-labels.json',
  session: null,
  meta: null, // { imgsz, classes: [...], materialByClass: { cls: materialId|null } }
  loading: null,

  async load() {
    if (this.session) return this.session;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (!window.ort) throw new Error('ONNX Runtime failed to load.');
      // must be an absolute URL — ORT dynamically imports its .mjs helper from here
      ort.env.wasm.wasmPaths = new URL('vendor/onnxruntime-web/', document.baseURI).href;
      ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which this site doesn't set
      const [meta, session] = await Promise.all([
        fetch(this.LABELS_URL).then(r => { if (!r.ok) throw new Error('Scanner labels missing.'); return r.json(); }),
        ort.InferenceSession.create(this.MODEL_URL, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
      ]);
      this.meta = meta;
      this.session = session;
      return session;
    })();
    try {
      return await this.loading;
    } catch (err) {
      this.loading = null;
      throw err;
    }
  },

  // Start downloading the model in the background once the customer lands on the Sell tab,
  // so the first scan doesn't wait on the model fetch.
  warmUp() {
    if (!this.session && !this.loading) this.load().catch(() => {});
  },

  async imageToTensor(blob) {
    const size = (this.meta && this.meta.imgsz) || 224;
    const bitmap = await createImageBitmap(blob);
    const scale = size / Math.min(bitmap.width, bitmap.height);
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
    if (bitmap.close) bitmap.close();
    const { data } = ctx.getImageData(0, 0, size, size);
    const plane = size * size;
    const chw = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      chw[i] = data[i * 4] / 255;
      chw[plane + i] = data[i * 4 + 1] / 255;
      chw[2 * plane + i] = data[i * 4 + 2] / 255;
    }
    return new ort.Tensor('float32', chw, [1, 3, size, size]);
  },

  // -> { top: [{ cls, materialId, prob }...] sorted high to low, ms }
  async classify(blob) {
    const session = await this.load();
    const t0 = performance.now();
    const input = await this.imageToTensor(blob);
    const out = await session.run({ [session.inputNames[0]]: input });
    // Temperature-calibrated (models/escrap-labels.json): raw softmax is over-confident, so
    // p^(1/T) renormalised makes "70% sure" mean right ~9 times in 10 on held-out photos.
    const T = this.meta.temperature || 1;
    const raw = Array.from(out[session.outputNames[0]].data, p => Math.pow(Math.max(p, 1e-9), 1 / T));
    const sum = raw.reduce((a, b) => a + b, 0);
    const probs = raw.map(p => p / sum);
    const top = probs.map((p, i) => ({
      cls: this.meta.classes[i],
      materialId: this.meta.materialByClass[this.meta.classes[i]] || null,
      prob: p
    })).sort((a, b) => b.prob - a.prob);
    return { top, ms: Math.round(performance.now() - t0) };
  }
};

window.YoloScrap = YoloScrap;
