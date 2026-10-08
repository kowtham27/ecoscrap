// EcoScrap AI Application Controller & State Engine
// Full-Width Web Platform with Strict Multi-Role Access Control & 7 Languages

window.ESETU_DATA = window.ESETU_DATA || {};

// Real GPS capture for registration (so "Open on Google Maps" links actually work).
// Resolves to null if permission is denied/unavailable — registration still proceeds.
function getBrowserCoordinates() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 60000 }
    );
  });
}

// Delivery Partner live progress ticker — re-renders the customer Dealers tab every few
// seconds so the ETA progress bar actually advances, the same interval-based pattern
// already used for the kabadiwala/recycler chat poll (see connectChatPollInterval).
let deliveryProgressInterval = null;
function startDeliveryProgressTicker() {
  if (deliveryProgressInterval) return;
  deliveryProgressInterval = setInterval(() => {
    if (AppState.user && AppState.user.role === 'customer' && AppState.customerTab === 'dealers') {
      renderCustomerPage(document.getElementById('appContent'));
      SecurePayment.pollActiveBooking();
    } else {
      clearInterval(deliveryProgressInterval);
      deliveryProgressInterval = null;
    }
  }, 4000);
}

// Downscales a captured photo to a small JPEG data URL (~300px) before it's attached to a
// booking as handover proof — keeps rows small in SQLite/Turso. Resolves to null on any
// failure (no photo was captured, or the browser couldn't decode it) rather than throwing.
function downscaleImageToDataUrl(file, maxDim = 300) {
  return new Promise((resolve) => {
    if (!file) return resolve(null);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Localized day-of-week names (index 0 = Sunday, matching JS Date/SQL day_of_week convention)
// — shared by Smart Collection Day displays in both the customer and kabadiwala views.
function getDayNames() {
  return [
    I18N.t('dayNameSun'), I18N.t('dayNameMon'), I18N.t('dayNameTue'), I18N.t('dayNameWed'),
    I18N.t('dayNameThu'), I18N.t('dayNameFri'), I18N.t('dayNameSat')
  ];
}

// Register the service worker so the app can be installed on a home screen.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

const AppState = {
  user: null, // { role: 'customer' | 'kabadiwala' | 'recycler', name: '', phone: '', location: '', govRegNo: '', kabadiId: '' }
  selectedMaterial: null,
  calculatorWeight: 0.2,
  selectedPaymentMode: 'cash',
  capturedImage: null,
  aiScanResult: null, // { material, confidencePct, grade, gradeLabel, qualityMultiplier, itemDescription, ... } from POST /api/scan (js/scrap-scanner.js)
  activeBookingNotice: null,
  activeBooking: null, // the real customer_bookings row returned by POST /api/bookings, once requested
  customerProfileData: null, // { summary, monthlyComparison, history } fetched from GET /api/customers/:phone/summary
  scaleReading: null, // { weightKg } once a "Connect Smart Scale" simulation settles
  myCoords: null, // { latitude, longitude } captured after customer login, for distance-based matching
  isOffline: false, // true when running off the cached snapshot rather than a live bootstrap
  myInstitution: null, // registered via the customer profile's Community & Institutions section
  myContract: undefined, // undefined = not yet checked; null = checked, none found
  syncQueue: []
};

// Small hand-drawn line icons for app chrome (tabs, role picker). Content-level emoji
// (material icons etc.) stay as they are — they carry meaning for low-literacy users.
const UI_ICONS = {
  sell: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2l2 9h8l2-6H6.2"/><circle cx="8" cy="16.5" r="1.2"/><circle cx="14" cy="16.5" r="1.2"/></svg>',
  pin: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M10 18s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z"/><circle cx="10" cy="8" r="2.2"/></svg>',
  user: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10" cy="7" r="3.3"/><path d="M3.5 17.5c1-3.3 3.6-5 6.5-5s5.5 1.7 6.5 5"/></svg>',
  chart: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16h14"/><path d="M4 12l4-4 3 2.5L16.5 5"/></svg>',
  yard: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M2.5 17V8l7.5-4.5L17.5 8v9"/><path d="M6 17v-5h8v5M6 14.5h8"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h3l2 9h9.5"/><path d="M8 6h12l-1.8 6.5H9.5"/><circle cx="9" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/></svg>',
  factory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 20V10l5 3v-3l5 3v-3l5 3V4h3v16z"/><path d="M7 17h2M12 17h2"/></svg>'
};

// One tab bar for every role. items: [{ key, label, icon }]
function renderTabbar(items, activeKey, handlerName) {
  return `
    <nav class="tabbar" role="tablist">
      ${items.map((it, i) => `
        <button role="tab" aria-selected="${it.key === activeKey}" class="tab ${it.key === activeKey ? 'on' : ''}" onclick="${handlerName}('${it.key}')">
          ${UI_ICONS[it.icon] || ''}<span>${it.label}</span><span class="tab-n">0${i + 1}</span>
        </button>`).join('')}
    </nav>`;
}

// Card entrance animation should only play when the user lands on a new view, not on the
// in-place re-renders (delivery ticker every 4s, picking a material, typing in a stepper).
let lastViewKey = null;
function markView(key) {
  const el = document.getElementById('appContent');
  if (!el) return;
  el.classList.toggle('no-anim', key === lastViewKey);
  lastViewKey = key;
}

// The seeded rate6hrAgo field holds the *recycler* rate from 6 hours ago, so comparing it
// to the customer rate showed every material as crashing (PCB "-₹270"). The customer's
// previous doorstep rate is the same movement scaled onto the customer rate instead.
function customerPrevRate(m) {
  if (!m.recyclerRate || !m.recyclerRate6hrAgo) return m.customerRate;
  return Math.round(m.customerRate * (m.recyclerRate6hrAgo / m.recyclerRate));
}

// Doorstep rate ticker under the header — public customer rates only (wholesale rates
// stay behind the dealer/recycler login). Doubled so the CSS marquee loops seamlessly.
function renderRateTicker() {
  const el = document.getElementById('rateTicker');
  if (!el) return;
  const mats = ESETU_DATA.materials || [];
  if (!mats.length) { el.hidden = true; return; }
  const items = mats.map(m => {
    const diff = m.customerRate - customerPrevRate(m);
    const cls = diff > 0 ? 'up' : (diff < 0 ? 'down' : '');
    const arrow = diff > 0 ? '▲' : (diff < 0 ? '▼' : '•');
    return `<span class="rate-ticker-item" onclick="openPriceHistory('${m.id}')"><span class="sym">${m.symbol}</span><b>₹${m.customerRate}/kg</b><span class="${cls}">${arrow} ${Math.abs(diff)}</span></span>`;
  }).join('');
  el.innerHTML = `<div class="rate-ticker-label"><span class="live-dot-pulse" style="background:var(--ink)"></span>${I18N.t('tickerLabel')}</div><div class="rate-ticker-track" style="padding-left:170px">${items}${items}</div>`;
  el.hidden = false;
}

const OFFLINE_SNAPSHOT_KEY = 'esetu_offline_snapshot';
const SYNC_QUEUE_KEY = 'esetu_sync_queue';

function loadSyncQueue() {
  try { return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]'); } catch { return []; }
}
function saveSyncQueue() {
  try { localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(AppState.syncQueue)); } catch {}
}

// Replays any bookings that were queued while offline. Called on load and whenever the
// browser reports it's back online — a genuinely working (if simple, single-device,
// no-conflict-resolution) offline-write path, not just a cached read.
async function flushSyncQueue() {
  if (!AppState.syncQueue.length || !navigator.onLine) return;
  const queue = AppState.syncQueue.slice();
  AppState.syncQueue = [];
  for (const item of queue) {
    try {
      if (item.type === 'booking') await API.createBooking(item.payload);
    } catch (err) {
      AppState.syncQueue.push(item); // put it back and try again next time
    }
  }
  saveSyncQueue();
  if (AppState.user) renderApp();
}
window.addEventListener('online', flushSyncQueue);

// Initialize Web App — fetch real data from the backend before first render
document.addEventListener('DOMContentLoaded', async () => {
  // Always start at Login Dashboard when index.html is opened
  AppState.user = null;
  localStorage.removeItem('esetu_user');
  AppState.syncQueue = loadSyncQueue();

  const loadingEl = document.getElementById('appContent');
  if (loadingEl) loadingEl.innerHTML = '<div style="text-align:center; padding:60px 20px; font-size:15px; color:var(--text-muted);">Loading EcoScrap AI…</div>';

  try {
    const data = await API.bootstrap();
    Object.assign(ESETU_DATA, data);
    AppState.isOffline = false;
    try { localStorage.setItem(OFFLINE_SNAPSHOT_KEY, JSON.stringify(data)); } catch {} // best-effort; ignore quota errors
    flushSyncQueue();
  } catch (err) {
    // Offline Mode: fall back to the last successfully synced snapshot instead of hard-failing.
    let snapshot = null;
    try { snapshot = JSON.parse(localStorage.getItem(OFFLINE_SNAPSHOT_KEY) || 'null'); } catch {}

    if (snapshot) {
      Object.assign(ESETU_DATA, snapshot);
      AppState.isOffline = true;
    } else {
      if (loadingEl) loadingEl.innerHTML = `<div style="text-align:center; padding:60px 20px; color:var(--danger);">Could not reach the server. Is it running? (${err.message})</div>`;
      return;
    }
  }

  AppState.selectedMaterial = ESETU_DATA.materials[0];
  setupEventListeners();
  renderApp();
});

// Setup Global Event Listeners
function setupEventListeners() {
  // 7-Language selector buttons
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const lang = e.target.dataset.lang;
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      I18N.setLanguage(lang);
      renderApp();
    });
  });
}

// Render Top-Level App View
function renderApp() {
  const container = document.getElementById('appContent');
  const statusBar = document.getElementById('userStatusBar');

  // Update Brand Tagline in selected language
  const brandTagline = document.getElementById('brandTagline');
  if (brandTagline) brandTagline.textContent = I18N.t('tagline');

  // Footer chrome lives outside #appContent (it's part of index.html, not re-rendered per
  // tab-switch), so it needs its own explicit language update here.
  const footerCompliance = document.getElementById('footerComplianceText');
  if (footerCompliance) footerCompliance.textContent = I18N.t('footerComplianceText');
  const footerAskBtn = document.getElementById('footerAskBtnLabel');
  if (footerAskBtn) footerAskBtn.textContent = I18N.t('assistantTitle');
  const footerHotspotBtn = document.getElementById('footerHotspotBtnLabel');
  if (footerHotspotBtn) footerHotspotBtn.textContent = I18N.t('hotspotMapBtn').replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '');
  renderRateTicker();
  document.documentElement.lang = I18N.currentLang || 'en';
  const footerSafetyBtn = document.getElementById('footerSafetyBtnLabel');
  if (footerSafetyBtn) footerSafetyBtn.textContent = I18N.t('footerSafetyBtnLabel');

  // Sync active language button
  document.querySelectorAll('.lang-btn').forEach(b => {
    if (b.dataset.lang === I18N.currentLang) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });

  renderOfflineBanner();

  if (!AppState.user) {
    if (statusBar) statusBar.style.display = 'none';
    renderLoginPage(container);
    return;
  }

  if (statusBar) statusBar.style.display = 'flex';
  updateStatusBar();

  switch (AppState.user.role) {
    case 'customer':
      renderCustomerPage(container);
      break;
    case 'kabadiwala':
      renderKabadiwalaPage(container);
      break;
    case 'recycler':
      renderRecyclerPage(container);
      break;
    default:
      renderLoginPage(container);
  }
}

// Offline Mode banner — a persistent DOM node outside #appContent so it survives every
// tab-switch re-render. Shown whenever the app is running off the cached bootstrap
// snapshot, or the browser itself reports no connectivity, and whenever writes are
// waiting in the sync queue for reconnection.
function renderOfflineBanner() {
  let el = document.getElementById('offlineBanner');
  const showOffline = AppState.isOffline || !navigator.onLine;
  const queuedCount = AppState.syncQueue.length;

  if (!showOffline && !queuedCount) {
    if (el) el.remove();
    return;
  }

  if (!el) {
    el = document.createElement('div');
    el.id = 'offlineBanner';
    el.style.cssText = 'position:sticky; top:0; z-index:500; background:var(--accent-ink); color:var(--accent-light); text-align:center; padding:6px 12px; font-size:12.5px; font-weight:700;';
    document.body.insertBefore(el, document.body.firstChild);
  }

  el.textContent = showOffline
    ? `📴 ${I18N.t('offlineModeBanner')}${queuedCount ? ` — ${queuedCount} ${I18N.t('queuedWritesLabel')}` : ''}`
    : `⏳ ${queuedCount} ${I18N.t('queuedWritesLabel')}`;
}

// Update Status Bar
function updateStatusBar() {
  const roleNameEl = document.getElementById('userRoleName');
  const userDetailsEl = document.getElementById('userDetails');
  const logoutBtnLabel = document.getElementById('logoutBtnLabel');
  if (!roleNameEl || !AppState.user) return;

  const roleTitles = {
    customer: I18N.t('roleCustomer'),
    kabadiwala: I18N.t('roleKabadiwala'),
    recycler: I18N.t('roleRecycler')
  };

  roleNameEl.textContent = roleTitles[AppState.user.role];
  userDetailsEl.textContent = `${AppState.user.name || 'User'} (${AppState.user.phone || ''})`;
  if (logoutBtnLabel) logoutBtnLabel.textContent = I18N.t('logoutBtn');
}

// -------------------------------------------------------------
// STEP 1: SECURE LOGIN PORTAL (NO PUBLIC WHOLESALE TICKER!)
// -------------------------------------------------------------
function renderLoginPage(container) {
  let selectedRole = 'customer';
  let kabadiMode = 'login'; // 'login' | 'register'

  markView('login');

  // Left-hand pitch: today's public doorstep rates on a "rate slip", how a pickup works,
  // and live counts straight from the bootstrap data (nothing hard-coded).
  function pitchHtml() {
    const slipRows = (ESETU_DATA.materials || []).slice(0, 5).map(m => {
      const diff = m.customerRate - customerPrevRate(m);
      return `
        <div class="rate-slip-row">
          <span>${m.icon}</span>
          <span class="nm">${getLocalizedMatName(m).split('(')[0]}</span>
          <span class="rt">₹${m.customerRate}</span>
          <span class="ch ${diff >= 0 ? 'txt-up' : 'txt-down'}">${diff >= 0 ? '+' : '−'}${Math.abs(diff)}</span>
        </div>`;
    }).join('');
    const dealers = (ESETU_DATA.kabadiwalas || []).length;
    const recyclers = (ESETU_DATA.recyclers || []).length;
    return `
      <section class="pitch">
        <p class="eyebrow">${I18N.t('heroEyebrow')}</p>
        <h2>${I18N.t('heroHeadline')}</h2>
        <p>${I18N.t('heroSub')}</p>

        <div class="rate-slip" aria-label="${I18N.t('rateSlipTitle')}">
          <div class="rate-slip-head"><span>${I18N.t('rateSlipTitle')}</span><span>₹ / kg</span></div>
          ${slipRows}
        </div>

        <ol class="steps">
          <li><span class="n">1</span><div><strong>${I18N.t('heroStep1Title')}</strong><span>${I18N.t('heroStep1Body')}</span></div></li>
          <li><span class="n">2</span><div><strong>${I18N.t('heroStep2Title')}</strong><span>${I18N.t('heroStep2Body')}</span></div></li>
          <li><span class="n">3</span><div><strong>${I18N.t('heroStep3Title')}</strong><span>${I18N.t('heroStep3Body')}</span></div></li>
        </ol>

        <div class="pitch-stats">
          <div><b>${dealers}</b><span>${I18N.t('statDealers')}</span></div>
          <div><b>${recyclers}</b><span>${I18N.t('statRecyclers')}</span></div>
          <div><b>${(ESETU_DATA.materials || []).length}</b><span>${I18N.t('statMaterials')}</span></div>
          <div><b>7</b><span>${I18N.t('statLanguages')}</span></div>
        </div>
      </section>`;
  }

  function updateFormHtml() {
    return `
      <div class="login-split">
      ${pitchHtml()}
      <div class="card login-card">
        <div class="card-header">
          <div>
            <h2 class="card-title">${I18N.t('loginTitle')}</h2>
            <p class="card-subtitle">${I18N.t('loginSubtitle')}</p>
          </div>
          <button class="audio-btn" onclick="I18N.speak('${I18N.t('loginTitle')}. ${I18N.t('loginSubtitle')}')">
            ${I18N.t('speakBtn')}
          </button>
        </div>

        <!-- 3-Role Selection Cards -->
        <div class="role-cards-grid">
          <!-- Customer Role -->
          <div class="role-card ${selectedRole === 'customer' ? 'selected' : ''}" id="roleCard-customer" onclick="selectRole('customer')">
            <div class="role-card-icon">${UI_ICONS.home}</div>
            <div class="role-card-content">
              <h3>${I18N.t('roleCustomer')}</h3>
              <p>${I18N.t('roleCustomerDesc')}</p>
            </div>
          </div>

          <!-- Kabadiwala Role (Restricted Access) -->
          <div class="role-card ${selectedRole === 'kabadiwala' ? 'selected' : ''}" id="roleCard-kabadiwala" onclick="selectRole('kabadiwala')">
            <div class="role-card-icon">${UI_ICONS.cart}</div>
            <div class="role-card-content">
              <h3>${I18N.t('roleKabadiwala')}</h3>
              <p>${I18N.t('roleKabadiwalaDesc')}</p>
            </div>
          </div>

          <!-- Recycler Role (Strict Govt Reg Guard) -->
          <div class="role-card ${selectedRole === 'recycler' ? 'selected' : ''}" id="roleCard-recycler" onclick="selectRole('recycler')">
            <div class="role-card-icon">${UI_ICONS.factory}</div>
            <div class="role-card-content">
              <h3>${I18N.t('roleRecycler')}</h3>
              <p>${I18N.t('roleRecyclerDesc')}</p>
            </div>
          </div>
        </div>

        <!-- Kabadiwala Mode Toggle (Login vs Register) -->
        ${selectedRole === 'kabadiwala' ? `
          <div class="mode-toggle">
            <button class="${kabadiMode === 'login' ? 'on' : ''}" onclick="setKabadiMode('login')">${I18N.t('kabadiSignInModeLabel')}</button>
            <button class="${kabadiMode === 'register' ? 'on' : ''}" onclick="setKabadiMode('register')">${I18N.t('kabadiRegisterModeLabel')}</button>
          </div>
        ` : ''}

        <!-- Form Fields Container -->
        <div id="loginFormFields">
          <!-- Role 1: Customer Simple Mobile Login -->
          ${selectedRole === 'customer' ? `
            <div class="desktop-grid-2">
              <div class="form-group">
                <label class="form-label">${I18N.t('nameLabel')}</label>
                <input type="text" id="loginName" class="form-input" placeholder="${I18N.t('namePlaceholder')}" autocomplete="off">
              </div>
              <div class="form-group">
                <label class="form-label">${I18N.t('phoneLabel')}</label>
                <input type="tel" id="loginPhone" class="form-input" placeholder="${I18N.t('phonePlaceholder')}" autocomplete="off">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">${I18N.t('pincodeLabel')}</label>
              <input type="text" id="loginLocation" class="form-input" placeholder="${I18N.t('pincodePlaceholder')}" autocomplete="off">
            </div>
          ` : ''}

          <!-- Role 2: Kabadiwala Predefined Authorized Access -->
          ${selectedRole === 'kabadiwala' ? (kabadiMode === 'login' ? `
            <div class="panel-soft">
              <div class="panel-soft-title">${I18N.t('kabadiAuthCardTitle')}</div>
              <p>${I18N.t('kabadiAuthCardBody')}</p>
              <div class="desktop-grid-2">
                <div class="form-group" style="margin-bottom:0;">
                  <label class="form-label">${I18N.t('phoneLabel')}</label>
                  <input type="tel" id="loginPhone" class="form-input" placeholder="${I18N.t('phonePlaceholder')}" autocomplete="off">
                </div>
                <div class="form-group" style="margin-bottom:0;">
                  <label class="form-label">${I18N.t('kabadiPinLabel')}</label>
                  <input type="password" id="loginKabadiPin" class="form-input" placeholder="${I18N.t('kabadiPinPlaceholder')}" maxlength="6" autocomplete="off">
                </div>
              </div>
            </div>
          ` : `
            <!-- Kabadiwala Registration -->
            <div class="desktop-grid-2">
              <div class="form-group">
                <label class="form-label">${I18N.t('nameLabel')}</label>
                <input type="text" id="loginName" class="form-input" placeholder="${I18N.t('namePlaceholder')}" autocomplete="off">
              </div>
              <div class="form-group">
                <label class="form-label">${I18N.t('phoneLabel')}</label>
                <input type="tel" id="loginPhone" class="form-input" placeholder="${I18N.t('phonePlaceholder')}" autocomplete="off">
              </div>
            </div>
            <div class="desktop-grid-2">
              <div class="form-group">
                <label class="form-label">${I18N.t('godownLabel')}</label>
                <input type="text" id="regGodownName" class="form-input" placeholder="${I18N.t('godownPlaceholder')}" autocomplete="off">
              </div>
              <div class="form-group">
                <label class="form-label">${I18N.t('vehicleTypeLabel')}</label>
                <select id="regVehicleType" class="form-input">
                  <option value="Bolero Pickup">${I18N.t('vehicleBoleroOpt')}</option>
                  <option value="Tata Ace">${I18N.t('vehicleTataAceOpt')}</option>
                  <option value="E-Loader">${I18N.t('vehicleELoaderOpt')}</option>
                  <option value="Handcart">${I18N.t('vehicleHandcartOpt')}</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">${I18N.t('pincodeLabel')}</label>
              <input type="text" id="loginLocation" class="form-input" placeholder="${I18N.t('pincodePlaceholder')}" autocomplete="off">
            </div>
            <div style="background: var(--primary-light); border: 1.5px solid var(--primary-line); padding: 12px; border-radius: var(--radius-sm); margin-bottom: 14px; font-size: 13px; color: var(--primary-dark);">
              <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" id="regDigitalScale" checked style="width: 18px; height: 18px;">
                <strong>${I18N.t('digitalScaleLabel')}</strong>
              </label>
            </div>
          `) : ''}

          <!-- Role 3: Recycler CPCB Registration (self-service: first login = real registration) -->
          ${selectedRole === 'recycler' ? `
            <div style="background: var(--info-light); padding: 18px; border-radius: var(--radius-sm); border: 2px solid var(--info); margin-bottom: 16px;">
              <label class="form-label" style="color: var(--info); margin-bottom: 10px; font-size: 14px; display: block;">
                🛡️ ${I18N.t('govRegLabel')}
              </label>
              <input type="text" id="loginGovReg" class="form-input" style="font-weight: 800; color: var(--info); text-transform: uppercase;" placeholder="${I18N.t('govRegPlaceholder')}" autocomplete="off">
              <p class="form-help" style="color: var(--info); margin-top: 6px;">
                ${I18N.t('govRegFirstTimeHelp')}
              </p>
              <div class="desktop-grid-2" style="margin-top: 12px;">
                <div>
                  <label class="form-label" style="color:var(--info); font-size:12.5px;">${I18N.t('recyclerFacilityNameLabel')}</label>
                  <input type="text" id="loginName" class="form-input" placeholder="${I18N.t('recyclerFacilityNamePlaceholder')}" autocomplete="off">
                </div>
                <div>
                  <label class="form-label" style="color:var(--info); font-size:12.5px;">${I18N.t('plantPhoneLabel')}</label>
                  <input type="tel" id="loginPhone" class="form-input" placeholder="${I18N.t('phonePlaceholder')}">
                </div>
              </div>
            </div>
          ` : ''}
        </div>

        <button class="btn-primary" onclick="handleLoginSubmit()">
          ${selectedRole === 'kabadiwala' && kabadiMode === 'register' ? I18N.t('registerBtn') : I18N.t('loginBtn')}
        </button>
      </div>
      </div>

      <!-- Security Rejection Modal Container -->
      <div id="loginErrorModalContainer"></div>
    `;
  }

  container.innerHTML = updateFormHtml();

  // Role selection helper
  window.selectRole = (role) => {
    selectedRole = role;
    markView('login');
    container.innerHTML = updateFormHtml();
  };

  // Kabadiwala mode toggle
  window.setKabadiMode = (mode) => {
    kabadiMode = mode;
    markView('login');
    container.innerHTML = updateFormHtml();
  };

  // Submit handler — now talks to the real backend instead of scanning in-memory arrays
  window.handleLoginSubmit = async () => {
    const nameEl = document.getElementById('loginName');
    const phoneEl = document.getElementById('loginPhone');
    const locEl = document.getElementById('loginLocation');
    const name = nameEl ? nameEl.value.trim() : 'User';
    const phone = phoneEl ? phoneEl.value.trim() : '9820000000';
    const location = locEl ? locEl.value.trim() : 'Pune';

    // 1. RECYCLER ACCESS (self-service: first login with a new CPCB number registers it for real)
    if (selectedRole === 'recycler') {
      const govRegInput = document.getElementById('loginGovReg');
      const govRegNo = govRegInput ? govRegInput.value.trim().toUpperCase() : '';

      try {
        const coords = await getBrowserCoordinates();
        const recycler = await API.recyclerLogin({ govRegNo, name, phone, location, ...(coords || {}) });

        // Refresh the shared cache so a newly registered recycler shows up everywhere.
        const fresh = await API.bootstrap();
        Object.assign(ESETU_DATA, fresh);

        AppState.user = recycler;
        localStorage.setItem('esetu_user', JSON.stringify(AppState.user));
        renderApp();
      } catch (err) {
        alert(`❌ ${err.message}`);
      }
      return;
    }

    // 2. KABADIWALA PREDEFINED ACCESS GUARD (validated server-side against the kabadiwalas table)
    if (selectedRole === 'kabadiwala') {
      if (kabadiMode === 'login') {
        const pinInput = document.getElementById('loginKabadiPin');
        const pin = pinInput ? pinInput.value.trim() : '';

        try {
          const dealer = await API.kabadiwalaLogin(phone, pin);
          AppState.user = { role: 'kabadiwala', name: dealer.name, phone: dealer.phone, location: dealer.location, yard: dealer.yard, kabadiId: dealer.kabadiId };
          localStorage.setItem('esetu_user', JSON.stringify(AppState.user));
          // Reuse the coordinates captured at this dealer's original registration (Phase 0)
          // rather than re-prompting for location permission on every login.
          const ownRecord = ESETU_DATA.kabadiwalas.find(k => k.phone === dealer.phone);
          if (ownRecord && typeof ownRecord.latitude === 'number') {
            AppState.myCoords = { latitude: ownRecord.latitude, longitude: ownRecord.longitude };
          }
          renderApp();
        } catch (err) {
          showKabadiAuthErrorModal(phone);
        }
        return;
      } else {
        // Register new Kabadiwala — a real row is written to the database
        const godownName = document.getElementById('regGodownName') ? document.getElementById('regGodownName').value.trim() : 'My Scrap Yard';
        const vehicleType = document.getElementById('regVehicleType') ? document.getElementById('regVehicleType').value : 'Tata Ace';

        try {
          const coords = await getBrowserCoordinates();
          const dealer = await API.kabadiwalaRegister({ name, phone, yard: godownName, vehicleType, location, ...(coords || {}) });

          // Refresh the shared cache so the new dealer shows up everywhere (nearby-dealers list, etc.)
          const fresh = await API.bootstrap();
          Object.assign(ESETU_DATA, fresh);

          const smsNote = dealer.sms && dealer.sms.sent
            ? `\n${I18N.tf('priceSmsSentNote', { phone })}`
            : `\n${I18N.tf('priceSmsNotSentNote', { reason: dealer.sms ? dealer.sms.reason : I18N.t('unknownReasonLabel') })}`;
          alert(`🎉 ${I18N.tf('registrationApprovedMsg', { name, kabadiId: dealer.kabadiId })}${smsNote}`);
          AppState.user = { role: 'kabadiwala', name: dealer.name, phone: dealer.phone, location: dealer.location, yard: dealer.yard, kabadiId: dealer.kabadiId };
          localStorage.setItem('esetu_user', JSON.stringify(AppState.user));
          if (coords) AppState.myCoords = coords;
          renderApp();
        } catch (err) {
          alert(`❌ ${I18N.tf('registrationFailedMsg', { error: err.message })}`);
        }
        return;
      }
    }

    // 3. CUSTOMER FREE ACCESS
    AppState.user = {
      role: 'customer',
      name: name,
      phone: phone,
      location: location
    };
    localStorage.setItem('esetu_user', JSON.stringify(AppState.user));
    renderApp();

    // Real GPS for Smart Recycler Matching / nearest-dealer answers — resolves in the
    // background; a denied/unavailable permission just means distance-based features
    // fall back gracefully (see renderKabadiwalaWarehouseTab-equivalent for customers).
    getBrowserCoordinates().then((coords) => { AppState.myCoords = coords; });
  };

  // Rejection Modal for a real registered dealer entering the wrong phone/PIN
  window.showKabadiAuthErrorModal = (phone) => {
    const modalContainer = document.getElementById('loginErrorModalContainer');
    if (!modalContainer) return;

    modalContainer.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-content" style="border-top: 6px solid var(--accent); max-width: 440px; text-align: center;">
          <div style="font-size: 44px; margin-bottom: 8px;">🔒</div>
          <h3 style="font-size: 18px; font-weight: 900; color: var(--accent-ink); margin-bottom: 8px;">
            ${I18N.t('dealerAuthFailedTitle')}
          </h3>
          <div style="background: var(--accent-light); border: 1.5px solid #ecc98a; padding: 14px; border-radius: var(--radius-sm); font-size: 13px; color: var(--accent-ink); text-align: left; margin: 14px 0;">
            <p><strong>${I18N.t('phoneLabel')}</strong> <code>${phone}</code></p>
            <p style="margin-top: 6px;">
              ${I18N.t('kabadiAuthError')}
            </p>
          </div>
          <button class="btn-secondary" onclick="document.getElementById('loginErrorModalContainer').innerHTML=''">
            ${I18N.t('closeBtnLabel')}
          </button>
        </div>
      </div>
    `;
    I18N.speak(I18N.t('kabadiAuthError'));
  };
}

// -------------------------------------------------------------
// STEP 2: CUSTOMER PAGE (3 COMPACT SUB-PAGES & LIVE ETA TRACKING)
// Sub-Page 1: Sell Scrap & Fair Pricing Calculator
// Sub-Page 2: Nearby Kabadiwalas, Google Maps Location & Live ETA
// Sub-Page 3: Customer Profile, Sales History & Scrap Dealer Comparison
// -------------------------------------------------------------
function renderCustomerPage(container) {
  renderOfflineBanner();
  if (!AppState.customerTab) AppState.customerTab = 'sell';
  if (!AppState.trackedKabadiwala) AppState.trackedKabadiwala = ESETU_DATA.kabadiwalas[0] || null;

  markView(`customer:${AppState.customerTab}`);
  const tabNavHtml = renderTabbar([
    { key: 'sell', label: I18N.t('sellTabLabel'), icon: 'sell' },
    { key: 'dealers', label: I18N.t('dealersTabLabel'), icon: 'pin' },
    { key: 'profile', label: I18N.t('custProfileTabLabel'), icon: 'user' }
  ], AppState.customerTab, 'setCustomerTab');

  if (AppState.customerTab === 'sell') {
    renderCustomerSellTab(container, tabNavHtml);
    YoloScrap.warmUp(); // fetch the on-device scanner model before the first photo
  } else if (AppState.customerTab === 'dealers') {
    renderCustomerDealersTab(container, tabNavHtml);
  } else {
    renderCustomerProfileTab(container, tabNavHtml);
  }
}

window.setCustomerTab = (tabName) => {
  AppState.customerTab = tabName;
  const container = document.getElementById('appContent');
  renderCustomerPage(container);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (tabName === 'profile' && !AppState.customerProfileData) {
    refreshCustomerProfileData();
  }
  if (tabName === 'dealers' && AppState.nextCollectionDay === undefined) {
    loadNextCollectionDay();
  }
};

// Smart Collection Day (customer side) — looks up whether any dealer has set a recurring
// collection day for this customer's pincode.
async function loadNextCollectionDay() {
  AppState.nextCollectionDay = null; // mark "checked" so we don't refetch every render
  const pincodeMatch = (AppState.user.location || '').match(/\d{6}/);
  if (!pincodeMatch) return;
  try {
    const schedules = await API.listCollectionSchedules({ pincode: pincodeMatch[0] });
    if (schedules.length) {
      AppState.nextCollectionDay = schedules[0];
      renderCustomerPage(document.getElementById('appContent'));
    }
  } catch {}
}

async function refreshCustomerProfileData() {
  try {
    const data = await API.getCustomerSummary(AppState.user.phone);
    AppState.customerProfileData = data;
  } catch (err) {
    AppState.customerProfileData = { summary: ESETU_DATA.customerSalesSummary, monthlyComparison: [], history: [], error: err.message };
  }
  if (AppState.customerTab === 'profile') {
    renderCustomerPage(document.getElementById('appContent'));
  }
}

// -------------------------------------------------------------
// SUB-PAGE 1: SELL SCRAP & COMPACT CALCULATOR
// -------------------------------------------------------------
function renderCustomerSellTab(container, tabNavHtml) {
  const currentMat = AppState.selectedMaterial;
  const weightKg = Number(AppState.calculatorWeight) || 0.2;
  const weightGrams = Math.round(weightKg * 1000);
  const scan = AppState.aiScanResult;
  const qualityMultiplier = (scan && scan.material.id === currentMat.id) ? scan.qualityMultiplier : 1.0;
  const currentPayout = (weightKg * currentMat.customerRate * qualityMultiplier).toFixed(0);
  const weightDisplayHtml = weightKg < 1 
    ? `<strong style="color: var(--primary); font-size: 26px;">${weightGrams}g</strong> <span style="font-size:13.5px; color:var(--text-muted); font-weight:700;">(${weightKg.toFixed(2)} kg)</span>`
    : `<strong style="color: var(--primary); font-size: 26px;">${weightKg} kg</strong> <span style="font-size:13.5px; color:var(--text-muted); font-weight:700;">(${weightGrams}g)</span>`;

  // Compact 6-hr comparisons
  const compRowsHtml = ESETU_DATA.materials.map(m => {
    const diff = m.customerRate - customerPrevRate(m);
    const diffText = diff >= 0 ? `+₹${diff} ▲` : `-₹${Math.abs(diff)} ▼`;
    const cls = diff >= 0 ? 'up' : 'down';
    const isSelected = m.id === currentMat.id;
    return `
      <div class="comparison-row" style="padding: 7px 10px; cursor: pointer; ${isSelected ? 'background: var(--primary-light); border-left: 3px solid var(--primary);' : ''}" onclick="selectCustomerMaterial('${m.id}')">
        <div class="comp-mat" style="font-size: 13px;">
          <span>${m.icon}</span>
          <span style="font-weight: 700;">${getLocalizedMatName(m).split('(')[0]}</span>
        </div>
        <div class="comp-prices" style="font-size: 12.5px;">
          <span class="old-rate" style="font-size: 11px;">₹${customerPrevRate(m)}</span>
          <strong class="new-rate">₹${m.customerRate}/kg</strong>
          <span class="trend-badge ${cls}" style="font-size: 10.5px; padding: 2px 6px;">${diffText}</span>
          <button class="hist-btn" onclick="event.stopPropagation(); openPriceHistory('${m.id}')" title="${I18N.t('priceHistoryTitle')}" aria-label="${I18N.t('priceHistoryTitle')}">
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M1 13 L5 8 L8 10 L15 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Material selection chips (compact)
  const matChipsHtml = ESETU_DATA.materials.map(m => `
    <button class="btn-secondary ${m.id === currentMat.id ? 'btn-primary' : ''}" 
            style="padding: 6px 11px; font-size: 12px; margin: 3px; font-weight: 700;"
            onclick="selectCustomerMaterial('${m.id}')">
      ${m.icon} ${m.symbol} (₹${m.customerRate}/kg)
    </button>
  `).join('');

  container.innerHTML = `
    ${tabNavHtml}

    <div class="page-band">
      <div>
        <p class="eyebrow">${I18N.tf('helloName', { name: AppState.user.name || '' })}</p>
        <h2>${I18N.t('custTitle')}</h2>
        <p>${I18N.t('custSubtitle')}</p>
      </div>
      <button class="audio-btn" onclick="I18N.speak('${I18N.t('custTitle')}. ${I18N.t('custSubtitle')}')">
        ${I18N.t('speakBtn')}
      </button>
    </div>

    <!-- Active Booking Alert (with 1-tap live ETA map link) -->
    ${AppState.activeBookingNotice ? `
      <div style="background: var(--primary-light); border: 1.5px solid var(--success); padding: 10px 14px; border-radius: var(--radius-sm); margin-bottom: 14px; font-size: 13px; color: var(--primary-dark); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <div>${AppState.activeBookingNotice}</div>
        <button class="btn-primary" style="padding: 6px 12px; font-size: 12px; width: auto;" onclick="setCustomerTab('dealers')">
          🛵 ${I18N.t('viewLiveEtaBtn')}
        </button>
      </div>
    ` : ''}

    <!-- Compact 2-Column Grid -->
    <div class="desktop-grid-2" style="gap: 14px;">
      
      <!-- Left Column: Price Comparison & AI Photo Classifier -->
      <div>
        <div class="comparison-box" style="padding: 14px; margin-bottom: 14px;">
          <div class="card-header" style="margin-bottom: 8px;">
            <div class="card-title" style="font-size: 14px;">
              ${I18N.t('compareBoxTitle')}
            </div>
            <span style="font-size: 11px; background: var(--primary-light); color: var(--primary); padding: 2px 7px; border-radius: 4px; font-weight: 800;">
              ● ${I18N.t('liveDoorstepRatesBadge')}
            </span>
          </div>
          <div class="comparison-grid">
            ${compRowsHtml}
          </div>
          <p style="font-size: 11px; color: var(--text-muted); margin-top: 8px; text-align: right;">
            *${I18N.t('cpcbFloorNotice')}
          </p>
        </div>

        <!-- Scrap Photo Capture Card -->
        <div class="card" style="padding: 14px; margin-bottom: 0;">
          <div class="card-header" style="margin-bottom: 6px;">
            <div>
              <h4 class="card-title" style="font-size: 14.5px;">${I18N.t('scrapCaptureTitle')}</h4>
              <p class="card-subtitle" style="font-size: 11.5px;">${I18N.t('scrapCaptureSubtitle')}</p>
            </div>
            <button class="audio-btn" style="font-size: 11px; padding: 3px 8px;" onclick="I18N.speak('${I18N.t('scrapCaptureTitle')}')">
              ${I18N.t('speakBtn')}
            </button>
          </div>

          <div class="capture-box" style="padding: 18px 12px;" onclick="ScrapScanner.open()">
            <div style="font-size: 32px;">📸</div>
            <div style="font-weight: 800; font-size: 14px; margin-top: 4px;">
              ${I18N.t('takePhotoBtn')}
            </div>
            <p style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">
              ${I18N.t('captureHint')}
            </p>
          </div>
          <!-- Fallbacks when in-page camera isn't available: capture= opens the phone's camera app -->
          <input type="file" id="cameraInput" accept="image/*" capture="environment" hidden onchange="ScrapScanner.onFileChosen(event)">
          <input type="file" id="galleryInput" accept="image/*" hidden onchange="ScrapScanner.onFileChosen(event)">

          ${ScrapScanner.cardHtml()}
        </div>
      </div>

      <!-- Right Column: Weight Estimator & Instant Cash Calculation -->
      <div>
        <div class="card calc-container" style="padding: 16px; margin-bottom: 0;">
          <div class="card-header" style="margin-bottom: 6px;">
            <div>
              <h4 class="card-title" style="color: var(--primary-dark); font-size: 15px;">${I18N.t('calcBoxTitle')}</h4>
              <p class="card-subtitle" style="font-size: 11.5px;">${I18N.t('chooseScrapTypeSubtitle')}</p>
            </div>
            <button class="audio-btn" style="font-size: 11px; padding: 3px 8px;" onclick="speakCurrentValuation()">
              ${I18N.t('speakBtn')}
            </button>
          </div>

          <!-- Material Picker Chips (Compact) -->
          <div style="margin: 6px 0 10px 0;">
            ${matChipsHtml}
          </div>

          <!-- Voice Selling: speak the material and weight instead of tapping -->
          <button id="voiceSellBtn" class="btn-secondary" style="width: 100%; padding: 7px; font-size: 12px; font-weight: 700; border-color: var(--plum); color: var(--plum); margin-bottom: 6px;" onclick="startVoiceSelling()">
            🎙️ ${I18N.t('voiceSellBtn')}
          </button>
          <div id="voiceSellStatus" style="font-size: 11px; color: var(--text-muted); text-align: center; margin-bottom: 6px; min-height: 14px;"></div>

          <!-- Stepper Controls (Supporting 100g+ micro-weights) -->
          <div style="text-align: center; margin-top: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; flex-wrap: wrap; gap: 6px;">
              <span style="font-size: 12.5px; font-weight: 700; color: var(--primary-dark);">${I18N.t('weightLabel')}</span>
              <span style="font-size: 11px; background: var(--primary-light); color: var(--primary-dark); font-weight: 800; padding: 2px 8px; border-radius: 4px;">
                ⚡ ${I18N.t('microWeightsAcceptedBadge')}
              </span>
            </div>

            <div id="smartScaleWidget" style="margin-bottom: 8px;">
              ${AppState.scaleReading ? `
                <div style="text-align:center; font-size:12px; font-weight:700; color:var(--primary-dark); padding:7px; background:var(--primary-light); border:1px solid var(--primary-line); border-radius:6px;">
                  ⚖️ ${I18N.t('scaleSyncedLabel')} ${Math.round(AppState.scaleReading.weightKg * 1000)}g
                </div>
              ` : `
                <button class="btn-secondary" style="width: 100%; padding: 7px; font-size: 12px; font-weight: 700; border-color: var(--info); color: var(--info);" onclick="connectSmartScale()">
                  ⚖️ ${I18N.t('connectScaleBtn')}
                </button>
              `}
            </div>

            <div class="stepper-control" style="margin: 6px auto; display: flex; align-items: center; justify-content: center; gap: 8px;">
              <button class="step-btn" style="font-size: 12.5px; font-weight: 800; min-width: 62px; height: 38px;" onclick="adjustWeight(-0.1)" title="${I18N.t('minus100gTitle')}">-100g</button>
              <div class="weight-display" style="min-width: 175px;">
                ${weightDisplayHtml}
              </div>
              <button class="step-btn" style="font-size: 12.5px; font-weight: 800; min-width: 62px; height: 38px;" onclick="adjustWeight(0.1)" title="${I18N.t('plus100gTitle')}">+100g</button>
            </div>

            <!-- Quick Presets in Grams & KG -->
            <div style="display: flex; justify-content: center; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
              <button class="btn-secondary ${AppState.calculatorWeight === 0.1 ? 'btn-primary' : ''}" style="padding: 4px 9px; font-size: 11.5px; font-weight: 800;" onclick="setWeight(0.1)">100g</button>
              <button class="btn-secondary ${AppState.calculatorWeight === 0.2 ? 'btn-primary' : ''}" style="padding: 4px 9px; font-size: 11.5px; font-weight: 800;" onclick="setWeight(0.2)">200g</button>
              <button class="btn-secondary ${AppState.calculatorWeight === 0.5 ? 'btn-primary' : ''}" style="padding: 4px 9px; font-size: 11.5px; font-weight: 800;" onclick="setWeight(0.5)">500g</button>
              <button class="btn-secondary ${AppState.calculatorWeight === 1.0 ? 'btn-primary' : ''}" style="padding: 4px 9px; font-size: 11.5px; font-weight: 800;" onclick="setWeight(1.0)">1 kg</button>
              <button class="btn-secondary ${AppState.calculatorWeight === 2.0 ? 'btn-primary' : ''}" style="padding: 4px 9px; font-size: 11.5px; font-weight: 800;" onclick="setWeight(2.0)">2 kg</button>
              <button class="btn-secondary ${AppState.calculatorWeight === 5.0 ? 'btn-primary' : ''}" style="padding: 4px 9px; font-size: 11.5px; font-weight: 800;" onclick="setWeight(5.0)">5 kg</button>
            </div>
          </div>

          <!-- Total Payout Box -->
          <div class="total-payout-box" style="padding: 12px; margin: 12px 0;">
            <div style="font-size: 12px; font-weight: 700; color: var(--text-muted);">${I18N.t('exactPayoutLabel')}</div>
            <div class="payout-amount" style="font-size: 32px; font-weight: 900; color: var(--primary);">₹${Number(currentPayout).toLocaleString('en-IN')}</div>
            <div style="font-size: 11.5px; color: var(--primary-dark); margin-top: 2px;">
              (${weightGrams} grams / ${weightKg} kg × ₹${currentMat.customerRate}/${currentMat.unit}${qualityMultiplier !== 1.0 ? ` × ${qualityMultiplier}x ${I18N.t('qualityGradeLabel')} ${scan.grade}` : ''})
            </div>
          </div>

          <!-- Payment Methods Selection -->
          <div style="margin-top: 10px;">
            <label class="form-label" style="font-size: 12px; font-weight: 700; margin-bottom: 6px;">${I18N.t('paymentMethodsTitle')}</label>
            <div class="payment-chips" style="gap: 8px;">
              <div class="pay-chip selected" id="payMode-cash" style="padding: 8px 10px; font-size: 12px;" onclick="selectPaymentMode('cash')">
                <span style="font-size:16px;">💵</span>
                <div><strong>${I18N.t('payCashDoorstep')}</strong></div>
              </div>
              <div class="pay-chip" id="payMode-upi" style="padding: 8px 10px; font-size: 12px;" onclick="selectPaymentMode('upi')">
                <span style="font-size:16px;">📱</span>
                <div><strong>${I18N.t('payUpi')}</strong></div>
              </div>
              <div class="pay-chip" id="payMode-bank" style="padding: 8px 10px; font-size: 12px;" onclick="selectPaymentMode('bank')">
                <span style="font-size:16px;">🏦</span>
                <div><strong>${I18N.t('payBank')}</strong></div>
              </div>
            </div>
          </div>

          <!-- Direct Request & Live ETA Trigger -->
          <button class="btn-primary" style="padding: 12px; font-size: 14.5px; font-weight: 800; width: 100%; margin-top: 14px;" onclick="bookPickupFromCalculator()">
            🛵 ${I18N.t('requestPickupBtn')}
          </button>
        </div>
      </div>

    </div>
  `;
}

// -------------------------------------------------------------
// SUB-PAGE 2: NEARBY KABADIWALAS, MAP LINKS & LIVE ETA
// -------------------------------------------------------------
function renderCustomerDealersTab(container, tabNavHtml) {
  if (!ESETU_DATA.kabadiwalas.length) {
    container.innerHTML = `
      ${tabNavHtml}
      <div class="card" style="text-align: center; padding: 48px 24px;">
        <div style="font-size: 40px; margin-bottom: 10px;">📍</div>
        <h3 style="font-size: 16px; font-weight: 800; margin-bottom: 6px;">${I18N.t('noDealersInAreaTitle')}</h3>
        <p style="font-size: 13px; color: var(--text-muted);">${I18N.t('noDealersInAreaDesc')}</p>
      </div>
    `;
    return;
  }

  const tracked = AppState.trackedKabadiwala || ESETU_DATA.kabadiwalas[0];
  const payout = AppState.activeBooking
    ? Number(AppState.activeBooking.totalAmount).toFixed(0)
    : (AppState.calculatorWeight * AppState.selectedMaterial.customerRate).toFixed(0);

  // Delivery Partner live progress — a real elapsed-time calculation against the tracked
  // ETA (ticking every few seconds via the interval started below), replacing what used to
  // be a permanently-frozen 68% bar. Still a simulation (no real vehicle GPS feed exists),
  // but now an honestly-behaving one: it actually advances over the wait.
  if (!AppState.deliveryStartedAt) AppState.deliveryStartedAt = Date.now();
  const elapsedMinutes = (Date.now() - AppState.deliveryStartedAt) / 60000;
  const etaMinutes = Math.max(1, tracked.etaMinutes || 20);
  const progressPct = Math.min(97, Math.round(10 + (elapsedMinutes / etaMinutes) * 87));
  const stageLabel = progressPct >= 90 ? I18N.t('stageArriving') : (progressPct >= 30 ? I18N.t('stageEnRoute') : I18N.t('stageConfirmed'));
  startDeliveryProgressTicker();

  const kabadiwalasHtml = ESETU_DATA.kabadiwalas.map(k => {
    const isCurrentlyTracked = k.id === tracked.id;
    const reviewsHtml = k.reviews.map(r => `
      <div class="review-item" style="padding: 8px; font-size: 12px;">
        <div class="review-author">
          <span>👤 ${r.customer}</span>
          <span style="color: var(--accent-ink);">★ ${r.rating}</span>
        </div>
        <div class="review-text" style="font-size: 11.5px;">"${r.text}"</div>
      </div>
    `).join('');

    return `
      <div class="card" style="padding: 16px; margin-bottom: 14px; border-left: 5px solid ${isCurrentlyTracked ? 'var(--primary)' : 'var(--border)'};">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap;">
          <div style="display: flex; gap: 12px; align-items: center;">
            <div style="font-size: 38px; background: var(--surface-2); width: 62px; height: 62px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center;">
              ${k.photo}
            </div>
            <div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <h4 style="font-size: 16px; font-weight: 800; color: var(--text-main); margin: 0;">${k.name}</h4>
                <span style="background: var(--success-light); color: var(--primary-dark); font-size: 10.5px; font-weight: 800; padding: 2px 7px; border-radius: var(--radius-full);">
                  ${k.badge}
                </span>
              </div>
              <div style="font-size: 13px; font-weight: 700; color: var(--primary-dark); margin-top: 2px;">
                🏪 ${k.shopName}
              </div>
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                📍 ${k.location} • 📞 ${k.phone}
              </div>
            </div>
          </div>

          <div style="text-align: right;">
            <div style="font-size: 13px; font-weight: 800; color: var(--accent-ink);">★ ${k.rating} <span style="font-size:11px; color:var(--text-muted);">(${k.totalReviews} reviews)</span></div>
            <div style="margin-top: 4px;">
              <span style="background: var(--primary-light); color: var(--primary-dark); font-size: 11.5px; font-weight: 800; padding: 3px 8px; border-radius: 4px;">
                🛵 ETA ~${k.etaMinutes} mins (${k.etaDistanceKm} km)
              </span>
            </div>
          </div>
        </div>

        <!-- Deep Scrap Dealer Info & Certified Scales -->
        <div style="background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; margin: 10px 0; font-size: 12px; line-height: 1.5;">
          <div>📍 <strong>${I18N.t('addressLabel')}</strong> ${k.fullAddress}</div>
          <div style="margin-top: 3px;">⚖️ <strong>${I18N.t('weighingEquipmentLabel')}</strong> ${k.weighingEquipment}</div>
          <div style="margin-top: 3px;">⏰ <strong>${I18N.t('hoursLabel')}</strong> ${k.operatingHours} • 📜 <strong>${I18N.t('licenseLabel')}</strong> <code>${k.licenseNo}</code></div>
          <div style="margin-top: 3px; color: var(--text-muted);">📦 <strong>${I18N.t('acceptsLabel')}</strong> ${k.materialsAccepted}</div>
        </div>

        <!-- Action Links: Google Maps & Booking -->
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <!-- Location Link Opening Google Maps in New Tab -->
          <a href="${k.googleMapsUrl}" target="_blank" class="btn-secondary" style="flex: 1; min-width: 170px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; padding: 8px; text-decoration: none; border-color: var(--info); color: var(--info); font-weight: 700;">
            🗺️ ${I18N.t('openMapsLocationBtn')}
          </a>
          <a href="tel:${k.phone}" class="btn-secondary" style="padding: 8px 14px; font-size: 12px; text-decoration: none; display: inline-flex; align-items: center; gap: 4px;">
            📞 ${I18N.t('callDealerBtn')}
          </a>
          <button class="btn-primary" style="flex: 1.2; min-width: 160px; padding: 8px; font-size: 12.5px;" onclick="bookPickupFromKabadiwala('${k.name}')">
            ${isCurrentlyTracked ? '✅ ' + I18N.t('currentlyEnRouteBtn') : '🛵 ' + I18N.t('bookThisDealerBtn')}
          </button>
        </div>

        <!-- Customer Reviews -->
        <div class="reviews-accordion" style="margin-top: 10px;">
          <div style="font-weight: 700; font-size: 12px; color: var(--text-muted); display: flex; justify-content: space-between;">
            <span>⭐ ${I18N.t('customerFeedbackLabel')} (${k.reviews.length})</span>
            <span style="color: var(--primary);">▼</span>
          </div>
          <div style="margin-top: 4px;">
            ${reviewsHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');

  const dayNames = getDayNames();
  const collectionDayBanner = AppState.nextCollectionDay ? `
    <div style="background: var(--info-light); border: 1.5px solid var(--info-line); padding: 10px 14px; border-radius: var(--radius-sm); margin-bottom: 14px; font-size: 12.5px; color: var(--info); font-weight: 700;">
      📅 ${I18N.t('nextCollectionDayLabel')} ${I18N.t('everyWeekdayPrefix')} ${dayNames[AppState.nextCollectionDay.dayOfWeek]} (${AppState.nextCollectionDay.kabadiwalaName})
    </div>
  ` : '';

  container.innerHTML = `
    ${tabNavHtml}
    ${collectionDayBanner}

    <!-- 1. Active Order Live Tracking & Estimated Time of Arrival (ETA) -->
    <div class="card" style="border-top: 4px solid var(--primary); background: var(--card); padding: 18px; margin-bottom: 16px; box-shadow: var(--shadow-md);">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="live-dot-pulse"></span>
            <strong style="color: var(--primary); font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.5px;">
              ${I18N.t('liveTrackingTitle')}
            </strong>
          </div>
          <h3 style="font-size: 19px; font-weight: 900; margin-top: 4px; color: var(--text-main);">
            🛵 ${tracked.name} (${tracked.shopName})
          </h3>
          <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 2px;">
            ${I18N.t('vehicleLabel')} <strong>${tracked.vehicle}</strong> (${I18N.t('plateLabel')} <code>${tracked.vehiclePlate}</code>)
          </div>
        </div>

        <!-- Dynamic Live ETA Badge -->
        <div style="text-align: right;">
          <div style="background: var(--primary-light); border: 1.5px solid var(--primary-line); padding: 8px 14px; border-radius: var(--radius-sm); text-align: center;">
            <div style="font-size: 11px; font-weight: 800; color: var(--primary-dark); text-transform: uppercase;">${I18N.t('etaLabelLong')}</div>
            <div style="font-size: 24px; font-weight: 900; color: var(--primary-dark); margin-top: 2px;">
              ~${tracked.etaMinutes} ${I18N.t('minsUnit')}
            </div>
            <div style="font-size: 11px; color: var(--primary); font-weight: 600;">${I18N.t('distanceAwayLabel')} ${tracked.etaDistanceKm} km</div>
          </div>
        </div>
      </div>

      <!-- Live 3-Stage Progress Timeline -->
      <div style="margin: 16px 0 12px 0;">
        <div style="display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; margin-bottom: 6px;">
          <span style="color: var(--primary-dark);">1. ${I18N.t('stageConfirmed')} ✓</span>
          <span style="color: var(--primary);">2. ${I18N.t('stageEnRouteWithScale')} 🛵</span>
          <span style="color: var(--text-muted);">3. ${I18N.t('stageHandoverCash')} 💵</span>
        </div>
        <div style="background: var(--border); height: 8px; border-radius: 4px; position: relative; overflow: hidden;">
          <div style="background: var(--primary); width: ${progressPct}%; height: 8px; border-radius: 4px; transition: width 1s linear;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-top: 6px;">
          <span>${I18N.t('scaleLabel')} ${tracked.weighingEquipment.split('(')[0]}</span>
          <span>${I18N.t('statusLabel')} <strong>${stageLabel}</strong> (${progressPct}%)</span>
          <span>${I18N.t('expectedCashLabel')} <strong>₹${Number(payout).toLocaleString('en-IN')}</strong></span>
        </div>
      </div>

      <!-- Quick Action Buttons for En-Route Dealer -->
      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);">
        <a href="${tracked.googleMapsUrl}" target="_blank" class="btn-primary" style="flex: 1.4; min-width: 200px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; font-size: 13.5px; padding: 10px;">
          🗺️ ${I18N.t('viewLiveRouteBtn')}
        </a>
        <a href="tel:${tracked.phone}" class="btn-secondary" style="flex: 1; min-width: 150px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-decoration: none; font-size: 13px; padding: 10px;">
          📞 ${I18N.t('callLabel')} ${tracked.name}
        </a>
        <button class="audio-btn" style="padding: 10px 14px;" onclick="I18N.speak(I18N.tf('etaSpeechTemplate', { name: '${tracked.name.replace(/'/g, "\\'")}', mins: '${tracked.etaMinutes}' }))">
          ${I18N.t('speakBtn')}
        </button>
      </div>
      ${SecurePayment.customerPanelHtml()}
    </div>

    <!-- 2. Section Header: Nearby Scrap Dealers -->
    <div class="card-header" style="margin: 18px 0 10px 0;">
      <div>
        <h3 class="card-title" style="font-size: 16px;">📍 ${I18N.t('nearbyAggregatorsTitle')}</h3>
        <p class="card-subtitle" style="font-size: 12px;">${I18N.t('nearbyAggregatorsSubtitle')}</p>
      </div>
    </div>

    <!-- 3. Nearby Scrap Dealers Cards -->
    <div>
      ${kabadiwalasHtml}
    </div>
  `;
}

// -------------------------------------------------------------
// SUB-PAGE 3: CUSTOMER PROFILE & SALES HISTORY
// -------------------------------------------------------------
function renderCustomerProfileTab(container, tabNavHtml) {
  const custName = AppState.user.name || 'Customer';
  const custPhone = AppState.user.phone || '—';
  const custLocation = AppState.user.location || '—';

  if (!AppState.customerProfileData) {
    container.innerHTML = `
      ${tabNavHtml}
      <div class="card" style="text-align: center; padding: 48px 24px; color: var(--text-muted);">
        <div style="font-size: 32px;">⏳</div>
        <p style="font-size: 13.5px; font-weight: 700; margin-top: 8px;">${I18N.t('loadingTransactionHistory')}</p>
      </div>
    `;
    refreshCustomerProfileData();
    return;
  }

  const profileData = AppState.customerProfileData;
  const summary = profileData.summary;

  // Comparison Rows with previous months (real, computed from completed bookings)
  const monthlyRowsHtml = profileData.monthlyComparison.map((m, idx) => {
    const prior = profileData.monthlyComparison[idx + 1];
    const changeVsPrior = prior && prior.earnings
      ? `${m.earnings >= prior.earnings ? '+' : ''}${Math.round(((m.earnings - prior.earnings) / prior.earnings) * 100)}%`
      : '—';
    return { period: m.period, weightKg: m.weightKg, pickups: m.pickups, earnings: m.earnings, changeVsPrior };
  }).map(m => `
    <tr style="border-bottom: 1px solid var(--border);">
      <td style="padding: 10px 8px; font-weight: 700;">${m.period}</td>
      <td style="padding: 10px 8px; color: var(--primary-dark); font-weight: 800;">${m.weightKg} kg</td>
      <td style="padding: 10px 8px;">${m.pickups} ${I18N.t('pickupsUnit')}</td>
      <td style="padding: 10px 8px; font-weight: 800;">₹${m.earnings.toLocaleString('en-IN')}</td>
      <td style="padding: 10px 8px;">
        <span style="background: var(--primary-light); color: var(--primary-dark); font-weight: 800; font-size: 11.5px; padding: 2px 7px; border-radius: var(--radius-full);">
          ${m.changeVsPrior}
        </span>
      </td>
    </tr>
  `).join('');

  // Itemized Sales History Rows — real completed customer_bookings rows.
  const historyRowsHtml = profileData.history.map(tx => `
    <tr style="border-bottom: 1px solid var(--border); font-size: 12.5px;">
      <td style="padding: 10px 8px;">
        <strong>${new Date(tx.completedAt).toLocaleDateString()}</strong>
        <div style="font-size: 11px; color: var(--text-muted);">${new Date(tx.completedAt).toLocaleTimeString()} • <code>${tx.bookingCode}</code></div>
      </td>
      <td style="padding: 10px 8px;">
        <strong>${tx.kabadiwalaName}</strong>
      </td>
      <td style="padding: 10px 8px;">
        ${tx.materialName}${tx.qualityGrade ? ` <span style="font-size:10.5px; color:var(--text-muted);">(${I18N.t('qualityGradeLabel')} ${tx.qualityGrade})</span>` : ''}
      </td>
      <td style="padding: 10px 8px; font-weight: 800;">
        ${tx.weighedKg ?? tx.weightKg} kg
        <div style="font-size: 11px; color: var(--text-muted); font-weight: normal;">@ ₹${tx.ratePerKg}/kg</div>
      </td>
      <td style="padding: 10px 8px; font-weight: 900; color: var(--primary-dark);">
        ₹${Number(tx.amountPaid ?? tx.totalAmount).toLocaleString('en-IN')}
        <div style="font-size: 10.5px; color: var(--text-muted); font-weight: 600;">${tx.paymentMode} · ${paymentStatusChip(tx)}</div>
      </td>
      <td style="padding: 10px 8px;">
        <button class="btn-secondary" style="padding: 3px 9px; font-size: 11px; font-weight: 700;" onclick="viewDigitalPassport(${tx.id})">
          🌱 ${I18N.t('viewPassportBtn')}
        </button>
      </td>
    </tr>
  `).join('');

  container.innerHTML = `
    ${tabNavHtml}

    <!-- 1. Customer Profile Header Card -->
    <div class="card" style="border-left: 5px solid var(--primary); background: var(--card); padding: 18px; margin-bottom: 14px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 14px;">
        <div style="display: flex; gap: 14px; align-items: center;">
          <div style="font-size: 44px; background: var(--primary-light); width: 72px; height: 72px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; border: 2px solid var(--primary-line);">
            👤
          </div>
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <h3 style="font-size: 19px; font-weight: 900; color: var(--text-main); margin: 0;">${custName}</h3>
              <span style="background: var(--success-light); color: var(--primary-dark); font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: var(--radius-full);">
                🌿 ${I18N.t('certifiedEcoCitizenBadge')}
              </span>
            </div>
            <div style="font-size: 13.5px; font-weight: 700; color: var(--primary-dark); margin-top: 2px;">
              ${summary.preferredScrapDealer ? `${I18N.t('preferredDealerLabel')} <strong>${summary.preferredScrapDealer}</strong>` : I18N.t('noTransactionsYet')}
            </div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 3px;">
              📍 ${custLocation} • 📞 ${custPhone}
            </div>
          </div>
        </div>

        <div style="text-align: right;">
          <span style="background: var(--info-light); color: var(--info); padding: 3px 10px; border-radius: var(--radius-full); font-size: 11.5px; font-weight: 700;">
            🛡️ ${I18N.t('zeroLandfillVerifiedBadge')}
          </span>
          <div style="margin-top: 6px;">
            <button class="audio-btn" style="font-size: 11.5px; padding: 4px 10px;" onclick="I18N.speak(I18N.tf('customerProfileSpeechTemplate', { name: '${custName.replace(/'/g, "\\'")}', weight: '${summary.totalWeightSoldKg}', cash: '${summary.totalCashReceived}' }))">
              ${I18N.t('speakBtn')}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. Overview Impact Metrics (3-Column Grid) -->
    <div class="desktop-grid-3" style="gap: 12px; margin-bottom: 14px;">
      <div class="card" style="border-top: 4px solid var(--primary); text-align: center; padding: 14px; margin-bottom: 0;">
        <div style="font-size: 11.5px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">${I18N.t('totalScrapSoldLabel')}</div>
        <div style="font-size: 28px; font-weight: 900; color: var(--primary); margin-top: 2px;">${summary.totalWeightSoldKg} kg</div>
        <div style="font-size: 11px; color: var(--success); font-weight: 700; margin-top: 2px;">${I18N.t('divertedFromDumpsLabel')}</div>
      </div>

      <div class="card" style="border-top: 4px solid var(--info); text-align: center; padding: 14px; margin-bottom: 0;">
        <div style="font-size: 11.5px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">${I18N.t('totalCashReceivedLabel')}</div>
        <div style="font-size: 28px; font-weight: 900; color: var(--info); margin-top: 2px;">₹${summary.totalCashReceived.toLocaleString('en-IN')}</div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${I18N.t('fairDoorstepPayoutLabel')}</div>
      </div>

      <div class="card" style="border-top: 4px solid var(--accent); text-align: center; padding: 14px; margin-bottom: 0;">
        <div style="font-size: 11.5px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">${I18N.t('environmentalImpactLabel')}</div>
        <div style="font-size: 28px; font-weight: 900; color: var(--accent); margin-top: 2px;">🌳 ${summary.totalTreesEquivalent} ${I18N.t('treesUnit')}</div>
        <div style="font-size: 11px; color: var(--primary-dark); font-weight: 700; margin-top: 2px;">${summary.totalCo2PreventedKg} ${I18N.t('kgCo2PreventedLabel')}</div>
      </div>
    </div>

    <!-- 3. Sales Comparison with Previous Months (Table) -->
    <div class="card" style="padding: 16px; margin-bottom: 14px;">
      <div class="card-header" style="margin-bottom: 8px;">
        <div>
          <h4 class="card-title" style="font-size: 15px;">📊 ${I18N.t('monthlyComparisonTitle')}</h4>
          <p class="card-subtitle" style="font-size: 11.5px;">${I18N.t('monthlyComparisonSubtitle')}</p>
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; text-align: left;">
          <thead>
            <tr style="border-bottom: 2px solid var(--border); color: var(--text-muted); text-transform: uppercase; font-size: 11px;">
              <th style="padding: 8px;">${I18N.t('periodCol')}</th>
              <th style="padding: 8px;">${I18N.t('weightSoldCol')}</th>
              <th style="padding: 8px;">${I18N.t('pickupsCol')}</th>
              <th style="padding: 8px;">${I18N.t('cashEarnedCol')}</th>
              <th style="padding: 8px;">${I18N.t('growthVsPriorCol')}</th>
            </tr>
          </thead>
          <tbody>
            ${monthlyRowsHtml || `<tr><td colspan="5" style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12.5px;">${I18N.t('noTransactionsYet')}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 4. Detailed History of Scrap Sold to Dealers -->
    <div class="card" style="padding: 16px; margin-bottom: 0;">
      <div class="card-header" style="margin-bottom: 8px;">
        <div>
          <h4 class="card-title" style="font-size: 15px;">📋 ${I18N.t('itemizedHistoryTitle')}</h4>
          <p class="card-subtitle" style="font-size: 11.5px;">${I18N.t('itemizedHistorySubtitle')}</p>
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; text-align: left;">
          <thead>
            <tr style="border-bottom: 2px solid var(--border); color: var(--text-muted); text-transform: uppercase; font-size: 11px;">
              <th style="padding: 8px;">${I18N.t('dateTxIdCol')}</th>
              <th style="padding: 8px;">${I18N.t('dealerAndShopCol')}</th>
              <th style="padding: 8px;">${I18N.t('itemsSoldCol')}</th>
              <th style="padding: 8px;">${I18N.t('weightAndRateCol')}</th>
              <th style="padding: 8px;">${I18N.t('cashPaidCol')}</th>
              <th style="padding: 8px;">${I18N.t('cpcbGreenSlipCol')}</th>
            </tr>
          </thead>
          <tbody>
            ${historyRowsHtml || `<tr><td colspan="6" style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12.5px;">${I18N.t('noTransactionsYet')}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 5. Community & Institutions -->
    <div class="card" style="padding: 16px; margin-top: 14px;">
      <div class="card-header" style="margin-bottom: 8px;">
        <div>
          <h4 class="card-title" style="font-size: 15px;">🏫 ${I18N.t('institutionSectionTitle')}</h4>
          <p class="card-subtitle" style="font-size: 11.5px;">${I18N.t('institutionSectionSubtitle')}</p>
        </div>
      </div>
      <div id="institutionSectionBody">${renderInstitutionSectionBody()}</div>
    </div>

    <!-- 6. Fair Rotation Contract -->
    <div class="card" style="padding: 16px; margin-top: 14px; margin-bottom: 0;">
      <div class="card-header" style="margin-bottom: 8px;">
        <div>
          <h4 class="card-title" style="font-size: 15px;">🤝 ${I18N.t('contractSectionTitle')}</h4>
          <p class="card-subtitle" style="font-size: 11.5px;">${I18N.t('contractSectionSubtitle')}</p>
        </div>
      </div>
      <div id="contractSectionBody">${renderContractSectionBody()}</div>
    </div>

    <div id="passportModalContainer"></div>
  `;

  if (AppState.myContract === undefined) loadMyContract();
}

// -------------------------------------------------------------
// COMMUNITY & INSTITUTIONS + FAIR ROTATION CONTRACTS (Phase 7)
// Modeled as a lightweight extension of the existing customer role rather than a new
// top-level role, to avoid restructuring renderApp's role switch.
// -------------------------------------------------------------
function renderInstitutionSectionBody() {
  const inst = AppState.myInstitution;
  if (!inst) {
    return `
      <div class="desktop-grid-2" style="gap: 10px;">
        <input id="instName" class="form-input" placeholder="${I18N.t('institutionNamePlaceholder')}">
        <select id="instType" class="form-input">
          <option value="College">${I18N.t('instTypeCollege')}</option>
          <option value="School">${I18N.t('instTypeSchool')}</option>
          <option value="Office">${I18N.t('instTypeOffice')}</option>
          <option value="Society">${I18N.t('instTypeSociety')}</option>
        </select>
      </div>
      <button class="btn-primary" style="width:100%; padding:9px; font-size:12.5px; margin-top:8px;" onclick="registerInstitution()">
        ${I18N.t('registerInstitutionBtn')}
      </button>
    `;
  }
  return `
    <div style="font-size:13px;"><strong>${inst.name}</strong> (${inst.type})</div>
    ${inst.linkedKabadiwalaName ? `
      <div style="font-size:12px; color:var(--success); margin-top:4px;">✅ ${I18N.tf('linkedDealerLabel', { name: inst.linkedKabadiwalaName })}</div>
    ` : `
      <button class="btn-secondary" style="margin-top:8px; padding:7px 12px; font-size:12px;" onclick="linkNearestDealerToInstitution()">
        📍 ${I18N.t('linkNearestDealerBtn')}
      </button>
    `}
  `;
}

window.registerInstitution = async () => {
  const name = document.getElementById('instName').value.trim();
  const type = document.getElementById('instType').value;
  if (!name) return alert(I18N.t('enterInstitutionNameAlert'));
  try {
    const coords = AppState.myCoords;
    const inst = await API.createInstitution({
      name, type, contactName: AppState.user.name, phone: AppState.user.phone,
      location: AppState.user.location, latitude: coords ? coords.latitude : undefined, longitude: coords ? coords.longitude : undefined
    });
    AppState.myInstitution = inst;
    document.getElementById('institutionSectionBody').innerHTML = renderInstitutionSectionBody();
  } catch (err) {
    alert(`❌ ${err.message}`);
  }
};

window.linkNearestDealerToInstitution = async () => {
  if (!AppState.myInstitution || !ESETU_DATA.kabadiwalas.length) return;
  const coords = AppState.myCoords;
  const nearest = coords
    ? ESETU_DATA.kabadiwalas.slice().sort((a, b) =>
        (GeoUtils.haversineKm(coords.latitude, coords.longitude, a.latitude, a.longitude) ?? Infinity) -
        (GeoUtils.haversineKm(coords.latitude, coords.longitude, b.latitude, b.longitude) ?? Infinity))[0]
    : ESETU_DATA.kabadiwalas[0];
  try {
    const updated = await API.linkInstitutionDealer(AppState.myInstitution.id, { kabadiwalaId: nearest.id, kabadiwalaName: nearest.name });
    AppState.myInstitution = updated;
    document.getElementById('institutionSectionBody').innerHTML = renderInstitutionSectionBody();
  } catch (err) {
    alert(`❌ ${err.message}`);
  }
};

async function loadMyContract() {
  AppState.myContract = null;
  try {
    const contracts = await API.listContracts(AppState.user.phone);
    if (contracts.length) {
      AppState.myContract = contracts[0];
      const el = document.getElementById('contractSectionBody');
      if (el) el.innerHTML = renderContractSectionBody();
    }
  } catch {}
}

function renderContractSectionBody() {
  const contract = AppState.myContract;
  if (!contract) {
    const tracked = AppState.trackedKabadiwala || ESETU_DATA.kabadiwalas[0];
    if (!tracked) return `<div style="font-size:12.5px; color:var(--text-muted);">${I18N.t('noDealersAvailableYet')}</div>`;
    return `
      <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">${I18N.t('noContractYet')}</div>
      <button class="btn-primary" style="padding:9px 14px; font-size:12.5px;" onclick="startFairRotationContract('${tracked.id}', '${tracked.name}')">
        ${I18N.t('startContractBtn')} — ${tracked.name}
      </button>
    `;
  }

  const startMs = new Date(contract.startDate).getTime();
  const endMs = startMs + contract.durationDays * 86400000;
  const daysRemaining = Math.ceil((endMs - Date.now()) / 86400000);
  const expired = daysRemaining <= 0;

  return `
    <div style="font-size:13px;"><strong>${contract.kabadiwalaName}</strong> — ${I18N.tf('dayRotationLabel', { days: contract.durationDays })}</div>
    <div style="font-size:12.5px; color:${expired ? 'var(--danger)' : 'var(--success)'}; margin-top:4px; font-weight:700;">
      ${expired ? I18N.t('contractExpired') : `${daysRemaining} ${I18N.t('daysRemainingLabel')}`}
    </div>
    ${expired ? `
      <div style="display:flex; gap:8px; margin-top:8px;">
        <button class="btn-primary" style="padding:7px 12px; font-size:12px;" onclick="renewMyContract(${contract.id})">🔄 ${I18N.t('renewBtn')}</button>
        <button class="btn-secondary" style="padding:7px 12px; font-size:12px;" onclick="switchMyContractDealer(${contract.id})">🔀 ${I18N.t('switchDealerBtn')}</button>
      </div>
    ` : ''}
  `;
}

window.startFairRotationContract = async (kabadiwalaId, kabadiwalaName) => {
  try {
    const contract = await API.createContract({
      customerId: AppState.user.phone, customerType: AppState.myInstitution ? 'institution' : 'customer',
      customerName: AppState.user.name, kabadiwalaId, kabadiwalaName, durationDays: 15
    });
    AppState.myContract = contract;
    document.getElementById('contractSectionBody').innerHTML = renderContractSectionBody();
  } catch (err) {
    alert(`❌ ${err.message}`);
  }
};

window.renewMyContract = async (contractId) => {
  const updated = await API.renewContract(contractId);
  AppState.myContract = updated;
  document.getElementById('contractSectionBody').innerHTML = renderContractSectionBody();
};

window.switchMyContractDealer = async (contractId) => {
  const others = ESETU_DATA.kabadiwalas.filter(k => k.name !== AppState.myContract.kabadiwalaName);
  const next = others[0] || ESETU_DATA.kabadiwalas[0];
  const updated = await API.switchContract(contractId, { kabadiwalaId: next.id, kabadiwalaName: next.name });
  AppState.myContract = updated;
  document.getElementById('contractSectionBody').innerHTML = renderContractSectionBody();
};

// Digital Scrap Passport — a per-item handover record (photo + GPS + weight + dealer +
// timestamp), styled like the existing recycler CPCB certificate modal.
window.viewDigitalPassport = (bookingId) => {
  const tx = (AppState.customerProfileData && AppState.customerProfileData.history || []).find(b => b.id === bookingId);
  if (!tx) return;

  const modalEl = document.getElementById('passportModalContainer');
  const gpsText = (tx.gpsLat && tx.gpsLng) ? `${Number(tx.gpsLat).toFixed(5)}° N, ${Number(tx.gpsLng).toFixed(5)}° E` : I18N.t('gpsNotCapturedText');

  modalEl.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="border-top: 6px solid var(--success); max-width: 460px;">
        <button class="modal-close" onclick="document.getElementById('passportModalContainer').innerHTML=''">✕</button>

        <div style="text-align: center; margin-bottom: 14px;">
          <div style="font-size: 36px;">🌱</div>
          <h3 style="font-size: 17px; font-weight: 900; color: var(--primary-dark);">${I18N.t('digitalPassportTitle')}</h3>
          <div style="font-size: 11.5px; color: var(--text-muted);">${I18N.t('bookingLabel')} <code>${tx.bookingCode}</code></div>
        </div>

        ${tx.photoDataUrl ? `<img src="${tx.photoDataUrl}" style="width:100%; max-height:200px; object-fit:cover; border-radius: var(--radius-sm); margin-bottom: 12px; border: 1px solid var(--border);">` : ''}

        <div style="background: var(--surface-2); border: 1.5px solid var(--border); padding: 14px; border-radius: var(--radius-sm); font-size: 13px; line-height: 1.7;">
          <div><strong>${I18N.t('materialLabel')}</strong> ${tx.materialName} ${tx.qualityGrade ? `(${I18N.t('qualityGradeLabel')} ${tx.qualityGrade})` : ''}</div>
          <div><strong>${I18N.t('weightLabelShort')}</strong> ${tx.weighedKg ?? tx.weightKg} kg @ ₹${tx.ratePerKg}/kg${tx.weighedKg && tx.weighedKg !== tx.weightKg ? ` <span style="color:var(--text-muted)">(${I18N.t('quotedLabel')} ${tx.weightKg} kg)</span>` : ''}</div>
          <div><strong>${I18N.t('cashPaidLabel')}</strong> ₹${Number(tx.amountPaid ?? tx.totalAmount).toLocaleString('en-IN')} (${tx.paymentMode}) ${paymentStatusChip(tx)}</div>
          ${tx.confirmedBy ? `<div><strong>${I18N.t('releasedByLabel')}</strong> ${tx.confirmedBy === 'dealer' ? I18N.t('releasedByDealerCode') : I18N.t('releasedByCustomer')}</div>` : ''}
          <div><strong>${I18N.t('collectorLabel')}</strong> ${tx.kabadiwalaName}</div>
          <div><strong>${I18N.t('gpsHandoverProofLabel')}</strong> ${gpsText}</div>
          <div><strong>${I18N.t('requestedLabel')}</strong> ${new Date(tx.createdAt).toLocaleString()}</div>
          <div><strong>${I18N.t('completedLabel')}</strong> ${new Date(tx.completedAt).toLocaleString()}</div>
          ${tx.pooledLotId ? `<div>🔗 <strong>${I18N.t('pooledIntoLabel')}</strong> <code>${tx.pooledLotId}</code></div>` : ''}
        </div>
      </div>
    </div>
  `;
};

function paymentStatusChip(tx) {
  if (tx.paymentStatus === 'Disputed') return `<span class="chip chip-red">${I18N.t('paymentDisputedChip')}</span>`;
  if (tx.paymentFlag === 'underpaid-accepted') return `<span class="chip chip-amber">${I18N.t('paymentShortAcceptedChip')}</span>`;
  if (tx.paymentStatus === 'Released') return `<span class="chip chip-green">${I18N.t('paymentReleasedChip')}</span>`;
  return '';
}

// Window helper functions for customer actions
window.selectCustomerMaterial = (matId) => {
  const mat = ESETU_DATA.materials.find(m => m.id === matId);
  if (mat) {
    AppState.selectedMaterial = mat;
    const container = document.getElementById('appContent');
    renderCustomerPage(container);
  }
};

window.adjustWeight = (delta) => {
  AppState.calculatorWeight = Math.max(0.1, Number((AppState.calculatorWeight + delta).toFixed(2)));
  AppState.scaleReading = null;
  const container = document.getElementById('appContent');
  renderCustomerPage(container);
};

window.setWeight = (w) => {
  AppState.calculatorWeight = Number(w);
  AppState.scaleReading = null;
  const container = document.getElementById('appContent');
  renderCustomerPage(container);
};

// Smart Weighing — no real Bluetooth/serial scale hardware is available in this environment,
// so this is an honestly-labeled simulation: a real, interactive multi-step connect flow
// (not a static image) that settles on a plausible reading and feeds it straight into the
// same weight state the manual stepper uses.
window.connectSmartScale = () => {
  const widget = document.getElementById('smartScaleWidget');
  if (!widget) return;

  widget.innerHTML = `<div style="text-align:center; font-size:12px; font-weight:700; color:var(--info); padding:7px;">🔎 ${I18N.t('scaleSearching')}</div>`;

  setTimeout(() => {
    if (!document.getElementById('smartScaleWidget')) return;
    widget.innerHTML = `<div style="text-align:center; font-size:12px; font-weight:700; color:var(--primary-dark); padding:7px;">🔗 ${I18N.t('scaleConnected')}</div>`;

    setTimeout(() => {
      if (!document.getElementById('smartScaleWidget')) return;
      // Settle on a plausible reading around the current weight (±150g), rounded to 10g.
      const base = Number(AppState.calculatorWeight) || 0.2;
      const jitter = (Math.random() - 0.5) * 0.3;
      const settled = Math.max(0.1, Math.round((base + jitter) * 100) / 100);
      AppState.calculatorWeight = settled;
      AppState.scaleReading = { weightKg: settled };
      const container = document.getElementById('appContent');
      renderCustomerPage(container);
      I18N.speak(I18N.tf('scaleConnectedSpeech', { grams: Math.round(settled * 1000) }));
    }, 1200);
  }, 900);
};

// Shared speech-recognition factory — feature-detected the same way I18N.speak
// feature-detects speechSynthesis. Returns null (never throws) when unsupported.
function createSpeechRecognizer(lang) {
  const Recognizer = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognizer) return null;
  const recognition = new Recognizer();
  recognition.lang = lang || I18N.langMap[I18N.currentLang] || 'en-IN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  return recognition;
}

// Shared keyword matcher: scores each material by how many of its own significant name
// words (>3 chars, any of the 7 localized names or the symbol) appear in the given text,
// and returns the best-scoring material (or null if nothing matched at all). Splitting the
// material's own name into words — rather than testing the whole name as one substring —
// is what lets "copper wire" match "Copper Cables & Insulated Wiring".
function findMaterialInText(text) {
  let best = null;
  let bestScore = 0;
  for (const m of ESETU_DATA.materials) {
    const names = [m.name, m.nameHi, m.nameMr, m.nameTa, m.nameTe, m.nameKn, m.nameMl].filter(Boolean);
    let score = 0;
    for (const n of names) {
      const words = n.toLowerCase().replace(/[()/]/g, ' ').split(/[\s,&-]+/).filter((w) => w.length > 3);
      for (const w of words) {
        if (text.includes(w)) score++;
      }
    }
    if (m.symbol && text.includes(m.symbol.toLowerCase())) score += 2;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return bestScore > 0 ? best : null;
}

// Voice Selling — speak a material name and a weight; a rule-based keyword/regex parser
// (checking every localized name field already on each material, plus a unit-aware weight
// regex) fills the calculator, the same way tapping the chips or stepper would.
function parseVoiceSellCommand(transcript) {
  const text = transcript.toLowerCase();
  const matchedMaterial = findMaterialInText(text);

  let weightKg = null;
  const match = text.match(/(\d+(\.\d+)?)\s*(kg|kilo|kilogram|gram|grams|g)\b/);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[3];
    const isKiloUnit = unit === 'kg' || unit.startsWith('kilo');
    weightKg = isKiloUnit ? value : value / 1000;
  }

  return { material: matchedMaterial, weightKg };
}

window.startVoiceSelling = () => {
  const statusEl = document.getElementById('voiceSellStatus');
  const recognition = createSpeechRecognizer();
  if (!recognition) {
    if (statusEl) statusEl.textContent = I18N.t('voiceUnsupported');
    return;
  }

  if (statusEl) statusEl.textContent = `🎙️ ${I18N.t('voiceListening')}`;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const { material, weightKg } = parseVoiceSellCommand(transcript);

    if (material) { AppState.selectedMaterial = material; AppState.aiScanResult = null; }
    if (weightKg && weightKg > 0) { AppState.calculatorWeight = Math.round(weightKg * 100) / 100; AppState.scaleReading = null; }

    const container = document.getElementById('appContent');
    renderCustomerPage(container);

    const heardMsg = document.getElementById('voiceSellStatus');
    if (heardMsg) heardMsg.textContent = `${I18N.t('voiceHeard')} "${transcript}"`;
    if (material || weightKg) {
      I18N.speak(`${material ? getLocalizedMatName(material) : ''} ${weightKg ? Math.round(weightKg * 1000) + ' ' + I18N.t('gramsUnit') : ''}`.trim());
    }
  };

  recognition.onerror = () => {
    if (statusEl) statusEl.textContent = I18N.t('voiceNotHeard');
  };

  recognition.start();
};

// AI Voice Assistant — composes answers from LIVE app data (current rates, real nearest
// dealer, real safety guidance) via a small rule-based intent matcher. Not a network LLM
// call: fully offline, deterministic, and reflects whatever the platform's data says right
// now (e.g. answers change immediately after a recycler edits a rate).
function matchAssistantIntent(query) {
  const text = query.toLowerCase();

  // 1) Price lookup — "what's the price of copper" / "rate for pcb"
  const priceMat = findMaterialInText(text);
  if (priceMat && /price|rate|cost|worth|value|kitna|kimmat|daam/.test(text)) {
    return I18N.tf('assistantPriceAnswer', { matName: getLocalizedMatName(priceMat), customerRate: priceMat.customerRate, recyclerRate: priceMat.recyclerRate });
  }

  // 2) Nearest dealer
  if (/near|nearby|dealer|kabadiwala|collector/.test(text)) {
    if (!ESETU_DATA.kabadiwalas.length) return I18N.t('assistantNoDealersAnswer');
    const nearest = AppState.myCoords
      ? ESETU_DATA.kabadiwalas.slice().sort((a, b) =>
          GeoUtils.haversineKm(AppState.myCoords.latitude, AppState.myCoords.longitude, a.latitude, a.longitude) -
          GeoUtils.haversineKm(AppState.myCoords.latitude, AppState.myCoords.longitude, b.latitude, b.longitude))[0]
      : ESETU_DATA.kabadiwalas[0];
    return I18N.tf('assistantNearestDealerAnswer', { name: nearest.name, shop: nearest.shopName, location: nearest.location, mins: nearest.etaMinutes });
  }

  // 3) Safety guidance — keyword matching stays against the English title (queries are
  // matched in whatever language the user typed, and the English topic words like
  // "copper"/"battery"/"acid" are stable keys), but the ANSWER is fully localized.
  for (const guide of ESETU_DATA.safetyGuides || []) {
    const keyword = guide.title.toLowerCase().split(':').pop().trim().split(' ')[0];
    if (keyword && text.includes(keyword)) {
      return `${localizedField(guide, 'title')}. ${localizedField(guide, 'safeMethod')}`;
    }
  }
  if (/safe|hazard|danger|burn|acid/.test(text) && ESETU_DATA.safetyGuides && ESETU_DATA.safetyGuides.length) {
    const g = ESETU_DATA.safetyGuides[0];
    return `${localizedField(g, 'title')}. ${localizedField(g, 'safeMethod')}`;
  }

  // 4) Fallback — how it works
  return I18N.t('assistantFallbackAnswer');
}

window.openVoiceAssistantModal = () => {
  let modalContainer = document.getElementById('voiceAssistantOverlay');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'voiceAssistantOverlay';
    document.body.appendChild(modalContainer);
  }

  modalContainer.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 480px;">
        <button class="modal-close" onclick="document.getElementById('voiceAssistantOverlay').innerHTML=''">✕</button>
        <h3 style="font-size: 17px; font-weight: 800; color: var(--primary-dark); margin-bottom: 4px;">
          🎙️ ${I18N.t('assistantTitle')}
        </h3>
        <p style="font-size: 12.5px; color: var(--text-muted); margin-bottom: 12px;">${I18N.t('assistantSubtitle')}</p>

        <div style="display: flex; gap: 8px; margin-bottom: 10px;">
          <input id="assistantQueryInput" class="form-input" placeholder="${I18N.t('assistantPlaceholder')}" onkeydown="if(event.key==='Enter') askVoiceAssistant()">
          <button class="btn-secondary" style="width: auto; padding: 0 14px; border-color: var(--plum); color: var(--plum);" onclick="startAssistantVoiceInput()">🎙️</button>
        </div>
        <button class="btn-primary" style="width: 100%; padding: 10px; font-size: 13px;" onclick="askVoiceAssistant()">
          ${I18N.t('assistantAskBtn')}
        </button>

        <div id="assistantAnswerBox" style="margin-top: 14px; min-height: 40px; font-size: 13.5px; color: var(--text-main); background: var(--primary-light); border: 1.5px solid var(--primary-line); border-radius: var(--radius-sm); padding: 12px; display: none;"></div>
      </div>
    </div>
  `;
};

window.startAssistantVoiceInput = () => {
  const recognition = createSpeechRecognizer();
  if (!recognition) { alert(I18N.t('voiceUnsupported')); return; }
  recognition.onresult = (event) => {
    document.getElementById('assistantQueryInput').value = event.results[0][0].transcript;
    askVoiceAssistant();
  };
  recognition.start();
};

window.askVoiceAssistant = () => {
  const input = document.getElementById('assistantQueryInput');
  const query = input.value.trim();
  if (!query) return;

  const answer = matchAssistantIntent(query);
  const box = document.getElementById('assistantAnswerBox');
  box.style.display = 'block';
  box.textContent = answer;
  I18N.speak(answer);
};

window.selectPaymentMode = (mode) => {
  AppState.selectedPaymentMode = mode;
  document.querySelectorAll('.pay-chip').forEach(c => c.classList.remove('selected'));
  const el = document.getElementById(`payMode-${mode}`);
  if (el) el.classList.add('selected');
};

window.speakCurrentValuation = () => {
  const matName = getLocalizedMatName(AppState.selectedMaterial);
  const weightKg = Number(AppState.calculatorWeight) || 0.2;
  const weightGrams = Math.round(weightKg * 1000);
  const payout = (weightKg * AppState.selectedMaterial.customerRate).toFixed(0);
  const text = `${matName}, weight ${weightGrams} grams (${weightKg} kg). Total payout: ${Number(payout).toLocaleString('en-IN')} rupees.`;
  I18N.speak(text);
};

// Verified Handover & Proof: captures real GPS + the AI-scanned photo (downscaled) at the
// moment the pickup is actually requested, and persists a real customer_bookings row —
// this is what makes the Digital Scrap Passport and Environmental Tracker real instead of
// permanently-empty stubs.
async function createRealBooking(tracked) {
  const weightKg = Number(AppState.calculatorWeight) || 0.2;
  const mat = AppState.selectedMaterial;
  const scan = AppState.aiScanResult;
  const qualityMultiplier = (scan && scan.material.id === mat.id) ? scan.qualityMultiplier : 1.0;
  const qualityGrade = (scan && scan.material.id === mat.id) ? scan.grade : null;

  const [coords, photoDataUrl] = await Promise.all([
    getBrowserCoordinates(),
    downscaleImageToDataUrl(AppState.capturedImage)
  ]);

  const payload = {
    customerPhone: AppState.user.phone,
    customerName: AppState.user.name,
    kabadiwalaId: tracked.id,
    kabadiwalaName: tracked.name,
    materialId: mat.id,
    weightKg,
    qualityGrade,
    qualityMultiplier,
    paymentMode: AppState.selectedPaymentMode,
    gpsLat: coords ? coords.latitude : undefined,
    gpsLng: coords ? coords.longitude : undefined,
    photoDataUrl
  };

  // Offline Mode: queue the write instead of failing outright when there's no connectivity
  // (or the request itself fails to reach the server) — synced automatically once back online.
  if (!navigator.onLine) {
    return queueOfflineBooking(payload);
  }
  try {
    const booking = await API.createBooking(payload);
    AppState.activeBooking = booking;
    return booking;
  } catch (err) {
    if (err instanceof TypeError) return queueOfflineBooking(payload); // network-level failure
    throw err; // a real server-side validation error — surface it, don't silently queue it
  }
}

function queueOfflineBooking(payload) {
  AppState.syncQueue.push({ type: 'booking', payload, queuedAt: new Date().toISOString() });
  saveSyncQueue();
  const localWeight = payload.weightKg;
  const localTotal = Math.round(localWeight * AppState.selectedMaterial.customerRate * (payload.qualityMultiplier || 1));
  AppState.activeBooking = null; // no real id yet — it's created once synced
  return { bookingCode: 'QUEUED — offline', totalAmount: localTotal, gpsLat: payload.gpsLat, photoDataUrl: payload.photoDataUrl, queued: true };
}

window.bookPickupFromCalculator = async () => {
  const tracked = ESETU_DATA.kabadiwalas[0];
  AppState.trackedKabadiwala = tracked;
  AppState.deliveryStartedAt = Date.now();
  try {
    const booking = await createRealBooking(tracked);
    AppState.activeBookingNotice = `✅ Doorstep Pickup Requested! <strong>${tracked.name}</strong> (${tracked.shopName}) is on the way. Estimated cash: <strong>₹${Number(booking.totalAmount).toLocaleString('en-IN')}</strong>. Booking: <code>${booking.bookingCode}</code>${booking.gpsLat ? ' 📍 GPS captured' : ''}${booking.photoDataUrl ? ' 📸 Photo attached' : ''}`;
    I18N.speak(I18N.tf('pickupBookedSpeech', { name: tracked.name, mins: tracked.etaMinutes }));
  } catch (err) {
    AppState.activeBookingNotice = `❌ Could not book pickup: ${err.message}`;
  }
  AppState.customerTab = 'dealers';
  const container = document.getElementById('appContent');
  renderCustomerPage(container);
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.bookPickupFromKabadiwala = async (kabadiName) => {
  const found = ESETU_DATA.kabadiwalas.find(k => k.name === kabadiName || k.name.includes(kabadiName)) || ESETU_DATA.kabadiwalas[0];
  AppState.trackedKabadiwala = found;
  AppState.deliveryStartedAt = Date.now();
  try {
    const booking = await createRealBooking(found);
    AppState.activeBookingNotice = `✅ Pickup Confirmed! <strong>${found.name}</strong> (${found.shopName}) is dispatched with digital scale. Cash: <strong>₹${Number(booking.totalAmount).toLocaleString('en-IN')}</strong>. Booking: <code>${booking.bookingCode}</code>${booking.gpsLat ? ' 📍 GPS captured' : ''}${booking.photoDataUrl ? ' 📸 Photo attached' : ''}`;
    I18N.speak(I18N.tf('pickupConfirmedSpeech', { name: found.name, mins: found.etaMinutes }));
  } catch (err) {
    AppState.activeBookingNotice = `❌ Could not book pickup: ${err.message}`;
  }
  AppState.customerTab = 'dealers';
  const container = document.getElementById('appContent');
  renderCustomerPage(container);
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Handover is settled through Secure Payment (js/secure-payment.js): the dealer releases
// it with the customer's code, or the customer confirms weight + amount received here.
window.markBookingCollected = () => SecurePayment.openCustomerConfirm();

// -------------------------------------------------------------
// STEP 3: KABADIWALA (SCRAP DEALER) 3-PAGE DASHBOARD
// Page 1: Live Scrap Commodity Exchange & 10s Fluctuating Graph
// Page 2: Warehouse Stockpile & Wholesale Recyclers Comparison
// Page 3: Dealer Profile & Daily Collection History Comparisons
// -------------------------------------------------------------
// Materials are grouped into segregation categories for display — a static
// snapshot of recycler buying rates, not a live-updating ticker. Rates only
// change when a recycler explicitly publishes a new rate (see promptRateUpdate).
const MATERIAL_CATEGORY_GROUPS = [
  { key: 'metals', icon: '🔩', labelKey: 'categoryMetalsWires', symbols: ['CU-WIRE', 'MOT-MAG'] },
  { key: 'circuits', icon: '💻', labelKey: 'categoryCircuitBoards', symbols: ['PCB-HI'] },
  { key: 'batteries', icon: '🔋', labelKey: 'categoryBatteries', symbols: ['LI-BATT'] },
  { key: 'glass', icon: '📺', labelKey: 'categoryGlassDisplays', symbols: ['CRT-GLS', 'LCD-SCR'] },
  { key: 'plastics', icon: '♻️', labelKey: 'categoryPlastics', symbols: ['PLAS-MIX'] }
];

// Fully translated across all 7 languages (previously only had en/hi/mr, so Tamil, Telugu,
// Kannada, and Malayalam users always saw the English category name — fixed here).
function groupLabel(group) {
  return I18N.t(group.labelKey);
}

function renderKabadiwalaPage(container) {
  if (!AppState.kabadiwalaTab) AppState.kabadiwalaTab = 'exchange';

  markView(`kabadiwala:${AppState.kabadiwalaTab}`);
  const tabNavHtml = renderTabbar([
    { key: 'exchange', label: I18N.t('exchangeTabLabel'), icon: 'chart' },
    { key: 'warehouse', label: I18N.t('warehouseTabLabel'), icon: 'yard' },
    { key: 'profile', label: I18N.t('kabadiProfileTabLabel'), icon: 'user' }
  ], AppState.kabadiwalaTab, 'setKabadiwalaTab');

  if (AppState.kabadiwalaTab === 'exchange') {
    renderKabadiwalaExchangeTab(container, tabNavHtml);
  } else if (AppState.kabadiwalaTab === 'warehouse') {
    renderKabadiwalaWarehouseTab(container, tabNavHtml);
  } else {
    renderKabadiwalaProfileTab(container, tabNavHtml);
  }
}

// Window helper to switch tabs
window.setKabadiwalaTab = (tabName) => {
  AppState.kabadiwalaTab = tabName;
  const container = document.getElementById('appContent');
  renderKabadiwalaPage(container);
};

// -------------------------------------------------------------
// SUB-PAGE 1: WHOLESALE COMMODITY RATES — SEGREGATED BY MATERIAL TYPE
// Static snapshot; rates change only when a recycler publishes a new one.
// -------------------------------------------------------------
function renderKabadiwalaExchangeTab(container, tabNavHtml) {
  const groupsHtml = MATERIAL_CATEGORY_GROUPS.map(group => {
    const materials = ESETU_DATA.materials.filter(m => group.symbols.includes(m.symbol));
    if (materials.length === 0) return '';

    const rowsHtml = materials.map(m => {
      const isUp = m.isPositive;
      const cls = isUp ? 'up' : 'down';
      const arrow = isUp ? '▲' : '▼';

      return `
        <tr style="border-bottom: 1px solid var(--border);">
          <td style="padding: 12px 8px;">
            <span class="symbol-badge">${m.symbol}</span>
            <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 2px;">${m.icon} ${getLocalizedMatName(m).split('(')[0]}</div>
          </td>
          <td style="padding: 12px 8px;">
            <strong style="font-size: 16px; color: var(--text-main);">₹${m.recyclerRate}/kg</strong>
            <div style="font-size: 11px; color: var(--text-muted);">${I18N.t('previousRateLabel')} ₹${m.recyclerRate6hrAgo}</div>
          </td>
          <td style="padding: 12px 8px;">
            <span class="trend-badge ${cls}">${arrow} ${m.changePct}</span>
          </td>
          <td style="padding: 12px 8px; color: var(--primary-dark); font-weight: 700;">₹${m.dayHigh}/kg</td>
          <td style="padding: 12px 8px; color: var(--danger); font-weight: 700;">₹${m.dayLow}/kg</td>
          <td style="padding: 12px 8px;">
            <button class="spark-btn" onclick="openPriceHistory('${m.id}')" title="${I18N.t('priceHistoryTitle')}">
              ${PriceUtils.buildSparklineSvg(m.sparkline, { width: 80, height: 24, color: isUp ? 'var(--up)' : 'var(--down)' })}
              <span>${I18N.t('viewHistoryShort')}</span>
            </button>
          </td>
          <td style="padding: 12px 8px;">
            ${ESETU_DATA.recyclers.length ? `
              <button class="btn-primary" style="padding: 6px 12px; font-size: 12px; width: auto;" onclick="openCreateLotModal('${ESETU_DATA.recyclers[0].id}', '${ESETU_DATA.recyclers[0].name}')">
                ${I18N.t('sellLotBtn')}
              </button>
            ` : `
              <span style="font-size: 11px; color: var(--text-muted);">${I18N.t('noRecyclersYetShort')}</span>
            `}
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="card" style="margin-bottom: 16px;">
        <div class="card-header" style="margin-bottom: 10px; padding-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 22px;">${group.icon}</span>
            <h3 class="card-title" style="font-size: 15.5px;">${groupLabel(group)}</h3>
          </div>
        </div>
        <div style="overflow-x: auto;">
          <table class="stock-ticker-table">
            <thead>
              <tr>
                <th>${I18N.t('materialCol')}</th>
                <th>${I18N.t('recyclerRateCol')}</th>
                <th>${I18N.t('changeCol')}</th>
                <th>${I18N.t('dayHighCol')}</th>
                <th>${I18N.t('dayLowCol')}</th>
                <th>${I18N.t('priceHistoryLabel')}</th>
                <th>${I18N.t('actionCol')}</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    ${tabNavHtml}

    <!-- Wholesale Rate Snapshot (static — updates only when a recycler publishes new rates) -->
    <div class="page-band">
      <div>
        <p class="eyebrow">${I18N.t('segregatedByType')}</p>
        <h2>${I18N.t('wholesaleRatesTitle')}</h2>
        <p>${I18N.t('wholesaleBandHint')}</p>
      </div>
      <button class="audio-btn" onclick="I18N.speak(I18N.t('wholesaleRatesSpeech'))">
        ${I18N.t('speakBtn')}
      </button>
    </div>

    ${groupsHtml}

    <!-- Modal Container -->
    <div id="lotModalContainer"></div>
  `;
}

// -------------------------------------------------------------
// SUB-PAGE 2: WAREHOUSE STOCKPILE & WHOLESALE RECYCLERS
// -------------------------------------------------------------
function renderKabadiwalaWarehouseTab(container, tabNavHtml) {
  let totalStockWeight = 0;
  let totalStockValue = 0;
  let totalEstimatedProfit = 0;

  const stockRowsHtml = ESETU_DATA.inventory.map(inv => {
    const mat = ESETU_DATA.materials.find(m => m.id === inv.materialId);
    const recRate = mat ? mat.recyclerRate : 100;
    const itemVal = inv.weightKg * recRate;
    const profit = inv.weightKg * (recRate - inv.avgBuyCost);

    totalStockWeight += inv.weightKg;
    totalStockValue += itemVal;
    totalEstimatedProfit += profit;

    return `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding: 10px 8px;">
          <strong>${inv.name}</strong>
          <div style="font-size: 11px; color: var(--text-muted);">${inv.symbol}</div>
        </td>
        <td style="padding: 10px 8px; font-weight: 700;">${inv.weightKg} kg</td>
        <td style="padding: 10px 8px; color: var(--primary-text); font-weight: 800;">₹${recRate}/kg</td>
        <td style="padding: 10px 8px; font-weight: 800;">₹${itemVal.toLocaleString('en-IN')}</td>
        <td style="padding: 10px 8px; color: var(--success); font-weight: 700;">+₹${profit.toLocaleString('en-IN')}</td>
      </tr>
    `;
  }).join('');

  // Smart Recycler Matching — real distance from the kabadiwala's own captured
  // coordinates (Phase 0/4), sorted nearest-first. Falls back to the platform's static
  // distanceKm text (and original insertion order) when either point is missing.
  const recyclersWithDistance = ESETU_DATA.recyclers.map(r => {
    const liveDistanceKm = AppState.myCoords
      ? GeoUtils.haversineKm(AppState.myCoords.latitude, AppState.myCoords.longitude, r.latitude, r.longitude)
      : null;
    return { ...r, liveDistanceKm };
  });
  const sortedRecyclers = recyclersWithDistance.slice().sort((a, b) => {
    if (a.liveDistanceKm === null && b.liveDistanceKm === null) return 0;
    if (a.liveDistanceKm === null) return 1;
    if (b.liveDistanceKm === null) return -1;
    return a.liveDistanceKm - b.liveDistanceKm;
  });

  // Best Buyer Finder — which recycler currently pays the most for the kabadiwala's
  // most-traded material (defaults to the first material shown on each card, PCB-HI).
  const bestBuyerFocusMat = ESETU_DATA.materials.find(m => m.symbol === 'PCB-HI') || ESETU_DATA.materials[0];
  const bestRateForFocusMat = Math.max(...sortedRecyclers.map(r => (r.rates && r.rates[bestBuyerFocusMat.symbol]) || bestBuyerFocusMat.recyclerRate));

  const recyclersHtml = sortedRecyclers.map(r => {
    const reviewsHtml = r.kabadiwalaReviews.map(rev => `
      <div class="review-item">
        <div class="review-author">
          <span>🚲 ${rev.author}</span>
          <span style="color: var(--accent-ink);">★ ${rev.rating}</span>
        </div>
        <div class="review-text">"${rev.text}"</div>
      </div>
    `).join('');

    return `
      <div class="rec-compare-card" style="margin-bottom: 0; display: flex; flex-direction: column; justify-content: space-between; height: 100%;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <h4 style="font-size: 15px; font-weight: 800;">${r.name}</h4>
              <span class="rec-badge-gov">🛡️ ${r.cpcbRegNo}</span>
              ${r.cpcbVerified
                ? `<span style="background:var(--success-light); color:var(--primary-dark); font-size:10.5px; font-weight:800; padding:2px 7px; border-radius:4px; margin-left:4px;">✅ ${I18N.t('cpcbVerifiedBadge')}</span>`
                : `<span style="background:var(--accent-light); color:var(--accent-ink); font-size:10.5px; font-weight:800; padding:2px 7px; border-radius:4px; margin-left:4px;">⚠️ ${I18N.t('cpcbUnverifiedBadge')}</span>`}
              ${(r.rates && r.rates[bestBuyerFocusMat.symbol] || bestBuyerFocusMat.recyclerRate) >= bestRateForFocusMat
                ? `<span style="background:var(--plum-light); color:var(--plum); font-size:10.5px; font-weight:800; padding:2px 7px; border-radius:4px; margin-left:4px;">🏆 ${I18N.t('bestPayerBadge')}</span>`
                : ''}
            </div>
            <div style="text-align: right;">
              <div style="font-size: 13px; font-weight: 800; color: var(--accent-ink);">★ ${r.rating}</div>
              <div style="font-size: 11px; color: var(--text-muted);">${r.kabadiwalaReviewsCount} ${I18N.t('dealerReviewsUnit')}</div>
            </div>
          </div>

          <!-- Deep Facility Address & Operating Details -->
          <div style="background: var(--surface-2); padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); margin: 10px 0; font-size: 12px; line-height: 1.5;">
            <div>📍 <strong>${I18N.t('facilityLabel')}</strong> ${r.fullAddress}</div>
            <div style="display: flex; justify-content: space-between; margin-top: 4px;">
              <span>📍 ${I18N.t('distanceLabel')} <strong>${r.liveDistanceKm !== null ? `${r.liveDistanceKm} km ✅` : `${r.distanceKm} km`}</strong></span>
              <span>📦 ${I18N.t('minBatchLabel')} <strong>${r.minLotKg} kg</strong></span>
            </div>
            <div style="color: var(--primary-dark); font-weight: 700; margin-top: 4px;">
              💳 ${r.paymentTerms}
            </div>
          </div>

          <!-- Live Recycler Collection Truck ETA & In-Transit Tracking -->
          <div style="background: var(--info-light); border: 1.5px solid var(--info-line); border-radius: var(--radius-sm); padding: 10px 12px; margin: 10px 0; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="color: var(--info); font-weight: 800;">🚚 ${I18N.t('dispatchEtaLabel')}</span>
              <span style="background: var(--info-light); color: var(--info); font-weight: 800; padding: 2px 8px; border-radius: 4px;">~${r.collectionTruckETA} mins</span>
            </div>
            <div style="color: var(--info); margin-top: 4px; font-size: 11.5px;">${r.collectionTruckStatus}</div>
            <div style="color: var(--text-muted); font-size: 11px; margin-top: 4px;">⚖️ <strong>${I18N.t('weighbridgeLabel')}</strong> ${r.weighbridgeTech}</div>
            <div style="color: var(--text-muted); font-size: 11px;">⏰ <strong>${I18N.t('gateHoursLabel')}</strong> ${r.operatingHours}</div>
          </div>

          <!-- Live Recycler Buying Rates (the platform's shared, real-time material rates) -->
          <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;">
            ${['PCB-HI', 'CU-WIRE', 'LI-BATT'].map(sym => {
              const mat = ESETU_DATA.materials.find(m => m.symbol === sym);
              if (!mat) return '';
              const effectiveRate = (r.rates && r.rates[sym]) || mat.recyclerRate;
              const isOverride = !!(r.rates && r.rates[sym]);
              return `
                <span style="background:var(--primary-light); color:var(--primary-dark); font-size:11.5px; padding:3px 7px; border-radius:4px; font-weight:700;" title="${isOverride ? I18N.t('recyclerPublishedRateTitle') : I18N.t('platformSharedRateTitle')}">
                  ${mat.symbol}: ₹${effectiveRate}/kg${isOverride ? ' ✦' : ''}
                </span>
              `;
            }).join('')}
          </div>
        </div>

        <div>
          <!-- Action Links: Google Maps & Create Lot -->
          <div style="display: flex; gap: 8px; flex-direction: column; margin-bottom: 10px;">
            <a href="${r.googleMapsUrl}" target="_blank" class="btn-secondary" style="width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; padding: 8px; text-decoration: none; border-color: var(--info); color: var(--info); font-weight: 700;">
              🗺️ ${I18N.t('openMapsBtn')}
            </a>
            <button class="btn-primary" style="width: 100%; padding: 8px; font-size: 12px;" onclick="openCreateLotModal('${r.id}', '${r.name}')">
              ${I18N.t('createLotBtn')}
            </button>
            <button class="btn-secondary" style="width: 100%; padding: 8px; font-size: 12px;" onclick="openConnectChatModal('${AppState.user.phone}', '${AppState.user.name}', '${r.id}', '${r.name}', 'kabadiwala', '${AppState.user.name}')">
              💬 ${I18N.t('connectAppBtn')}
            </button>
          </div>

          <div class="reviews-accordion">
            <div style="font-weight: 700; color: var(--text-muted); display: flex; justify-content: space-between;">
              <span>⭐ ${I18N.t('reviewsByKabadiwala')} (${r.kabadiwalaReviews.length})</span>
              <span style="color: var(--primary);">▼</span>
            </div>
            <div style="margin-top: 6px;">
              ${reviewsHtml}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    ${tabNavHtml}

    <!-- Top Balanced Section: Hero Metrics & Stockpile Breakdown -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; margin-bottom: 20px;">
      <!-- Hero Stockpile Analytics Card -->
      <div class="inventory-hero" style="margin-bottom: 0; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <span style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.9;">
                ${I18N.t('stockpileTitle')} (${AppState.user.yard || I18N.t('warehouseFallback')})
              </span>
              <div class="hero-metric" style="margin: 10px 0;">
                ${totalStockWeight} <span style="font-size: 20px; font-weight: 600;">${I18N.t('kgInStockUnit')}</span>
              </div>
            </div>
            <button class="audio-btn" style="background:#fff; color:var(--primary-dark);" onclick="I18N.speak(I18N.tf('inventorySpeech', { weight: '${totalStockWeight}', value: '${totalStockValue}', profit: '${totalEstimatedProfit}' }))">
              ${I18N.t('speakBtn')}
            </button>
          </div>
          <p style="font-size: 12.5px; opacity: 0.88; line-height: 1.4; margin-top: 4px;">
            ${I18N.t('aggregatedScrapDesc')}
          </p>
        </div>

        <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.25); display: flex; justify-content: space-between;">
          <div>
            <div style="font-size: 12px; opacity: 0.85;">${I18N.t('totalStockValue')}</div>
            <div style="font-size: 22px; font-weight: 900;">₹${totalStockValue.toLocaleString('en-IN')}</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 12px; opacity: 0.85;">${I18N.t('estMargin')}</div>
            <div style="font-size: 22px; font-weight: 900; color: var(--primary-line);">+₹${totalEstimatedProfit.toLocaleString('en-IN')} (28.4%)</div>
          </div>
        </div>
      </div>

      <!-- Warehouse Stockpile Breakdown Table Card -->
      <div class="card" style="margin-bottom: 0; padding: 18px; display: flex; flex-direction: column; justify-content: space-between;">
        <div class="card-header" style="margin-bottom: 10px; padding-bottom: 8px;">
          <div>
            <h3 class="card-title" style="font-size: 16px;">📦 ${I18N.t('warehouseBreakdownTitle')}</h3>
            <p class="card-subtitle" style="font-size: 12px;">${I18N.t('warehouseBreakdownSubtitle')}</p>
          </div>
        </div>
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 12.5px; text-align: left;">
            <thead>
              <tr style="border-bottom: 2px solid var(--border); color: var(--text-muted);">
                <th style="padding: 7px 6px;">${I18N.t('materialCol')}</th>
                <th style="padding: 7px 6px;">${I18N.t('weightCol')}</th>
                <th style="padding: 7px 6px;">${I18N.t('wholesaleCol')}</th>
                <th style="padding: 7px 6px;">${I18N.t('valueCol')}</th>
                <th style="padding: 7px 6px;">${I18N.t('marginCol')}</th>
              </tr>
            </thead>
            <tbody>
              ${stockRowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Doorstep pickups: Secure Payment to Collector (js/secure-payment.js) -->
    ${SecurePayment.dealerCardHtml()}

    <!-- Collection Route Optimizer & Smart Collection Day -->
    <div class="desktop-grid-2" style="gap: 16px; margin-bottom: 20px;">
      <div class="card" style="margin-bottom: 0;">
        <div class="card-header">
          <div>
            <h3 class="card-title">🗺️ ${I18N.t('routeOptimizerTitle')}</h3>
            <p class="card-subtitle">${I18N.t('routeOptimizerSubtitle')}</p>
          </div>
        </div>
        <button class="btn-primary" style="width: 100%; padding: 10px; font-size: 13px;" onclick="optimizeMyRoute()">
          🧭 ${I18N.t('optimizeRouteBtn')}
        </button>
        <div id="routeOptimizerResult" style="margin-top: 12px;"></div>
      </div>

      <div class="card" style="margin-bottom: 0;">
        <div class="card-header">
          <div>
            <h3 class="card-title">💰 ${I18N.t('poolingTitle')}</h3>
            <p class="card-subtitle">${I18N.t('poolingSubtitle')}</p>
          </div>
        </div>
        <button class="btn-secondary" style="width: 100%; padding: 9px; font-size: 12.5px;" onclick="loadPoolableBookings()">
          🔄 ${I18N.t('checkPoolableBtn')}
        </button>
        <div id="poolingResult" style="margin-top: 10px;"></div>
      </div>

      <div class="card" style="margin-bottom: 0;">
        <div class="card-header">
          <div>
            <h3 class="card-title">📅 ${I18N.t('collectionDayTitle')}</h3>
            <p class="card-subtitle">${I18N.t('collectionDaySubtitle')}</p>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">${I18N.t('areaPincodeLabel')}</label>
          <input type="text" id="scheduleAreaPincode" class="form-input" placeholder="e.g. 411038" value="${(AppState.user.location || '').match(/\d{6}/) ? (AppState.user.location.match(/\d{6}/))[0] : ''}">
        </div>
        <div class="form-group">
          <label class="form-label">${I18N.t('dayOfWeekLabel')}</label>
          <select id="scheduleDayOfWeek" class="form-input">
            <option value="1">${getDayNames()[1]}</option><option value="2">${getDayNames()[2]}</option><option value="3">${getDayNames()[3]}</option>
            <option value="4">${getDayNames()[4]}</option><option value="5">${getDayNames()[5]}</option><option value="6">${getDayNames()[6]}</option>
            <option value="0">${getDayNames()[0]}</option>
          </select>
        </div>
        <button class="btn-primary" style="width: 100%; padding: 10px; font-size: 13px;" onclick="setMyCollectionDay()">
          📌 ${I18N.t('setCollectionDayBtn')}
        </button>
        <div id="collectionDayResult" style="margin-top: 10px; font-size: 12.5px; color: var(--text-muted);"></div>
      </div>
    </div>

    <!-- Bottom Full-Width Section: Authorized Recyclers (3-Column Desktop Grid) -->
    <div class="card" style="padding: 20px;">
      <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <div>
          <h3 class="card-title">${I18N.t('wholesaleCompareTitle')}</h3>
          <p class="card-subtitle">${I18N.t('dispatchLotsSubtitle')}</p>
        </div>
        <span class="badge" style="background: var(--info-light); color: var(--info); font-weight: 700; padding: 6px 12px; font-size: 12px;">
          🟢 ${ESETU_DATA.recyclers.length} ${ESETU_DATA.recyclers.length === 1 ? I18N.t('recyclerSingular') : I18N.t('recyclerPlural')}
        </span>
      </div>

      ${ESETU_DATA.recyclers.length ? `
        <div class="desktop-grid-3" style="gap: 16px;">
          ${recyclersHtml}
        </div>
      ` : `
        <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
          <div style="font-size: 36px; margin-bottom: 8px;">🏭</div>
          <p style="font-size: 13.5px; font-weight: 700;">${I18N.t('noRecyclersYetShort')}</p>
          <p style="font-size: 12.5px; margin-top: 4px;">${I18N.t('noRecyclersRegisteredDesc')}</p>
        </div>
      `}
    </div>

    <!-- Modal Container -->
    <div id="lotModalContainer"></div>
  `;
  SecurePayment.loadDealerPickups();
}

// -------------------------------------------------------------
// SUB-PAGE 3: KABADIWALA PROFILE & DAILY COLLECTION COMPARISONS
// -------------------------------------------------------------
function renderKabadiwalaProfileTab(container, tabNavHtml) {
  const dealerName = AppState.user.name || 'Dealer';
  const yardName = AppState.user.yard || 'Scrap Yard';
  const dealerId = AppState.user.kabadiId || '—';
  const phone = AppState.user.phone || '—';
  const location = AppState.user.location || '—';

  // Calculate totals from daily collection history
  const totalWeeklyKg = ESETU_DATA.dailyCollectionHistory.reduce((sum, d) => sum + d.weightKg, 0);
  const totalWeeklyRev = ESETU_DATA.dailyCollectionHistory.reduce((sum, d) => sum + d.revenue, 0);
  const totalItemsCount = ESETU_DATA.dailyCollectionHistory.reduce((sum, d) => sum + d.itemsCount, 0);

  // Daily collection comparison rows
  const historyRowsHtml = ESETU_DATA.dailyCollectionHistory.map((item, idx) => {
    const isToday = idx === 0;
    const isUp = item.gainVsYesterday.includes('▲');
    const isDown = item.gainVsYesterday.includes('▼');
    const badgeColor = isUp ? 'var(--success)' : (isDown ? 'var(--danger)' : 'var(--text-muted)');
    const badgeBg = isUp ? 'var(--success-light)' : (isDown ? 'var(--danger-light)' : 'var(--surface-2)');

    // Visual percentage bar
    const barWidth = Math.round((item.weightKg / 200) * 100);

    return `
      <tr style="border-bottom: 1px solid var(--border); background: ${isToday ? 'var(--primary-light)' : 'transparent'};">
        <td style="padding: 12px 10px;">
          <strong>${item.day}</strong>
          <div style="font-size: 11.5px; color: var(--text-muted);">${item.date}</div>
        </td>
        <td style="padding: 12px 10px;">
          <div style="font-size: 15px; font-weight: 800; color: var(--primary-dark);">${item.weightKg} kg</div>
          <div style="background: var(--border); height: 6px; border-radius: 3px; width: 100px; margin-top: 4px;">
            <div style="background: var(--primary); height: 6px; border-radius: 3px; width: ${barWidth}%;"></div>
          </div>
        </td>
        <td style="padding: 12px 10px; font-weight: 600;">
          ${item.itemsCount} lots
        </td>
        <td style="padding: 12px 10px; font-weight: 800;">
          ₹${item.revenue.toLocaleString('en-IN')}
        </td>
        <td style="padding: 12px 10px;">
          <span style="background: ${badgeBg}; color: ${badgeColor}; font-weight: 800; font-size: 12px; padding: 3px 8px; border-radius: var(--radius-full);">
            ${item.gainVsYesterday}
          </span>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    ${tabNavHtml}

    <!-- 1. Dealer Profile Header Card -->
    <div class="card" style="border-left: 6px solid var(--primary); background: var(--card);">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px;">
        <div style="display: flex; gap: 16px; align-items: center;">
          <div style="font-size: 48px; background: var(--primary-light); width: 80px; height: 80px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; border: 2px solid var(--primary-line);">
            👨🏽‍💼
          </div>
          <div>
            <div style="display: flex; align-items: center; gap: 10px;">
              <h2 style="font-size: 22px; font-weight: 900; color: var(--text-main);">${dealerName}</h2>
              <span style="background: var(--success-light); color: var(--primary-dark); font-size: 11.5px; font-weight: 800; padding: 3px 10px; border-radius: var(--radius-full);">
                ✅ ${I18N.t('certifiedPartnerBadge')}
              </span>
            </div>
            <div style="font-size: 15px; font-weight: 700; color: var(--primary-dark); margin-top: 2px;">
              🏪 ${yardName}
            </div>
            <div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">
              📍 ${location} • 📞 ${phone} • ID: <code>${dealerId}</code>
            </div>
          </div>
        </div>

        <div style="text-align: right;">
          <span style="background: var(--info-light); color: var(--info); padding: 4px 12px; border-radius: var(--radius-full); font-size: 12.5px; font-weight: 700;">
            ⚖️ ${I18N.t('certifiedScaleBadge')}
          </span>
          <div style="margin-top: 8px; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;">
            <button class="audio-btn" onclick="I18N.speak(I18N.tf('dealerProfileSpeech', { name: '${dealerName}', yard: '${yardName}', weight: '${totalWeeklyKg}', count: '${totalItemsCount}' }))">
              ${I18N.t('speakBtn')}
            </button>
            <button class="btn-secondary" style="font-size: 12px; padding: 6px 12px;" onclick="resendPriceListSms('${dealerId}', '${phone}')">
              📩 ${I18N.t('resendSmsBtn')}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. Overview Metrics Cards -->
    <div class="desktop-grid-3">
      <div class="card" style="border-top: 4px solid var(--primary); text-align: center;">
        <div style="font-size: 12.5px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">${I18N.t('todaysInflowLabel')}</div>
        <div style="font-size: 32px; font-weight: 900; color: var(--primary); margin-top: 4px;">185 kg</div>
        <div style="font-size: 12px; color: var(--success); font-weight: 700; margin-top: 2px;">+30.2% ▲ ${I18N.t('higherThanYesterday')}</div>
      </div>

      <div class="card" style="border-top: 4px solid var(--info); text-align: center;">
        <div style="font-size: 12.5px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">${I18N.t('sevenDayVolumeLabel')}</div>
        <div style="font-size: 32px; font-weight: 900; color: var(--info); margin-top: 4px;">${totalWeeklyKg} kg</div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${I18N.t('processedAcrossPickups')} (${totalItemsCount})</div>
      </div>

      <div class="card" style="border-top: 4px solid var(--accent); text-align: center;">
        <div style="font-size: 12.5px; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">${I18N.t('sevenDayRealizationLabel')}</div>
        <div style="font-size: 32px; font-weight: 900; color: var(--accent); margin-top: 4px;">₹${totalWeeklyRev.toLocaleString('en-IN')}</div>
        <div style="font-size: 12px; color: var(--primary-dark); font-weight: 700; margin-top: 2px;">${I18N.t('avgGrossMarginLabel')}: 28.4%</div>
      </div>
    </div>

    <!-- 3. Day-by-Day Scrap Collection Comparison Table -->
    <div class="card">
      <div class="card-header">
        <div>
          <h3 class="card-title">📊 ${I18N.t('collectionComparisonTitle')}</h3>
          <p class="card-subtitle">${I18N.t('collectionComparisonSubtitle')}</p>
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13.5px; text-align: left;">
          <thead>
            <tr style="border-bottom: 2px solid var(--border); color: var(--text-muted); text-transform: uppercase; font-size: 12px;">
              <th style="padding: 10px;">${I18N.t('collectionDayCol')}</th>
              <th style="padding: 10px;">${I18N.t('scrapWeightCol')}</th>
              <th style="padding: 10px;">${I18N.t('pickupsCountCol')}</th>
              <th style="padding: 10px;">${I18N.t('estRevenueCol')}</th>
              <th style="padding: 10px;">${I18N.t('dayShiftCol')}</th>
            </tr>
          </thead>
          <tbody>
            ${historyRowsHtml || `<tr><td colspan="5" style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12.5px;">${I18N.t('noCollectionsYet')}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 4. Material Category Breakdown for this Dealer -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🔬 ${I18N.t('scrapStreamsBreakdownTitle')}</h3>
      </div>
      <div class="desktop-grid-2">
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div>
            <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:700;">
              <span>🔌 ${I18N.t('streamCopperWires')}</span>
              <span>38% (335 kg)</span>
            </div>
            <div style="background:var(--border); height:8px; border-radius:4px; margin-top:4px;">
              <div style="background:var(--primary); width:38%; height:8px; border-radius:4px;"></div>
            </div>
          </div>
          <div>
            <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:700;">
              <span>💻 ${I18N.t('streamHighGradePcbs')}</span>
              <span>28% (248 kg)</span>
            </div>
            <div style="background:var(--border); height:8px; border-radius:4px; margin-top:4px;">
              <div style="background:var(--info); width:28%; height:8px; border-radius:4px;"></div>
            </div>
          </div>
          <div>
            <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:700;">
              <span>🔋 ${I18N.t('streamLithiumBatteries')}</span>
              <span>15% (132 kg)</span>
            </div>
            <div style="background:var(--border); height:8px; border-radius:4px; margin-top:4px;">
              <div style="background:var(--accent); width:15%; height:8px; border-radius:4px;"></div>
            </div>
          </div>
          <div>
            <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:700;">
              <span>📺 ${I18N.t('streamCrtDisplayGlass')}</span>
              <span>19% (168 kg)</span>
            </div>
            <div style="background:var(--border); height:8px; border-radius:4px; margin-top:4px;">
              <div style="background:var(--plum); width:19%; height:8px; border-radius:4px;"></div>
            </div>
          </div>
        </div>

        <div style="background: var(--surface-2); border: 1.5px solid var(--border); padding: 16px; border-radius: var(--radius-sm); font-size: 13px; line-height: 1.6;">
          <h4 style="font-weight: 800; color: var(--primary-dark); margin-bottom: 6px;">♻️ ${I18N.t('formalChannelAdvantageTitle')}</h4>
          <p>${I18N.tf('formalChannelIntro', { weight: totalWeeklyKg, yard: yardName })}</p>
          <ul style="padding-left: 18px; margin-top: 6px; color: var(--text-muted);">
            <li>${I18N.t('advantageHigherEarnings')}</li>
            <li>${I18N.t('advantageZeroHarassment')}</li>
            <li>${I18N.t('advantageDocumentedManifests')}</li>
          </ul>
        </div>
      </div>
    </div>
  `;
}

  // Window helper for lot creation modal
  window.openCreateLotModal = (recyclerId, recyclerName) => {
    const modalEl = document.getElementById('lotModalContainer');
    const lotNo = `LOT-REC-2026-${Math.floor(1000 + Math.random() * 9000)}`;
    const firstMat = ESETU_DATA.materials[0];

    modalEl.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-content">
          <button class="modal-close" onclick="closeLotModal()">✕</button>

          <h3 style="font-size: 18px; font-weight: 800; color: var(--primary-dark); margin-bottom: 4px;">
            📄 ${I18N.t('createLotManifestTitle')}
          </h3>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
            ${I18N.t('targetRecyclerLabel')} <strong>${recyclerName}</strong>
          </p>

          <div style="background: var(--surface-2); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); font-size: 12.5px; margin-bottom: 14px;">
            <div>${I18N.t('lotReferenceLabel')} <strong>${lotNo}</strong></div>
            <div id="modalGpsLine">${I18N.t('gpsHandoverCoordsLabel')} <strong>📡 ${I18N.t('locatingGps')}</strong></div>
            <div>${I18N.t('timestampLabel')} <strong>${new Date().toLocaleString()}</strong></div>
          </div>

          <div class="form-group">
            <label class="form-label">${I18N.t('materialStreamLabel')}</label>
            <select id="modalMatSelect" class="form-input" onchange="onLotModalMaterialChange()">
              ${ESETU_DATA.materials.map(m => `
                <option value="${m.id}" data-rate="${m.recyclerRate}">${m.icon} ${m.name} (₹${m.recyclerRate}/kg)</option>
              `).join('')}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">${I18N.t('netLotWeightLabel')}</label>
            <input type="number" id="modalWeightInput" class="form-input" value="100">
          </div>

          <div class="form-group">
            <label class="form-label">${I18N.t('proposedRateLabel')} (₹/kg):</label>
            <input type="number" id="modalRateInput" class="form-input" value="${firstMat.recyclerRate}" oninput="onLotModalRateChange()">
            <div id="fairPriceBadge" style="margin-top: 6px;"></div>
          </div>

          <div class="form-group">
            <label class="form-label">${I18N.t('settlementModeLabel')}</label>
            <select id="modalPaySelect" class="form-input">
              <option value="Cash at Gate">💵 ${I18N.t('payCashAtGateOpt')}</option>
              <option value="Same-day RTGS">🏦 ${I18N.t('paySameDayRtgsOpt')}</option>
              <option value="Instant UPI">📱 ${I18N.t('payInstantUpiOpt')}</option>
            </select>
          </div>

          <!-- Digital QR Handover Manifest -->
          <div style="background: var(--info-light); border: 1.5px dashed var(--info); padding: 16px; border-radius: var(--radius-sm); text-align: center; margin: 16px 0;">
            <div style="font-size: 13px; font-weight: 800; color: var(--info); margin-bottom: 8px;">
              📱 ${I18N.t('qrSlipTitle')}
            </div>
            <div style="background: #fff; width: 140px; height: 140px; margin: 0 auto; display: flex; align-items: center; justify-content: center; border: 2px solid #000; font-family: monospace; font-size: 11px; padding: 6px;">
              [QR: ${lotNo}]<br>
              ${I18N.t('cpcbTraceableLabel')}
            </div>
            <p style="font-size: 11.5px; color: var(--info); margin-top: 8px;">
              ${I18N.t('qrSlipDesc')}
            </p>
          </div>

          <button class="btn-primary" onclick="confirmLotCreation('${lotNo}', '${recyclerId}', '${recyclerName}')">
            ✅ ${I18N.t('dispatchLotBtn')}
          </button>
        </div>
      </div>
    `;

    AppState.lotModalGps = null;
    getBrowserCoordinates().then((coords) => {
      const gpsLine = document.getElementById('modalGpsLine');
      if (!gpsLine) return; // modal already closed
      if (coords) {
        AppState.lotModalGps = coords;
        gpsLine.innerHTML = `${I18N.t('gpsHandoverCoordsLabel')} <strong>${coords.latitude.toFixed(5)}° N, ${coords.longitude.toFixed(5)}° E</strong> ✅`;
      } else {
        gpsLine.innerHTML = `${I18N.t('gpsHandoverCoordsLabel')} <strong>${I18N.t('gpsUnavailableFallback')}</strong>`;
      }
    });

    onLotModalRateChange();
  };

  window.onLotModalMaterialChange = () => {
    const sel = document.getElementById('modalMatSelect');
    const opt = sel.options[sel.selectedIndex];
    const rate = Number(opt.dataset.rate);
    document.getElementById('modalRateInput').value = rate;
    onLotModalRateChange();
  };

  // Fair Price Detector — live badge as the kabadiwala edits the proposed rate.
  window.onLotModalRateChange = () => {
    const sel = document.getElementById('modalMatSelect');
    const mat = ESETU_DATA.materials.find(m => m.id === sel.value) || ESETU_DATA.materials[0];
    const proposedRate = Number(document.getElementById('modalRateInput').value) || 0;
    const badgeEl = document.getElementById('fairPriceBadge');
    if (!badgeEl) return;

    const { status, deviationPct } = PriceUtils.evaluateFairPrice(proposedRate, mat.recyclerRate);
    const styles = {
      fair: { bg: 'var(--success-light)', color: 'var(--primary-dark)', label: `✅ ${I18N.t('fairPriceFair')}` },
      low: { bg: 'var(--danger-light)', color: 'var(--danger)', label: `⚠️ ${I18N.t('fairPriceLow')} (${deviationPct}%)` },
      high: { bg: 'var(--accent-light)', color: 'var(--accent-ink)', label: `⚠️ ${I18N.t('fairPriceHigh')} (+${deviationPct}%)` }
    }[status];

    badgeEl.innerHTML = `
      <span style="font-size: 11.5px; background: ${styles.bg}; color: ${styles.color}; padding: 3px 9px; border-radius: 4px; font-weight: 800;">
        ${styles.label}
      </span>
      <span style="font-size: 11px; color: var(--text-muted); margin-left: 6px;">${I18N.t('benchmarkLabel')} ₹${mat.recyclerRate}/kg</span>
    `;
  };

  window.closeLotModal = () => {
    document.getElementById('lotModalContainer').innerHTML = '';
  };

  window.confirmLotCreation = async (lotNo, recyclerId, recyclerName) => {
    const matId = document.getElementById('modalMatSelect').value;
    const weight = Number(document.getElementById('modalWeightInput').value) || 50;
    const payMode = document.getElementById('modalPaySelect').value;
    const proposedRate = Number(document.getElementById('modalRateInput').value) || 0;
    const gps = AppState.lotModalGps;

    try {
      const newLot = await API.createLot({
        kabadiwalaId: AppState.user.phone,
        kabadiwalaName: AppState.user.name,
        recyclerId, recyclerName,
        materialId: matId, weightKg: weight, paymentMethod: payMode,
        agreedRate: proposedRate,
        gpsLat: gps ? gps.latitude : undefined, gpsLng: gps ? gps.longitude : undefined
      });

      ESETU_DATA.lots.unshift(newLot);
      closeLotModal();
      alert(`✅ ${I18N.tf('lotGeneratedMsg', { lotId: newLot.lotId, name: recyclerName })}`);
      I18N.speak(I18N.tf('lotSentSpeech', { name: recyclerName }));
      renderKabadiwalaPage(container);
    } catch (err) {
      alert(`❌ ${I18N.tf('couldNotCreateLotMsg', { error: err.message })}`);
    }
  };

// Collection Route Optimizer — greedy nearest-neighbor ordering of this kabadiwala's
// pending customer_bookings, starting from the kabadiwala's own registered location.
window.optimizeMyRoute = async () => {
  const resultEl = document.getElementById('routeOptimizerResult');
  resultEl.innerHTML = `<div style="font-size:12px; color:var(--text-muted);">${I18N.t('loadingPendingPickups')}</div>`;

  try {
    const kabadiwalaId = ESETU_DATA.kabadiwalas.find(k => k.phone === AppState.user.phone)?.id || AppState.user.phone;
    const bookings = await API.listBookings({ kabadiwalaId, status: 'Requested' });
    const stopsWithCoords = bookings.filter(b => typeof b.gpsLat === 'number' && typeof b.gpsLng === 'number')
      .map(b => ({ ...b, latitude: b.gpsLat, longitude: b.gpsLng }));

    if (!stopsWithCoords.length) {
      resultEl.innerHTML = `<div style="font-size:12.5px; color:var(--text-muted);">${I18N.t('noPendingPickups')}</div>`;
      return;
    }

    const start = AppState.myCoords || { latitude: stopsWithCoords[0].latitude, longitude: stopsWithCoords[0].longitude };
    const ordered = GeoUtils.nearestNeighborRoute(start, stopsWithCoords);

    const listHtml = ordered.map((stop, idx) => `
      <div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border); font-size:12.5px;">
        <span>${idx + 1}. ${stop.customerName || I18N.t('genericCustomerLabel')} — ${stop.materialName}</span>
        <span style="color:var(--text-muted);">${stop.distanceFromPrevKm !== null ? `${stop.distanceFromPrevKm} km` : '—'}</span>
      </div>
    `).join('');

    const waypoints = ordered.map(s => `${s.latitude},${s.longitude}`).join('|');
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${ordered[ordered.length - 1].latitude},${ordered[ordered.length - 1].longitude}&waypoints=${encodeURIComponent(waypoints)}`;

    resultEl.innerHTML = `
      ${listHtml}
      <a href="${mapsUrl}" target="_blank" class="btn-secondary" style="display:block; text-align:center; margin-top:10px; padding:8px; font-size:12.5px; text-decoration:none;">
        🗺️ ${I18N.t('openMultiStopBtn')}
      </a>
    `;
  } catch (err) {
    resultEl.innerHTML = `<div style="color:var(--danger); font-size:12.5px;">❌ ${err.message}</div>`;
  }
};

// Better Earnings (load pooling) — group this kabadiwala's completed-but-not-yet-pooled
// customer bookings by material, so 2+ small pickups can be combined into one wholesale
// lot at a small consolidation bonus instead of dispatching each individually.
window.loadPoolableBookings = async () => {
  const resultEl = document.getElementById('poolingResult');
  resultEl.innerHTML = `<div style="font-size:12px; color:var(--text-muted);">${I18N.t('loadingLabel')}</div>`;

  try {
    const kabadiwalaId = ESETU_DATA.kabadiwalas.find(k => k.phone === AppState.user.phone)?.id || AppState.user.phone;
    const bookings = await API.listBookings({ kabadiwalaId, status: 'Completed' });
    const poolable = bookings.filter(b => !b.pooledLotId);

    const groups = {};
    poolable.forEach(b => { (groups[b.materialId] = groups[b.materialId] || []).push(b); });
    const groupEntries = Object.entries(groups).filter(([, list]) => list.length >= 2);

    if (!groupEntries.length) {
      resultEl.innerHTML = `<div style="font-size:12.5px; color:var(--text-muted);">${I18N.t('noPoolableGroups')}</div>`;
      return;
    }

    resultEl.innerHTML = groupEntries.map(([materialId, list]) => {
      const totalWeight = list.reduce((s, b) => s + b.weightKg, 0);
      return `
        <div style="background:var(--surface-2); border:1px solid var(--border); border-radius:6px; padding:8px 10px; margin-bottom:6px; font-size:12px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <span>${list[0].materialName} — ${list.length} ${I18N.t('pickupsUnit')} (${totalWeight.toFixed(2)} kg)</span>
          <button class="btn-primary" style="padding:5px 10px; font-size:11.5px; width:auto;" onclick='poolTheseRequests(${JSON.stringify(list.map(b => b.id))})'>
            ${I18N.t('poolBtn')}
          </button>
        </div>
      `;
    }).join('');
  } catch (err) {
    resultEl.innerHTML = `<div style="color:var(--danger); font-size:12px;">❌ ${err.message}</div>`;
  }
};

window.poolTheseRequests = async (bookingIds) => {
  const recycler = ESETU_DATA.recyclers[0];
  if (!recycler) return alert(I18N.t('noRecyclersToDispatchAlert'));
  try {
    const kabadiwalaId = ESETU_DATA.kabadiwalas.find(k => k.phone === AppState.user.phone)?.id || AppState.user.phone;
    const lot = await API.poolBookingsIntoLot({
      bookingIds, kabadiwalaId, kabadiwalaName: AppState.user.name,
      recyclerId: recycler.id, recyclerName: recycler.name, paymentMethod: 'Cash at Gate'
    });
    alert(`✅ ${I18N.tf('pooledSuccessMsg', { lotId: lot.lotId, weight: lot.weightKg.toFixed(2), rate: lot.agreedRate.toFixed(0) })}`);
    loadPoolableBookings();
  } catch (err) {
    alert(`❌ ${I18N.tf('couldNotPoolMsg', { error: err.message })}`);
  }
};

// Smart Collection Day
window.setMyCollectionDay = async () => {
  const pincode = document.getElementById('scheduleAreaPincode').value.trim();
  const dayOfWeek = Number(document.getElementById('scheduleDayOfWeek').value);
  const resultEl = document.getElementById('collectionDayResult');
  if (!pincode) { resultEl.textContent = I18N.t('enterPincodeFirstAlert'); return; }

  try {
    const kabadiwalaId = ESETU_DATA.kabadiwalas.find(k => k.phone === AppState.user.phone)?.id || AppState.user.phone;
    await API.createCollectionSchedule({ kabadiwalaId, kabadiwalaName: AppState.user.name, areaPincode: pincode, dayOfWeek });
    const dayNames = getDayNames();
    resultEl.innerHTML = `<span style="color:var(--success); font-weight:700;">✅ ${I18N.tf('collectionDaySetMsg', { day: dayNames[dayOfWeek], pincode })}</span>`;
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--danger);">❌ ${err.message}</span>`;
  }
};

// -------------------------------------------------------------
// STEP 4: RECYCLER PORTAL (CPCB EPR COMPLIANCE & RATES)
// -------------------------------------------------------------
function renderRecyclerPage(container) {
  markView('recycler');
  const lotsHtml = ESETU_DATA.lots.map(lot => {
    const isPaid = lot.paymentStatus === 'Paid';
    const isVerified = lot.eprCertIssued;

    // Transparent Pricing / Fraud-Free Payments: compare the rate this lot was locked at
    // against the material's CURRENT benchmark rate (which may have moved since the lot
    // was created) — reuses the same PriceUtils.evaluateFairPrice used by the Fair Price
    // Detector in the Create Lot modal.
    const benchmarkMat = ESETU_DATA.materials.find(m => m.symbol === lot.symbol);
    const fairCheck = benchmarkMat ? PriceUtils.evaluateFairPrice(lot.agreedRate, benchmarkMat.recyclerRate) : null;
    const fraudBadge = (fairCheck && fairCheck.status !== 'fair') ? `
      <span style="font-size: 10.5px; background: var(--danger-light); color: var(--danger); padding: 2px 7px; border-radius: 4px; font-weight: 800; margin-left: 6px;">
        ⚠️ ${I18N.t('rateFlaggedBadge')} (${fairCheck.deviationPct}%)
      </span>
    ` : '';

    return `
      <div class="card" style="border-left: 5px solid ${isPaid ? 'var(--success)' : 'var(--accent)'}; margin-bottom: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <span style="font-size: 11.5px; background: var(--info-light); color: var(--info); padding: 3px 8px; border-radius: 4px; font-weight: 800;">
              ${lot.lotId}
            </span>
            <h4 style="font-size: 15px; font-weight: 800; margin-top: 5px;">${lot.material}${fraudBadge}</h4>
            <div style="font-size: 12.5px; color: var(--text-muted);">
              ${I18N.t('collectorLabel')} <strong>${lot.kabadiwalaName}</strong> (${lot.date})
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 17px; font-weight: 900; color: var(--primary-dark);">
              ₹${lot.totalAmount.toLocaleString('en-IN')}
            </div>
            <span style="font-size: 12px; font-weight: 700; color: ${isPaid ? 'var(--success)' : 'var(--accent)'};">
              ● ${lot.paymentStatus}
            </span>
          </div>
        </div>

        <div style="background: var(--surface-2); padding: 10px 12px; border-radius: var(--radius-sm); margin: 10px 0; font-size: 12px;">
          <div>${I18N.t('netWeightLabel')} <strong>${lot.weightKg} kg</strong> @ ₹${lot.agreedRate}/kg${benchmarkMat ? ` <span style="color:var(--text-muted); font-weight:normal;">(${I18N.t('benchmarkLabel')} ₹${benchmarkMat.recyclerRate}/kg)</span>` : ''}</div>
          <div>${I18N.t('settlementLabel')} <strong>${lot.paymentMethod}</strong></div>
          <div>${I18N.t('gpsOriginLabel')} <strong>${lot.gpsLocation}</strong></div>
          <div>${I18N.t('cpcbManifestLabel')} <strong>${lot.cpcbManifestNo}</strong></div>
        </div>

        <div style="display: flex; gap: 10px; margin-top: 12px;">
          ${!isPaid ? `
            <button class="btn-primary" style="flex:1; padding: 10px; font-size: 13px;" onclick="confirmRecyclerPayment('${lot.lotId}')">
              ${I18N.t('verifyWeightBtn')}
            </button>
          ` : ''}

          <button class="btn-secondary" style="flex:1; padding: 10px; font-size: 13px;" onclick="viewEprCertificate('${lot.lotId}')">
            ${isVerified ? '📜 ' + I18N.t('viewCertBtn') : I18N.t('issueCertBtn')}
          </button>

          <button class="btn-secondary" style="flex:1; padding: 10px; font-size: 13px;" onclick="openConnectChatModal('${lot.kabadiwalaId}', '${lot.kabadiwalaName}', '${lot.recyclerId}', '${lot.recyclerName}', 'recycler', '${AppState.user.name}')">
            💬 ${I18N.t('connectBtnShort')}
          </button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <!-- Verified CPCB License Banner -->
    <div style="background: var(--info-light); border: 2px solid var(--info); border-radius: var(--radius-md); padding: 18px 24px; margin-bottom: 20px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 32px;">🛡️</span>
          <div>
            <div style="font-size: 12px; font-weight: 800; color: var(--info); text-transform: uppercase;">
              ${I18N.t('govBadgeText')}
            </div>
            <div style="font-size: 16px; font-weight: 800; color: var(--info);">
              ${AppState.user.name}
            </div>
            <div style="font-size: 12px; color: var(--info); font-family: monospace;">
              ${I18N.t('govRegIdLabel')} ${AppState.user.govRegNo || '—'}
            </div>
          </div>
        </div>
        <button class="audio-btn" onclick="I18N.speak(I18N.t('recyclerPortalSpeech'))">
          ${I18N.t('speakBtn')}
        </button>
      </div>
    </div>

    <!-- 2-Column Responsive Layout -->
    <div class="desktop-grid-2">
      <!-- Left: Incoming Lots & Weighbridge -->
      <div>
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">${I18N.t('incomingLotsTitle')}</h3>
              <p class="card-subtitle">${I18N.t('incomingLotsSubtitle')}</p>
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="refreshRecyclerLots()">
                🔄 ${I18N.t('refreshBtn')}
              </button>
              <button class="audio-btn" onclick="I18N.speak('${I18N.t('incomingLotsTitle')}')">
                ${I18N.t('speakBtn')}
              </button>
            </div>
          </div>

          <div>
            ${ESETU_DATA.lots.length ? lotsHtml : `
              <div style="text-align: center; padding: 36px 20px; color: var(--text-muted);">
                <div style="font-size: 34px; margin-bottom: 8px;">📭</div>
                <p style="font-size: 13.5px; font-weight: 700;">${I18N.t('noIncomingLotsTitle')}</p>
                <p style="font-size: 12.5px; margin-top: 4px;">${I18N.t('noIncomingLotsDesc')}</p>
              </div>
            `}
          </div>
        </div>
      </div>

      <!-- Right: Wholesale Rate Manager -->
      <div>
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">${I18N.t('updateRatesTitle')}</h3>
              <p class="card-subtitle">${I18N.t('updateRatesSubtitle')}</p>
            </div>
          </div>

          <div style="display: flex; flex-direction: column; gap: 10px;">
            ${ESETU_DATA.materials.map(m => `
              <div style="background: var(--surface-2); border: 1px solid var(--border); padding: 12px 16px; border-radius: var(--radius-sm); font-size: 13.5px; display: flex; justify-content: space-between; align-items: center;">
                <div style="font-weight: 700;">${m.icon} ${getLocalizedMatName(m)} (${m.symbol})</div>
                <div style="display: flex; align-items: center; gap: 12px;">
                  <span style="color: var(--primary-text); font-weight: 900; font-size: 15px;">₹${m.recyclerRate}/kg</span>
                  <button class="btn-secondary" style="padding: 4px 10px; font-size: 12px;" onclick="promptRateUpdate('${m.id}')">
                    ${I18N.t('editRateBtn')}
                  </button>
                  <button class="btn-secondary" style="padding: 4px 10px; font-size: 12px; border-color:var(--plum); color:var(--plum);" onclick="promptOwnRateUpdate('${m.id}')" title="${I18N.t('ownRateHint')}">
                    🏆 ${I18N.t('setOwnRateBtn')}
                  </button>
                </div>
              </div>
            `).join('')}
          </div>

          <div style="margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);">
            <button class="btn-primary" style="width: 100%; padding: 10px; font-size: 13px;" onclick="triggerDailyPriceBroadcast()">
              📩 ${I18N.t('broadcastBtn')}
            </button>
            <p style="font-size: 11px; color: var(--text-muted); margin-top: 6px; text-align: center;">
              ${I18N.t('broadcastNote')}
            </p>
          </div>
        </div>
      </div>
    </div>

    <div id="certModalContainer"></div>
  `;

  // Window helpers for recycler actions
  window.confirmRecyclerPayment = async (lotId) => {
    // Fraud/Underpayment Alert — block a silent confirm if the locked lot rate has drifted
    // from the material's current benchmark rate beyond the tolerance band; require an
    // explicit acknowledgement before proceeding (the check itself never blocks a fair lot).
    const lot = ESETU_DATA.lots.find(l => l.lotId === lotId);
    const benchmarkMat = lot && ESETU_DATA.materials.find(m => m.symbol === lot.symbol);
    if (lot && benchmarkMat) {
      const { status, deviationPct } = PriceUtils.evaluateFairPrice(lot.agreedRate, benchmarkMat.recyclerRate);
      if (status !== 'fair') {
        const direction = status === 'low' ? 'BELOW' : 'ABOVE';
        const proceed = confirm(
          `⚠️ Fraud/Underpayment Alert\n\nThis lot was locked at ₹${lot.agreedRate}/kg, which is ${Math.abs(deviationPct)}% ${direction} the current benchmark rate of ₹${benchmarkMat.recyclerRate}/kg.\n\nConfirm you have reviewed this and still want to proceed with payment?`
        );
        if (!proceed) return;
      }
    }

    try {
      const updated = await API.confirmLotPayment(lotId);
      const idx = ESETU_DATA.lots.findIndex(l => l.lotId === lotId);
      if (idx !== -1) ESETU_DATA.lots[idx] = updated;
      alert(`✅ ${I18N.tf('paymentApprovedMsg', { lotId, amount: updated.totalAmount.toLocaleString('en-IN') })}`);
      I18N.speak(I18N.tf('paymentConfirmedSpeech', { lotId }));
      renderRecyclerPage(container);
    } catch (err) {
      alert(`❌ ${I18N.tf('couldNotConfirmPaymentMsg', { error: err.message })}`);
    }
  };

  // Best Buyer Finder — a recycler publishing their own rate for one material, which then
  // competes for the "🏆 Best Payer" badge on the kabadiwala's Warehouse & Recyclers tab.
  window.promptOwnRateUpdate = async (matId) => {
    const mat = ESETU_DATA.materials.find(m => m.id === matId);
    const myRecord = ESETU_DATA.recyclers.find(r => r.cpcbRegNo === AppState.user.govRegNo);
    if (!mat || !myRecord) { alert(I18N.t('couldNotFindRecyclerRecordAlert')); return; }

    const current = (myRecord.rates && myRecord.rates[mat.symbol]) || mat.recyclerRate;
    const newRate = prompt(I18N.tf('publishOwnRatePrompt', { name: mat.name }), current);
    if (newRate && !isNaN(newRate)) {
      try {
        await API.updateRecyclerOwnRate(myRecord.id, matId, Number(newRate));
        const fresh = await API.bootstrap();
        Object.assign(ESETU_DATA, fresh);
        alert(`✅ ${I18N.tf('ratePublishedMsg', { symbol: mat.symbol, rate: newRate })}`);
        renderRecyclerPage(container);
      } catch (err) {
        alert(`❌ ${I18N.tf('couldNotPublishRateMsg', { error: err.message })}`);
      }
    }
  };

  window.promptRateUpdate = async (matId) => {
    const mat = ESETU_DATA.materials.find(m => m.id === matId);
    if (!mat) return;
    const newRate = prompt(I18N.tf('enterNewRatePrompt', { name: mat.name }), mat.recyclerRate);
    if (newRate && !isNaN(newRate)) {
      try {
        const updated = await API.updateMaterialRate(matId, { recyclerRate: Number(newRate) });
        Object.assign(mat, updated);
        alert(`✅ ${I18N.tf('rateUpdatedMsg', { symbol: mat.symbol, rate: newRate })}`);
        renderRecyclerPage(container);
      } catch (err) {
        alert(`❌ ${I18N.tf('couldNotUpdateRateMsg', { error: err.message })}`);
      }
    }
  };

  window.triggerDailyPriceBroadcast = async () => {
    try {
      const result = await API.triggerDailyPriceListBroadcast();
      alert(`📩 ${I18N.tf('priceSmsBroadcastMsg', { sent: result.sentCount, total: result.total })}`);
    } catch (err) {
      alert(`❌ ${I18N.tf('broadcastFailedMsg', { error: err.message })}`);
    }
  };

  window.refreshRecyclerLots = async () => {
    ESETU_DATA.lots = await API.listLots();
    renderRecyclerPage(container);
  };

  window.viewEprCertificate = (lotId) => {
    const lot = ESETU_DATA.lots.find(l => l.lotId === lotId);
    if (!lot) return;

    const certContainer = document.getElementById('certModalContainer');
    certContainer.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-content" style="border-top: 6px solid var(--success); max-width: 500px;">
          <button class="modal-close" onclick="document.getElementById('certModalContainer').innerHTML=''">✕</button>
          
          <div style="text-align: center; margin-bottom: 14px;">
            <div style="font-size: 36px;">📜</div>
            <h3 style="font-size: 17px; font-weight: 900; color: var(--primary-dark);">
              ${I18N.t('govOfIndiaCertTitle')}
            </h3>
            <div style="font-size: 11.5px; color: var(--text-muted);">
              ${I18N.t('eWasteRulesSubtitle')}
            </div>
          </div>

          <div style="background: var(--surface-2); border: 1.5px solid var(--border); padding: 14px; border-radius: var(--radius-sm); font-size: 13px; line-height: 1.6;">
            <div><strong>${I18N.t('certificateIdLabel')}</strong> CPCB-EPR-CERT-${lot.lotId}</div>
            <div><strong>${I18N.t('authorizedRecyclerLabel')}</strong> ${AppState.user.name}</div>
            <div><strong>${I18N.t('cpcbRegNoLabel')}</strong> ${AppState.user.govRegNo || '—'}</div>
            <div><strong>${I18N.t('sourceCollectorLabel')}</strong> ${lot.kabadiwalaName}</div>
            <div><strong>${I18N.t('materialStreamLabel')}</strong> ${lot.material}</div>
            <div><strong>${I18N.t('netVerifiedWeightLabel')}</strong> ${lot.weightKg} kg</div>
            <div><strong>${I18N.t('gpsGeotagLabel')}</strong> ${lot.gpsLocation}</div>
            <div><strong>${I18N.t('dateTimestampLabel')}</strong> ${lot.date}</div>
            <div><strong>${I18N.t('auditStatusLabel')}</strong> <span style="color: var(--success); font-weight: 800;">${I18N.t('verifiedAndPaidStatus')}</span></div>
          </div>

          <div style="margin-top: 16px; text-align: center;">
            <button class="btn-primary" onclick="alert(I18N.t('certPdfGeneratedAlert')); document.getElementById('certModalContainer').innerHTML='';">
              🖨️ ${I18N.t('downloadCertPdfBtn')}
            </button>
          </div>
        </div>
      </div>
    `;
  };
}

// -------------------------------------------------------------
// E-WASTE HOTSPOT MAP (Leaflet + OpenStreetMap tiles via CDN)
// -------------------------------------------------------------
let hotspotLeafletMap = null;

window.openHotspotMap = () => {
  let modalContainer = document.getElementById('hotspotMapOverlay');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'hotspotMapOverlay';
    document.body.appendChild(modalContainer);
  }

  modalContainer.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 700px;">
        <button class="modal-close" onclick="closeHotspotMap()">✕</button>
        <h3 style="font-size: 17px; font-weight: 800; color: var(--primary-dark); margin-bottom: 4px;">
          🗺️ ${I18N.t('hotspotMapTitle')}
        </h3>
        <p style="font-size: 11.5px; color: var(--text-muted); margin-bottom: 10px;">⚠️ ${I18N.t('hotspotMapOfflineNotice')}</p>
        <div id="hotspotMapDiv" style="width: 100%; height: 380px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--border);"></div>
      </div>
    </div>
  `;

  if (typeof L === 'undefined') {
    document.getElementById('hotspotMapDiv').innerHTML = `
      <div style="display:flex; align-items:center; justify-content:center; height:100%; text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">
        📴 ${I18N.t('mapTilesUnavailable')}
      </div>
    `;
    return;
  }

  // Collect every coordinate the platform actually has: dealers, recyclers, and completed
  // pickups/lots — real registered/transaction data, not decorative placeholder pins.
  const points = [];
  ESETU_DATA.kabadiwalas.forEach(k => { if (typeof k.latitude === 'number') points.push({ lat: k.latitude, lng: k.longitude, label: `🚲 ${k.name} (${I18N.t('dealerMapLabel')})`, color: '#2c7a47' }); });
  ESETU_DATA.recyclers.forEach(r => { if (typeof r.latitude === 'number') points.push({ lat: r.latitude, lng: r.longitude, label: `🏭 ${r.name} (${I18N.t('recyclerMapLabel')})`, color: '#2d4f86' }); });
  ESETU_DATA.lots.forEach(l => { if (typeof l.gpsLat === 'number') points.push({ lat: l.gpsLat, lng: l.gpsLng, label: `📦 ${I18N.t('lotMapLabel')} ${l.lotId}`, color: '#6d3f7d' }); });

  const center = points.length
    ? [points.reduce((s, p) => s + p.lat, 0) / points.length, points.reduce((s, p) => s + p.lng, 0) / points.length]
    : [20.5937, 78.9629]; // India center fallback when no real coordinates exist yet

  setTimeout(() => {
    if (hotspotLeafletMap) { hotspotLeafletMap.remove(); hotspotLeafletMap = null; }
    hotspotLeafletMap = L.map('hotspotMapDiv').setView(center, points.length ? 11 : 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 18
    }).addTo(hotspotLeafletMap);

    // Simple density coloring: a point near others gets a bigger, more opaque marker —
    // a lightweight stand-in for a full heatmap without adding a second CDN dependency.
    points.forEach((p) => {
      const nearbyCount = points.filter(o => GeoUtils.haversineKm(p.lat, p.lng, o.lat, o.lng) < 3).length;
      L.circleMarker([p.lat, p.lng], {
        radius: 6 + Math.min(nearbyCount, 5) * 2,
        color: p.color, fillColor: p.color, fillOpacity: 0.5, weight: 2
      }).addTo(hotspotLeafletMap).bindPopup(p.label);
    });
  }, 50); // let the modal DOM node exist before Leaflet measures its container
};

window.closeHotspotMap = () => {
  if (hotspotLeafletMap) { hotspotLeafletMap.remove(); hotspotLeafletMap = null; }
  const el = document.getElementById('hotspotMapOverlay');
  if (el) el.innerHTML = '';
};

// -------------------------------------------------------------
// SAFETY & HAZARD GUIDANCE MODAL
// -------------------------------------------------------------
window.openSafetyModal = () => {
  let modalContainer = document.getElementById('safetyModalOverlay');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'safetyModalOverlay';
    document.body.appendChild(modalContainer);
  }

  const cardsHtml = ESETU_DATA.safetyGuides.map(guide => {
    const title = localizedField(guide, 'title');
    const audioScript = localizedField(guide, 'audioScript');
    const hazard = localizedField(guide, 'hazard');
    const healthRisk = localizedField(guide, 'healthRisk');
    const safeMethod = localizedField(guide, 'safeMethod');

    return `
      <div style="border-left: 5px solid ${guide.color}; background: var(--surface-2); padding: 14px; border-radius: var(--radius-sm); margin-bottom: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <h4 style="font-size: 14.5px; font-weight: 800; color: ${guide.color};">
            ${guide.icon} ${title}
          </h4>
          <button class="audio-btn" onclick="I18N.speak('${audioScript.replace(/'/g, "\\'")}')">
            ${I18N.t('speakBtn')}
          </button>
        </div>
        <div style="font-size: 12.5px; margin-top: 8px;">
          <p style="color: var(--danger); font-weight: 800;">⚠️ ${I18N.t('hazardLabel')} ${hazard}</p>
          <p style="color: var(--text-muted); margin-top: 3px;">${healthRisk}</p>
          <p style="color: var(--primary-dark); font-weight: 700; margin-top: 6px;">✅ ${I18N.t('compliantPracticeLabel')} ${safeMethod}</p>
        </div>
      </div>
    `;
  }).join('');

  modalContainer.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-height: 85vh; max-width: 560px;">
        <button class="modal-close" onclick="document.getElementById('safetyModalOverlay').innerHTML=''">✕</button>
        <h3 style="font-size: 18px; font-weight: 900; color: var(--danger); margin-bottom: 6px;">
          🚨 ${I18N.t('safetyGuideTitle')}
        </h3>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">
          ${I18N.t('safetyBanner')}
        </p>

        <div>
          ${cardsHtml}
        </div>
      </div>
    </div>
  `;
};

// -------------------------------------------------------------
// DIRECT IN-APP CONNECT — one chat thread per Kabadiwala <-> Recycler pair
// -------------------------------------------------------------
let connectChatPollInterval = null;
let connectChatThread = null; // { kabadiwalaId, recyclerId, myRole }

async function refreshConnectChatMessages() {
  if (!connectChatThread) return;
  const { kabadiwalaId, recyclerId, myRole } = connectChatThread;
  const listEl = document.getElementById('connectChatMessages');
  if (!listEl) return;

  try {
    const messages = await API.listMessages(kabadiwalaId, recyclerId);
    listEl.innerHTML = messages.length ? messages.map(m => {
      const isMine = m.senderRole === myRole;
      return `
        <div style="align-self: ${isMine ? 'flex-end' : 'flex-start'}; max-width: 80%; background: ${isMine ? 'var(--primary)' : '#fff'}; color: ${isMine ? '#fff' : 'var(--text-main)'}; border: ${isMine ? 'none' : '1px solid var(--border)'}; padding: 8px 12px; border-radius: 12px; font-size: 13px;">
          <div style="font-size: 10.5px; opacity: 0.8; font-weight: 700; margin-bottom: 2px;">${m.senderName}</div>
          <div>${m.body.replace(/</g, '&lt;')}</div>
        </div>
      `;
    }).join('') : `<div style="text-align:center; color: var(--text-muted); font-size: 12.5px; padding: 20px;">${I18N.t('noMessagesYet')} 👋</div>`;
    listEl.scrollTop = listEl.scrollHeight;
  } catch (err) {
    // Silent — keep last known state, next poll tick will retry.
  }
}

window.openConnectChatModal = async (kabadiwalaId, kabadiwalaName, recyclerId, recyclerName, myRole, myName) => {
  let modalContainer = document.getElementById('connectChatModalOverlay');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'connectChatModalOverlay';
    document.body.appendChild(modalContainer);
  }

  const otherPartyName = myRole === 'kabadiwala' ? recyclerName : kabadiwalaName;
  connectChatThread = { kabadiwalaId, recyclerId, myRole };

  modalContainer.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 480px; display: flex; flex-direction: column; max-height: 80vh;">
        <button class="modal-close" onclick="closeConnectChatModal()">✕</button>
        <h3 style="font-size: 17px; font-weight: 800; margin-bottom: 4px;">💬 ${otherPartyName}</h3>
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">${I18N.t('directConnectLabel')}</p>
        <div id="connectChatMessages" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 8px; background: var(--surface-2); border-radius: var(--radius-sm); min-height: 200px; max-height: 320px;"></div>
        <div style="display: flex; gap: 8px; margin-top: 10px;">
          <input type="text" id="connectChatInput" class="form-input" placeholder="${I18N.t('typeMessagePlaceholder')}" style="flex: 1;" onkeydown="if(event.key==='Enter') sendConnectChatMessage('${(myName || '').replace(/'/g, "\\'")}')">
          <button class="btn-primary" style="width: auto; padding: 10px 16px;" onclick="sendConnectChatMessage('${(myName || '').replace(/'/g, "\\'")}')">${I18N.t('sendBtn')}</button>
        </div>
      </div>
    </div>
  `;

  await refreshConnectChatMessages();

  if (connectChatPollInterval) clearInterval(connectChatPollInterval);
  connectChatPollInterval = setInterval(refreshConnectChatMessages, 3000);
};

window.closeConnectChatModal = () => {
  if (connectChatPollInterval) { clearInterval(connectChatPollInterval); connectChatPollInterval = null; }
  connectChatThread = null;
  const modalContainer = document.getElementById('connectChatModalOverlay');
  if (modalContainer) modalContainer.innerHTML = '';
};

window.sendConnectChatMessage = async (myName) => {
  if (!connectChatThread) return;
  const input = document.getElementById('connectChatInput');
  if (!input || !input.value.trim()) return;

  const body = input.value.trim();
  input.value = '';

  try {
    await API.sendMessage({
      kabadiwalaId: connectChatThread.kabadiwalaId,
      recyclerId: connectChatThread.recyclerId,
      senderRole: connectChatThread.myRole,
      senderName: myName,
      body
    });
    await refreshConnectChatMessages();
  } catch (err) {
    alert(`❌ ${I18N.tf('couldNotSendMessageMsg', { error: err.message })}`);
  }
};

// Global Helpers
window.resendPriceListSms = async (kabadiId, phone) => {
  try {
    const result = await API.sendPriceListSms(kabadiId);
    if (result.sent) {
      alert(`📩 ${I18N.tf('priceSmsSentToMsg', { phone })}`);
    } else {
      alert(`⚠️ ${I18N.tf('smsNotSentMsg', { reason: result.reason })}`);
    }
  } catch (err) {
    alert(`❌ ${I18N.tf('couldNotSendSmsMsg', { error: err.message })}`);
  }
};

function getLocalizedMatName(mat) {
  if (I18N.currentLang === 'en') return mat.name;
  if (I18N.currentLang === 'ta' && mat.nameTa) return mat.nameTa;
  if (I18N.currentLang === 'te' && mat.nameTe) return mat.nameTe;
  if (I18N.currentLang === 'kn' && mat.nameKn) return mat.nameKn;
  if (I18N.currentLang === 'ml' && mat.nameMl) return mat.nameMl;
  if (I18N.currentLang === 'mr' && mat.nameMr) return mat.nameMr;
  if (I18N.currentLang === 'hi' && mat.nameHi) return mat.nameHi;
  return mat.name;
}

// Generic per-language field picker for any object following the mat.name/nameHi/nameTa...
// naming convention (safety guides: title/titleHi/titleTa, hazard/hazardHi/hazardTa, etc.).
// Falls back to the English base field — never to a different language — when a
// language-specific value is missing.
function localizedField(obj, base) {
  const suffixByLang = { hi: 'Hi', mr: 'Mr', ta: 'Ta', te: 'Te', kn: 'Kn', ml: 'Ml' };
  const suffix = suffixByLang[I18N.currentLang];
  return (suffix && obj[base + suffix]) || obj[base];
}

window.logoutUser = () => {
  if (confirm(I18N.t('confirmLogoutMsg'))) {
    AppState.user = null;
    localStorage.removeItem('esetu_user');
    renderApp();
  }
};
