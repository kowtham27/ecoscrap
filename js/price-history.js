// Price History — tracks how a material's rate has moved over past days & weeks.
// Reads the real rate_history table (GET /api/materials/:id/history). Points tagged
// source='seed' are the starting baseline every install begins with; everything after
// that is a real rate change published by a recycler.
//
// Customers only ever see the doorstep (customer) rate — the wholesale recycler rate is
// drawn only for dealer & recycler logins, same anti-snoop rule as the rest of the app.

const PriceHistory = {
  materialId: null,
  rangeDays: 30,
  points: [],
  loading: false,
  error: null,

  canSeeWholesale() {
    return !!(AppState.user && AppState.user.role !== 'customer');
  },

  async open(materialId) {
    this.materialId = materialId;
    this.rangeDays = 30;
    this.renderShell();
    await this.load();
  },

  close() {
    const el = document.getElementById('priceHistoryModal');
    if (el) el.remove();
    document.removeEventListener('keydown', PriceHistory.onKey);
  },

  onKey(e) { if (e.key === 'Escape') PriceHistory.close(); },

  async setRange(days) {
    this.rangeDays = days;
    await this.load();
  },

  async load() {
    this.loading = true;
    this.error = null;
    this.renderBody();
    try {
      this.points = await API.getMaterialHistory(this.materialId, this.rangeDays || undefined);
    } catch (err) {
      this.points = [];
      this.error = err.message;
    }
    this.loading = false;
    this.renderBody();
  },

  renderShell() {
    this.close();
    const mat = ESETU_DATA.materials.find(m => m.id === this.materialId);
    if (!mat) return;
    const wrap = document.createElement('div');
    wrap.id = 'priceHistoryModal';
    wrap.className = 'modal-overlay';
    wrap.onclick = (e) => { if (e.target === wrap) PriceHistory.close(); };
    wrap.innerHTML = `
      <div class="modal-content modal-wide" role="dialog" aria-labelledby="phTitle">
        <button class="modal-close" onclick="PriceHistory.close()" aria-label="${I18N.t('closeBtn')}">×</button>
        <p class="eyebrow">${I18N.t('priceHistoryTitle')}</p>
        <h3 id="phTitle" class="ph-title"><span class="ph-sym">${mat.symbol}</span> ${getLocalizedMatName(mat).split('(')[0]}</h3>
        <div id="phBody"></div>
      </div>
    `;
    document.body.appendChild(wrap);
    document.addEventListener('keydown', PriceHistory.onKey);
  },

  renderBody() {
    const body = document.getElementById('phBody');
    if (!body) return;
    const ranges = [[7, I18N.t('range7d')], [30, I18N.t('range30d')], [0, I18N.t('rangeAll')]];
    const rangeHtml = `
      <div class="seg" role="tablist">
        ${ranges.map(([d, label]) => `<button role="tab" class="${this.rangeDays === d ? 'on' : ''}" onclick="PriceHistory.setRange(${d})">${label}</button>`).join('')}
      </div>`;

    if (this.loading) {
      body.innerHTML = `${rangeHtml}<div class="ph-chart ph-empty">${I18N.t('loadingLabel')}</div>`;
      return;
    }
    if (this.error) {
      body.innerHTML = `${rangeHtml}<div class="ph-chart ph-empty" style="color:var(--danger)">${this.error}</div>`;
      return;
    }
    if (this.points.length < 2) {
      body.innerHTML = `${rangeHtml}<div class="ph-chart ph-empty">${I18N.t('noPriceHistoryYet')}</div>`;
      return;
    }

    const key = this.canSeeWholesale() ? 'recyclerRate' : 'customerRate';
    const vals = this.points.map(p => p[key]);
    const first = vals[0], last = vals[vals.length - 1];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const changePct = first ? ((last - first) / first) * 100 : 0;
    const up = changePct >= 0;
    const seedCount = this.points.filter(p => p.source === 'seed').length;
    const liveCount = this.points.length - seedCount;

    body.innerHTML = `
      ${rangeHtml}
      <div class="ph-stats">
        <div><span>${I18N.t('phNow')}</span><strong>₹${last}</strong></div>
        <div><span>${I18N.t('phLow')}</span><strong>₹${lo}</strong></div>
        <div><span>${I18N.t('phHigh')}</span><strong>₹${hi}</strong></div>
        <div><span>${I18N.t('phChange')}</span><strong class="${up ? 'txt-up' : 'txt-down'}">${up ? '+' : ''}${changePct.toFixed(1)}%</strong></div>
      </div>
      <div class="ph-chart" id="phChart">${this.buildChart()}</div>
      <div class="ph-legend">
        <span><i class="sw sw-cust"></i>${I18N.t('phDoorstepRate')}</span>
        ${this.canSeeWholesale() ? `<span><i class="sw sw-rec"></i>${I18N.t('phWholesaleRate')}</span>` : ''}
        <span class="muted">${I18N.tf('phPointsNote', { live: liveCount, seed: seedCount })}</span>
      </div>
    `;
    this.bindHover();
  },

  // Hand-drawn SVG — no chart library, so it works offline and stays tiny.
  buildChart() {
    const W = 640, H = 240, padL = 48, padR = 14, padT = 14, padB = 28;
    const pts = this.points;
    const series = [{ key: 'customerRate', cls: 'ln-cust' }];
    if (this.canSeeWholesale()) series.unshift({ key: 'recyclerRate', cls: 'ln-rec' });

    const allVals = pts.flatMap(p => series.map(s => p[s.key]));
    let lo = Math.min(...allVals), hi = Math.max(...allVals);
    const pad = Math.max(1, (hi - lo) * 0.15);
    lo = Math.max(0, Math.floor(lo - pad)); hi = Math.ceil(hi + pad);

    const t0 = new Date(pts[0].recordedAt).getTime();
    const t1 = new Date(pts[pts.length - 1].recordedAt).getTime();
    const x = t => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
    const y = v => padT + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - padT - padB);
    this._geom = { W, padL, padR, x, y, t0, t1, series };

    const grid = [0, 1, 2, 3].map(i => {
      const v = lo + ((hi - lo) * i) / 3;
      return `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="gridln"/>
              <text x="${padL - 8}" y="${y(v) + 4}" class="axis" text-anchor="end">₹${Math.round(v)}</text>`;
    }).join('');

    const fmt = d => new Date(d).toLocaleDateString(I18N.langMap[I18N.currentLang] || 'en-IN', { day: 'numeric', month: 'short' });
    const xLabels = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]].map((p, i) =>
      `<text x="${x(new Date(p.recordedAt).getTime())}" y="${H - 8}" class="axis" text-anchor="${['start', 'middle', 'end'][i]}">${fmt(p.recordedAt)}</text>`
    ).join('');

    const lines = series.map(s => {
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(new Date(p.recordedAt).getTime()).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ');
      const area = s.key === 'customerRate'
        ? `<path d="${d} L${x(t1)},${H - padB} L${x(t0)},${H - padB} Z" class="area-cust"/>` : '';
      const dots = pts.map(p => p.source === 'seed' ? '' :
        `<circle cx="${x(new Date(p.recordedAt).getTime())}" cy="${y(p[s.key])}" r="3.5" class="dot ${s.cls}"/>`).join('');
      return `${area}<path d="${d}" class="${s.cls}"/>${dots}`;
    }).join('');

    return `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="ph-svg" role="img" aria-label="${I18N.t('priceHistoryTitle')}">
        ${grid}${xLabels}${lines}
        <line id="phCursor" y1="${padT}" y2="${H - padB}" class="cursor" style="display:none"/>
      </svg>
      <div id="phTip" class="ph-tip" style="display:none"></div>
    `;
  },

  bindHover() {
    const chart = document.getElementById('phChart');
    if (!chart || !this._geom) return;
    const svg = chart.querySelector('svg');
    const tip = document.getElementById('phTip');
    const cursor = document.getElementById('phCursor');
    const { W, x, series } = this._geom;
    const pts = this.points;

    const move = (clientX) => {
      const r = svg.getBoundingClientRect();
      const sx = ((clientX - r.left) / r.width) * W;
      let best = 0, bestD = Infinity;
      pts.forEach((p, i) => { const d = Math.abs(x(new Date(p.recordedAt).getTime()) - sx); if (d < bestD) { bestD = d; best = i; } });
      const p = pts[best];
      const px = x(new Date(p.recordedAt).getTime());
      cursor.setAttribute('x1', px); cursor.setAttribute('x2', px); cursor.style.display = '';
      const when = new Date(p.recordedAt).toLocaleDateString(I18N.langMap[I18N.currentLang] || 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      tip.innerHTML = `<b>${when}</b>${series.slice().reverse().map(s =>
        `<div>${s.key === 'customerRate' ? I18N.t('phDoorstepRate') : I18N.t('phWholesaleRate')}: <strong>₹${p[s.key]}</strong></div>`).join('')}
        ${p.source === 'seed' ? `<div class="muted">${I18N.t('phBaselineTag')}</div>` : ''}`;
      tip.style.display = '';
      const left = (px / W) * r.width;
      tip.style.left = `${Math.min(Math.max(left, 70), r.width - 70)}px`;
    };
    const hide = () => { tip.style.display = 'none'; cursor.style.display = 'none'; };
    svg.addEventListener('mousemove', e => move(e.clientX));
    svg.addEventListener('touchmove', e => { move(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('mouseleave', hide);
  }
};

window.PriceHistory = PriceHistory;
window.openPriceHistory = (materialId) => PriceHistory.open(materialId);
