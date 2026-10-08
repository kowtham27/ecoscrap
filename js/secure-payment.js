// Secure Payment to Collector + Fraud / Underpayment Alert.
//
// How a doorstep pickup is settled:
//   1. Booking created  -> payment is 'Held' and the customer gets a 4-digit handover code.
//   2. Dealer arrives, weighs the scrap, pays (cash or UPI/bank).
//   3. Customer gives the code ONLY once paid. The dealer enters weight + amount + code,
//      or the customer confirms from their own phone.
//   4. Server checks the amount against the fair value of the weighed scrap. Anything more
//      than 5% short comes back as an Underpayment Alert instead of completing — the
//      customer can accept the shortfall or raise a dispute. A dealer can't accept it for them.

const SecurePayment = {
  pollCounter: 0,

  fairValue(booking, weighedKg) {
    return Math.round((Number(weighedKg) || booking.weightKg) * booking.ratePerKg * (booking.qualityMultiplier || 1));
  },

  money(n) { return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`; },

  // ---------------- Customer side ----------------
  customerPanelHtml() {
    const b = AppState.activeBooking;
    if (!b) return '';
    const digits = String(b.handoverOtp || '----').split('').map(d => `<span>${d}</span>`).join('');
    const modeLabel = { cash: I18N.t('payModeCash'), upi: I18N.t('payModeUpi'), bank: I18N.t('payModeBank') }[b.paymentMode] || b.paymentMode;
    return `
      <div class="escrow">
        <div class="escrow-main">
          <div class="escrow-state"><i class="pulse-dot amber"></i>${I18N.t('paymentHeldLabel')}</div>
          <div class="escrow-amount">${this.money(b.totalAmount)}</div>
          <div class="escrow-meta">${modeLabel} · ${b.bookingCode} · ${b.weightKg} kg × ₹${b.ratePerKg}</div>
        </div>
        <div class="escrow-code">
          <div class="escrow-code-label">${I18N.t('handoverCodeLabel')}</div>
          <div class="otp">${digits}</div>
          <div class="escrow-code-hint">${I18N.t('handoverCodeHint')}</div>
        </div>
        <button class="btn-primary escrow-btn" onclick="SecurePayment.openCustomerConfirm()">${I18N.t('confirmHandoverBtn')}</button>
      </div>
    `;
  },

  openCustomerConfirm() {
    const b = AppState.activeBooking;
    if (!b) return;
    this.showModal(`
      <p class="eyebrow">${I18N.t('securePaymentTitle')}</p>
      <h3 class="modal-h">${I18N.t('confirmHandoverTitle')}</h3>
      <p class="modal-p">${I18N.t('confirmHandoverDesc')}</p>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="spWeighed">${I18N.t('weighedAtDoorLabel')}</label>
          <input class="form-input" id="spWeighed" type="number" step="0.05" min="0" value="${b.weightKg}" oninput="SecurePayment.updateFairHint()">
        </div>
        <div class="form-group">
          <label class="form-label" for="spPaid">${I18N.t('amountReceivedLabel')}</label>
          <input class="form-input" id="spPaid" type="number" step="1" min="0" value="${Math.round(b.totalAmount)}">
        </div>
      </div>
      <div class="fair-hint" id="spFairHint"></div>
      <div id="spResult"></div>
      <button class="btn-primary" id="spSubmit" onclick="SecurePayment.submitCustomer()">${I18N.t('releasePaymentBtn')}</button>
    `);
    this.updateFairHint();
  },

  updateFairHint() {
    const b = AppState.activeBooking;
    const el = document.getElementById('spFairHint');
    if (!b || !el) return;
    const kg = document.getElementById('spWeighed').value;
    el.innerHTML = I18N.tf('fairValueHint', { amount: this.money(this.fairValue(b, kg)), kg: Number(kg) || b.weightKg, rate: b.ratePerKg });
  },

  async submitCustomer(extra = {}) {
    const b = AppState.activeBooking;
    if (!b) return;
    const weighedKg = Number(document.getElementById('spWeighed')?.value) || this._last?.weighedKg;
    const amountPaid = document.getElementById('spPaid') ? Number(document.getElementById('spPaid').value) : this._last?.amountPaid;
    this._last = { weighedKg, amountPaid };
    try {
      const done = await API.completeBooking(b.id, { confirmedBy: 'customer', weighedKg, amountPaid, ...extra });
      this.closeModal();
      this.finishCustomer(done);
    } catch (err) {
      if (err.status === 409 && err.data && err.data.alert) return this.showUnderpaymentAlert(err.data.alert);
      const r = document.getElementById('spResult');
      if (r) r.innerHTML = `<div class="note note-bad">${err.message}</div>`;
    }
  },

  showUnderpaymentAlert(a) {
    I18N.speak(I18N.tf('underpaymentSpeech', { amount: a.shortfall }));
    this.showModal(`
      <div class="alert-head"><span class="alert-ico">!</span><div>
        <p class="eyebrow danger">${I18N.t('underpaymentAlertTitle')}</p>
        <h3 class="modal-h">${I18N.tf('underpaymentHeadline', { amount: this.money(a.shortfall), pct: a.shortfallPct })}</h3>
      </div></div>
      <table class="mini-table">
        <tr><td>${I18N.t('weighedAtDoorLabel')}</td><td>${a.weighedKg} kg × ₹${a.ratePerKg}</td></tr>
        <tr><td>${I18N.t('fairValueLabel')}</td><td><strong>${this.money(a.fairValue)}</strong></td></tr>
        <tr><td>${I18N.t('amountReceivedLabel')}</td><td><strong class="txt-down">${this.money(a.paid)}</strong></td></tr>
      </table>
      <p class="modal-p">${I18N.t('underpaymentAdvice')}</p>
      <div class="btn-row">
        <button class="btn-danger" onclick="SecurePayment.submitCustomer({ dispute: true })">${I18N.t('raiseDisputeBtn')}</button>
        <button class="btn-secondary" onclick="SecurePayment.submitCustomer({ acceptShortfall: true })">${I18N.tf('acceptAnywayBtn', { amount: this.money(a.paid) })}</button>
      </div>
    `);
  },

  finishCustomer(done) {
    const paid = this.money(done.amountPaid);
    AppState.activeBookingNotice = done.status === 'Disputed'
      ? `⚠️ ${I18N.tf('disputeRaisedNotice', { code: done.bookingCode })}`
      : `✅ ${I18N.tf('paymentReleasedNotice', { amount: paid, by: done.confirmedBy === 'dealer' ? I18N.t('byDealerLabel') : I18N.t('byYouLabel') })}`;
    AppState.activeBooking = null;
    AppState.deliveryStartedAt = null;
    AppState.customerProfileData = null;
    renderCustomerPage(document.getElementById('appContent'));
  },

  // Called from the delivery ticker — picks up a handover the dealer confirmed on their side.
  async pollActiveBooking() {
    const b = AppState.activeBooking;
    if (!b || !AppState.user) return;
    if (++this.pollCounter % 2) return; // every other tick (~8s)
    try {
      const rows = await API.listBookings({ customerPhone: AppState.user.phone });
      const fresh = rows.find(r => r.id === b.id);
      if (fresh && fresh.status !== 'Requested' && AppState.activeBooking && AppState.activeBooking.id === b.id) {
        this.closeModal();
        this.finishCustomer(fresh);
      }
    } catch {}
  },

  // ---------------- Dealer side ----------------
  dealerCardHtml() {
    return `
      <div class="card" id="dealerPickupsCard">
        <div class="card-header">
          <div>
            <h3 class="card-title">${I18N.t('dealerPickupsTitle')}</h3>
            <p class="card-subtitle">${I18N.t('dealerPickupsSubtitle')}</p>
          </div>
          <button class="btn-secondary btn-sm" onclick="SecurePayment.loadDealerPickups()">${I18N.t('refreshBtn')}</button>
        </div>
        <div id="dealerPickupsList"><div class="muted small">${I18N.t('loadingLabel')}</div></div>
      </div>
    `;
  },

  dealerId() {
    return ESETU_DATA.kabadiwalas.find(k => k.phone === AppState.user.phone)?.id || AppState.user.phone;
  },

  async loadDealerPickups() {
    const el = document.getElementById('dealerPickupsList');
    if (!el) return;
    try {
      const rows = await API.listBookings({ kabadiwalaId: this.dealerId(), status: 'Requested' });
      this._dealerRows = rows;
      if (!rows.length) {
        el.innerHTML = `<div class="empty-line">${I18N.t('noPendingPickups')}</div>`;
        return;
      }
      el.innerHTML = rows.map(b => `
        <div class="pickup" id="pickup-${b.id}">
          <div class="pickup-head">
            <div>
              <strong>${b.customerName || I18N.t('genericCustomerLabel')}</strong>
              <span class="muted">· ${b.materialName.split('(')[0]}</span>
            </div>
            <span class="chip chip-amber">${I18N.t('paymentHeldLabel')} ${this.money(b.totalAmount)}</span>
          </div>
          <div class="pickup-meta muted">${b.bookingCode} · ${I18N.t('quotedLabel')} ${b.weightKg} kg × ₹${b.ratePerKg}${b.qualityGrade ? ` · ${I18N.t('gradeLabel')} ${b.qualityGrade}` : ''}</div>
          <div class="pickup-form">
            <label>${I18N.t('weighedKgShort')}<input class="form-input" type="number" step="0.05" min="0" id="dw-${b.id}" value="${b.weightKg}" oninput="SecurePayment.dealerFair(${b.id})"></label>
            <label>${I18N.t('paidShort')}<input class="form-input" type="number" step="1" min="0" id="dp-${b.id}" value="${Math.round(b.totalAmount)}"></label>
            <label>${I18N.t('customerCodeShort')}<input class="form-input otp-input" inputmode="numeric" maxlength="4" id="do-${b.id}" placeholder="••••"></label>
            <button class="btn-primary" onclick="SecurePayment.submitDealer(${b.id})">${I18N.t('releasePaymentBtn')}</button>
          </div>
          <div class="pickup-foot" id="df-${b.id}">${I18N.tf('fairValueHint', { amount: this.money(b.totalAmount), kg: b.weightKg, rate: b.ratePerKg })}</div>
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = `<div class="note note-bad">${err.message}</div>`;
    }
  },

  dealerFair(id) {
    const b = (this._dealerRows || []).find(r => r.id === id);
    const foot = document.getElementById(`df-${id}`);
    if (!b || !foot) return;
    const kg = Number(document.getElementById(`dw-${id}`).value) || b.weightKg;
    const fair = this.fairValue(b, kg);
    foot.innerHTML = I18N.tf('fairValueHint', { amount: this.money(fair), kg, rate: b.ratePerKg });
    document.getElementById(`dp-${id}`).value = fair;
  },

  async submitDealer(id) {
    const foot = document.getElementById(`df-${id}`);
    const body = {
      confirmedBy: 'dealer',
      weighedKg: Number(document.getElementById(`dw-${id}`).value),
      amountPaid: Number(document.getElementById(`dp-${id}`).value),
      otp: document.getElementById(`do-${id}`).value.trim()
    };
    try {
      await API.completeBooking(id, body);
      const row = document.getElementById(`pickup-${id}`);
      if (row) row.classList.add('pickup-done');
      foot.innerHTML = `<span class="txt-up">✓ ${I18N.tf('dealerReleasedMsg', { amount: this.money(body.amountPaid) })}</span>`;
      setTimeout(() => this.loadDealerPickups(), 1600);
    } catch (err) {
      const msg = err.status === 409 && err.data && err.data.alert
        ? I18N.tf('dealerUnderpayMsg', { fair: this.money(err.data.alert.fairValue), paid: this.money(err.data.alert.paid) })
        : err.message;
      foot.innerHTML = `<span class="txt-down">⚠ ${msg}</span>`;
    }
  },

  // ---------------- Modal helpers ----------------
  showModal(inner) {
    this.closeModal();
    const wrap = document.createElement('div');
    wrap.id = 'securePayModal';
    wrap.className = 'modal-overlay';
    wrap.onclick = (e) => { if (e.target === wrap) SecurePayment.closeModal(); };
    wrap.innerHTML = `<div class="modal-content" role="dialog"><button class="modal-close" onclick="SecurePayment.closeModal()" aria-label="${I18N.t('closeBtn')}">×</button>${inner}</div>`;
    document.body.appendChild(wrap);
  },

  closeModal() {
    const el = document.getElementById('securePayModal');
    if (el) el.remove();
  }
};

window.SecurePayment = SecurePayment;
