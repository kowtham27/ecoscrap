// AI Scrap Scanner — real camera capture + Gemini recognition (server/gemini-scan.js).
//
// Camera: opens the device camera in-page with getUserMedia (rear camera first on phones).
// Browsers only allow that on https:// or localhost, so when it isn't available (plain-http
// LAN address, permission denied, no camera) we fall back to a file input with
// capture="environment", which still opens the camera app on Android/iOS.
//
// Recognition: the photo is downscaled to ~1024px JPEG and posted to /api/scan. Nothing is
// guessed on the client — if the scan fails or the item isn't recognised, the customer is
// asked to pick the material by hand instead of being shown a made-up answer.

const ScrapScanner = {
  stream: null,
  facingMode: 'environment',
  state: 'idle', // idle | analyzing | error | unrecognised
  error: '',
  lastResult: null,
  previewUrl: null,

  // ---------------- Camera ----------------
  async open() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      return this.openNativeCamera();
    }
    this.showModal();
    await this.startStream();
  },

  openNativeCamera() {
    const input = document.getElementById('cameraInput');
    if (input) input.click();
  },

  openGallery() {
    this.close();
    const input = document.getElementById('galleryInput');
    if (input) input.click();
  },

  async startStream() {
    this.stopStream();
    const status = document.getElementById('camStatus');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.facingMode }, width: { ideal: 1600 }, height: { ideal: 1200 } },
        audio: false
      });
      const video = document.getElementById('camVideo');
      if (!video) return this.stopStream();
      video.srcObject = this.stream;
      await video.play().catch(() => {});
      if (status) status.textContent = '';
      document.getElementById('camShutter').disabled = false;
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      document.getElementById('camSwitch').hidden = cams.length < 2;
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      if (status) {
        status.innerHTML = `${denied ? I18N.t('cameraDeniedMsg') : I18N.t('cameraUnavailableMsg')}
          <button class="btn-secondary btn-sm" style="margin-top:10px" onclick="ScrapScanner.close(); ScrapScanner.openNativeCamera()">${I18N.t('useCameraAppBtn')}</button>`;
      }
    }
  },

  stopStream() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
  },

  async switchCamera() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    await this.startStream();
  },

  capture() {
    const video = document.getElementById('camVideo');
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      this.close();
      if (blob) this.analyze(blob);
    }, 'image/jpeg', 0.92);
  },

  showModal() {
    this.close();
    const wrap = document.createElement('div');
    wrap.id = 'cameraModal';
    wrap.className = 'modal-overlay';
    wrap.onclick = (e) => { if (e.target === wrap) ScrapScanner.close(); };
    wrap.innerHTML = `
      <div class="modal-content cam-modal" role="dialog" aria-label="${I18N.t('takePhotoBtn')}">
        <button class="modal-close" onclick="ScrapScanner.close()" aria-label="${I18N.t('closeBtn')}">×</button>
        <p class="eyebrow">${I18N.t('scrapCaptureTitle')}</p>
        <div class="cam-frame">
          <video id="camVideo" playsinline muted autoplay></video>
          <div class="cam-guide"></div>
          <div class="cam-status" id="camStatus">${I18N.t('cameraStartingMsg')}</div>
        </div>
        <p class="cam-tip">${I18N.t('cameraTip')}</p>
        <div class="cam-controls">
          <button class="btn-secondary" onclick="ScrapScanner.openGallery()">${I18N.t('uploadFromGalleryBtn')}</button>
          <button class="cam-shutter" id="camShutter" disabled onclick="ScrapScanner.capture()" aria-label="${I18N.t('captureBtn')}"><span></span></button>
          <button class="btn-secondary" id="camSwitch" hidden onclick="ScrapScanner.switchCamera()">${I18N.t('switchCameraBtn')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    this._onKey = (e) => { if (e.key === 'Escape') ScrapScanner.close(); };
    document.addEventListener('keydown', this._onKey);
  },

  close() {
    this.stopStream();
    const el = document.getElementById('cameraModal');
    if (el) el.remove();
    if (this._onKey) document.removeEventListener('keydown', this._onKey);
  },

  onFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // let the same photo be picked again
    if (file) this.analyze(file);
  },

  // ---------------- Recognition ----------------
  toJpegDataUrl(blob, maxDim = 1024) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(I18N.t('photoUnreadableMsg'))); };
      img.src = url;
    });
  },

  async analyze(blob) {
    AppState.capturedImage = blob; // still attached to the booking as handover proof
    AppState.aiScanResult = null;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = URL.createObjectURL(blob);
    this.state = 'analyzing';
    this.error = '';
    this.rerender();

    if (!navigator.onLine) {
      this.state = 'error';
      this.error = I18N.t('scanNeedsInternetMsg');
      return this.rerender();
    }

    try {
      const imageDataUrl = await this.toJpegDataUrl(blob);
      const result = await API.scanScrapPhoto(imageDataUrl);
      this.lastResult = result;
      if (!result.recognised) {
        this.state = 'unrecognised';
        this.rerender();
        I18N.speak(I18N.t('scanNotRecognisedSpeech'));
        return;
      }
      const material = ESETU_DATA.materials.find(m => m.id === result.materialId);
      AppState.aiScanResult = { ...result, material };
      AppState.selectedMaterial = material;
      this.state = 'idle';
      this.rerender();
      const matName = getLocalizedMatName(material).split('(')[0];
      I18N.speak(I18N.tf('scanAnalyzedSpeech', { matName, grade: result.grade, rate: material.customerRate }));
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      this.rerender();
    }
  },

  // Customer corrects the AI (or picks for an unrecognised photo): keep the photo + grade.
  pickMaterial(materialId) {
    const material = ESETU_DATA.materials.find(m => m.id === materialId);
    if (!material) return;
    const base = this.lastResult || {};
    AppState.aiScanResult = {
      ...base, recognised: true, materialId, material,
      grade: base.grade || 'B', gradeLabel: base.gradeLabel || 'Standard Grade',
      qualityMultiplier: base.qualityMultiplier || 1.0, correctedByUser: true
    };
    AppState.selectedMaterial = material;
    this.state = 'idle';
    this.rerender();
  },

  useEstimatedWeight() {
    const scan = AppState.aiScanResult;
    if (!scan || !scan.estimatedWeightKg) return;
    AppState.calculatorWeight = Math.max(0.1, Math.round(scan.estimatedWeightKg * 10) / 10);
    AppState.scaleReading = null;
    this.rerender();
  },

  reset() {
    AppState.aiScanResult = null;
    AppState.capturedImage = null;
    this.state = 'idle';
    this.lastResult = null;
    this.rerender();
  },

  rerender() {
    if (AppState.user && AppState.user.role === 'customer' && AppState.customerTab === 'sell') {
      renderCustomerPage(document.getElementById('appContent'));
    }
  },

  // ---------------- Rendering ----------------
  materialChipsHtml(highlightId) {
    return `<div class="scan-pick">${ESETU_DATA.materials.map(m => `
      <button class="${m.id === highlightId ? 'on' : ''}" onclick="ScrapScanner.pickMaterial('${m.id}')">${m.icon} ${getLocalizedMatName(m).split('(')[0]}</button>`).join('')}
    </div>`;
  },

  thumbHtml() {
    return this.previewUrl && AppState.capturedImage ? `<img class="scan-thumb" src="${this.previewUrl}" alt="">` : '';
  },

  cardHtml() {
    if (this.state === 'analyzing') {
      return `<div class="scan-card">${this.thumbHtml()}<div class="scan-body">
        <div class="scan-head"><span class="scan-spinner"></span>${I18N.t('scanAnalyzingMsg')}</div>
        <p class="muted small">${I18N.t('scanAnalyzingHint')}</p></div></div>`;
    }
    if (this.state === 'error') {
      return `<div class="scan-card scan-bad">${this.thumbHtml()}<div class="scan-body">
        <div class="scan-head">${I18N.t('scanFailedTitle')}</div>
        <p class="small">${this.error}</p>
        <p class="small muted" style="margin-top:8px">${I18N.t('pickMaterialManuallyMsg')}</p>
        ${this.materialChipsHtml()}
        <button class="btn-secondary btn-sm" style="margin-top:8px" onclick="ScrapScanner.open()">${I18N.t('retakePhotoBtn')}</button>
      </div></div>`;
    }
    if (this.state === 'unrecognised') {
      const r = this.lastResult || {};
      return `<div class="scan-card scan-warn">${this.thumbHtml()}<div class="scan-body">
        <div class="scan-head">${I18N.t('scanNotRecognisedTitle')}</div>
        ${r.itemDescription ? `<p class="small">${I18N.t('aiSawLabel')} <strong>${r.itemDescription}</strong></p>` : ''}
        <p class="small muted" style="margin-top:6px">${I18N.t('scanNotRecognisedHint')}</p>
        ${this.materialChipsHtml()}
        <button class="btn-secondary btn-sm" style="margin-top:8px" onclick="ScrapScanner.open()">${I18N.t('retakePhotoBtn')}</button>
      </div></div>`;
    }

    const scan = AppState.aiScanResult;
    if (!scan || !scan.material) return '';
    const unsure = !scan.correctedByUser && scan.confidencePct < 60;
    const gradeCls = scan.grade === 'A' ? 'chip-green' : (scan.grade === 'B' ? 'chip-amber' : 'chip-red');
    const matName = getLocalizedMatName(scan.material).split('(')[0];
    return `
      <div class="scan-card ${unsure ? 'scan-warn' : ''}" id="aiDetectionCard">
        ${this.thumbHtml()}
        <div class="scan-body">
          <div class="scan-head">
            <span>${I18N.t('detectResult')}</span>
            ${scan.correctedByUser
              ? `<span class="chip chip-amber">${I18N.t('setByYouChip')}</span>`
              : `<span class="chip ${unsure ? 'chip-amber' : 'chip-green'}">${I18N.tf('confidencePctLabel', { pct: scan.confidencePct })}</span>`}
          </div>
          ${scan.itemDescription ? `<div class="scan-item">${scan.itemDescription}</div>` : ''}
          <div class="scan-mat">${scan.material.icon} ${matName} · <span class="mono">₹${scan.material.customerRate}/kg</span></div>
          <div class="scan-row">
            <span class="chip ${gradeCls}">${I18N.t('qualityGradeLabel')} ${scan.grade} · ${scan.qualityMultiplier}×</span>
            ${scan.gradeReason ? `<span class="small muted">${scan.gradeReason}</span>` : ''}
          </div>
          ${scan.safetyWarning ? `<div class="note note-bad small">⚠ ${scan.safetyWarning}</div>` : ''}
          ${unsure ? `<p class="small" style="margin-top:8px"><strong>${I18N.t('scanUnsureMsg')}</strong></p>${this.materialChipsHtml(scan.materialId)}` : ''}
          <div class="scan-actions">
            ${scan.estimatedWeightKg ? `<button class="btn-secondary btn-sm" onclick="ScrapScanner.useEstimatedWeight()">${I18N.tf('useEstimatedWeightBtn', { kg: scan.estimatedWeightKg })}</button>` : ''}
            ${!unsure ? `<details class="scan-fix"><summary>${I18N.t('wrongMaterialLink')}</summary>${this.materialChipsHtml(scan.materialId)}</details>` : ''}
            <button class="btn-secondary btn-sm" onclick="ScrapScanner.open()">${I18N.t('retakePhotoBtn')}</button>
          </div>
          <p class="scan-foot">${I18N.tf('scanPoweredBy', { model: scan.model || 'Gemini' })}</p>
        </div>
      </div>`;
  }
};

window.ScrapScanner = ScrapScanner;
