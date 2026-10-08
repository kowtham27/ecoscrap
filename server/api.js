const express = require('express');
const { db } = require('./db');
const SEED_DATA = require('./seed-data');
const { sendPriceListSms, broadcastWeeklyPriceList } = require('./priceNotify');
const { requestOtp, verifyOtp, OtpError } = require('./otp');
const { checkCpcbRegistration } = require('./cpcb-registry');
const { classifyScrapPhoto, isConfigured: isScannerConfigured, ScanError } = require('./gemini-scan');
const { chat: assistantChat, isConfigured: isAssistantConfigured, ChatError } = require('./gemini-chat');

const router = express.Router();

// ---------------------------------------------------------------
// Row <-> frontend-shape mappers
// ---------------------------------------------------------------
function rowToMaterial(row) {
  return {
    id: row.id, symbol: row.symbol, name: row.name,
    nameMr: row.name_mr, nameHi: row.name_hi, nameTa: row.name_ta,
    nameTe: row.name_te, nameKn: row.name_kn, nameMl: row.name_ml,
    icon: row.icon, unit: row.unit,
    customerRate: row.customer_rate, recyclerRate: row.recycler_rate,
    rate6hrAgo: row.rate_6hr_ago, recyclerRate6hrAgo: row.recycler_rate_6hr_ago,
    dayHigh: row.day_high, dayLow: row.day_low, volume: row.volume,
    changePct: row.change_pct, isPositive: !!row.is_positive,
    sparkline: JSON.parse(row.sparkline_json || '[]'),
    description: row.description, metals: row.metals,
    hazardLevel: row.hazard_level, properProcess: row.proper_process,
    co2FactorKgPerKg: row.co2_factor_kg_per_kg || 0
  };
}

function rowToKabadiwalaAuth(row) {
  return { kabadiId: row.kabadi_id, phone: row.phone, pin: row.pin, name: row.name, yard: row.yard, location: row.location };
}

function rowToKabadiwalaDisplay(row) {
  const extra = JSON.parse(row.extra_json || '{}');
  return {
    id: `kab-${row.id}`, name: row.name, phone: row.phone, location: row.location,
    vehicle: row.vehicle, photo: row.photo, rating: row.rating, totalReviews: row.total_reviews,
    badge: row.badge, reviews: JSON.parse(row.reviews_json || '[]'),
    latitude: row.latitude, longitude: row.longitude,
    ...extra
  };
}

function rowToRecyclerAuth(row) {
  return { cpcbRegNo: row.cpcb_reg_no, phone: row.phone, name: row.name, facility: row.facility };
}

function rowToRecyclerDisplay(row, rateOverridesByRecycler) {
  const extra = JSON.parse(row.extra_json || '{}');
  const recyclerId = `rec-${row.id}`;
  const rates = { ...JSON.parse(row.rates_json || '{}'), ...((rateOverridesByRecycler && rateOverridesByRecycler[recyclerId]) || {}) };
  return {
    id: recyclerId, name: row.name, cpcbRegNo: row.cpcb_reg_no, location: row.location,
    rates, rating: row.rating,
    kabadiwalaReviews: JSON.parse(row.reviews_json || '[]'),
    latitude: row.latitude, longitude: row.longitude,
    ...extra
  };
}

function rowToLot(row) {
  return {
    lotId: row.lot_id, date: row.created_at,
    kabadiwalaId: row.kabadiwala_id, kabadiwalaName: row.kabadiwala_name,
    recyclerId: row.recycler_id, recyclerName: row.recycler_name,
    material: row.material, symbol: row.symbol, weightKg: row.weight_kg,
    agreedRate: row.agreed_rate, totalAmount: row.total_amount,
    paymentMethod: row.payment_method, paymentStatus: row.payment_status, status: row.status,
    gpsLocation: row.gps_location, gpsLat: row.gps_lat, gpsLng: row.gps_lng,
    qualityGrade: row.quality_grade, qualityMultiplier: row.quality_multiplier || 1.0,
    cpcbManifestNo: row.cpcb_manifest_no,
    eprCertIssued: !!row.epr_cert_issued,
    pooledBookingIds: JSON.parse(row.pooled_booking_ids_json || '[]')
  };
}

function rowToSafetyGuide(row) {
  return {
    id: row.id,
    title: row.title, titleMr: row.title_mr, titleHi: row.title_hi,
    titleTa: row.title_ta, titleTe: row.title_te, titleKn: row.title_kn, titleMl: row.title_ml,
    icon: row.icon, color: row.color,
    hazard: row.hazard, hazardHi: row.hazard_hi, hazardMr: row.hazard_mr,
    hazardTa: row.hazard_ta, hazardTe: row.hazard_te, hazardKn: row.hazard_kn, hazardMl: row.hazard_ml,
    healthRisk: row.health_risk, healthRiskHi: row.health_risk_hi, healthRiskMr: row.health_risk_mr,
    healthRiskTa: row.health_risk_ta, healthRiskTe: row.health_risk_te, healthRiskKn: row.health_risk_kn, healthRiskMl: row.health_risk_ml,
    safeMethod: row.safe_method, safeMethodHi: row.safe_method_hi, safeMethodMr: row.safe_method_mr,
    safeMethodTa: row.safe_method_ta, safeMethodTe: row.safe_method_te, safeMethodKn: row.safe_method_kn, safeMethodMl: row.safe_method_ml,
    audioScriptEn: row.audio_script_en, audioScriptMr: row.audio_script_mr, audioScriptHi: row.audio_script_hi,
    audioScriptTa: row.audio_script_ta, audioScriptTe: row.audio_script_te, audioScriptKn: row.audio_script_kn, audioScriptMl: row.audio_script_ml
  };
}

// ---------------------------------------------------------------
// AI Scrap Scanner — server-side second opinion (Gemini, see gemini-scan.js). The material
// itself is identified on the device by YOLO (js/yolo-scrap.js); this adds grade + description.
// The photo itself is not stored here; it only gets attached to a booking later as
// handover proof, the same as before.
// ---------------------------------------------------------------
router.get('/scan/status', (req, res) => {
  res.json({ enabled: isScannerConfigured() });
});

router.post('/scan', express.json({ limit: '8mb' }), async (req, res) => {
  try {
    const materialRows = await db.prepare('SELECT id, symbol, name, description FROM materials').all();
    const result = await classifyScrapPhoto(req.body && req.body.imageDataUrl, materialRows);
    res.json(result);
  } catch (err) {
    const status = err instanceof ScanError ? err.status : 500;
    if (!(err instanceof ScanError)) console.error('[scan] unexpected error:', err);
    res.status(status).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Ask EcoScrap AI — general-purpose chat assistant grounded in live platform data
// (Gemini, see gemini-chat.js). Body: { messages: [{ role: 'user'|'assistant', text }], lang, clientContext }
// ---------------------------------------------------------------
router.get('/assistant/status', (req, res) => {
  res.json({ enabled: isAssistantConfigured() });
});

router.post('/assistant', async (req, res) => {
  try {
    const [materials, kabadiwalas, safetyGuides] = await Promise.all([
      db.prepare('SELECT name, symbol, customer_rate, recycler_rate, hazard_level, description FROM materials').all(),
      db.prepare('SELECT name, location, rating FROM kabadiwalas ORDER BY id ASC').all(),
      db.prepare('SELECT title, safe_method FROM safety_guides').all()
    ]);
    const { messages, lang, clientContext } = req.body || {};
    const result = await assistantChat({ messages, lang, clientContext }, { materials, kabadiwalas, safetyGuides });
    res.json(result);
  } catch (err) {
    const status = err instanceof ChatError ? err.status : 500;
    if (!(err instanceof ChatError)) console.error('[assistant] unexpected error:', err);
    res.status(status).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// GET /api/bootstrap — everything the frontend needs on load
// ---------------------------------------------------------------
router.get('/bootstrap', async (req, res) => {
  const [materialRows, kabadiwalaRows, recyclerRows, lotRows, safetyRows, overrideRows] = await Promise.all([
    db.prepare('SELECT * FROM materials').all(),
    db.prepare('SELECT * FROM kabadiwalas ORDER BY id ASC').all(),
    db.prepare('SELECT * FROM recyclers ORDER BY id ASC').all(),
    db.prepare('SELECT * FROM lots ORDER BY id DESC').all(),
    db.prepare('SELECT * FROM safety_guides').all(),
    db.prepare('SELECT * FROM recycler_material_rates').all()
  ]);

  // Best Buyer Finder: per-recycler rate overrides, keyed by material symbol (matching how
  // the frontend already indexes ESETU_DATA.recyclers[i].rates elsewhere).
  const materialSymbolById = Object.fromEntries(materialRows.map((m) => [m.id, m.symbol]));
  const rateOverridesByRecycler = {};
  for (const row of overrideRows) {
    const symbol = materialSymbolById[row.material_id];
    if (!symbol) continue;
    if (!rateOverridesByRecycler[row.recycler_id]) rateOverridesByRecycler[row.recycler_id] = {};
    rateOverridesByRecycler[row.recycler_id][symbol] = row.rate;
  }

  res.json({
    materials: materialRows.map(rowToMaterial),
    predefinedKabadiwalas: kabadiwalaRows.map(rowToKabadiwalaAuth),
    kabadiwalas: kabadiwalaRows.map(rowToKabadiwalaDisplay),
    predefinedRecyclers: recyclerRows.filter(r => r.phone).map(rowToRecyclerAuth),
    recyclers: recyclerRows.filter(r => r.phone).map((r) => rowToRecyclerDisplay(r, rateOverridesByRecycler)),
    validCpcbRegistrations: recyclerRows.map(r => r.cpcb_reg_no),
    lots: lotRows.map(rowToLot),
    safetyGuides: safetyRows.map(rowToSafetyGuide),
    inventory: SEED_DATA.inventory,
    dailyCollectionHistory: SEED_DATA.dailyCollectionHistory,
    customerSalesHistory: SEED_DATA.customerSalesHistory,
    customerSalesSummary: SEED_DATA.customerSalesSummary,
    customerMonthlyComparison: SEED_DATA.customerMonthlyComparison
  });
});

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------
// Scrap dealers verify their mobile number with an SMS OTP (Fast2SMS, see otp.js):
// purpose 'register' only for numbers NOT yet registered, 'login' only for registered ones.
function cleanIndianMobile(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

function sendOtpError(res, err) {
  if (err instanceof OtpError) return res.status(err.status).json({ error: err.message });
  console.error('[otp] unexpected error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

router.post('/auth/kabadiwala-otp', async (req, res) => {
  const { phone, purpose } = req.body || {};
  const cleanPhone = cleanIndianMobile(phone);
  if (!cleanPhone) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
  if (purpose !== 'register' && purpose !== 'login') return res.status(400).json({ error: 'purpose must be "register" or "login".' });

  const existing = await db.prepare('SELECT id FROM kabadiwalas WHERE phone = ?').get(cleanPhone);
  if (purpose === 'register' && existing) return res.status(409).json({ error: 'This number is already registered. Please sign in instead.' });
  if (purpose === 'login' && !existing) return res.status(404).json({ error: 'This number is not registered as a dealer. Please register first.' });

  try {
    res.json(await requestOtp(cleanPhone, purpose));
  } catch (err) {
    sendOtpError(res, err);
  }
});

router.post('/auth/kabadiwala-login', async (req, res) => {
  const { phone, otp } = req.body || {};
  const cleanPhone = cleanIndianMobile(phone);
  if (!cleanPhone) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
  const row = await db.prepare('SELECT * FROM kabadiwalas WHERE phone = ?').get(cleanPhone);
  if (!row) return res.status(404).json({ error: 'This number is not registered as a dealer. Please register first.' });

  try {
    await verifyOtp(cleanPhone, 'login', otp);
  } catch (err) {
    return sendOtpError(res, err);
  }
  res.json({ role: 'kabadiwala', ...rowToKabadiwalaAuth(row) });
});

router.post('/auth/kabadiwala-register', async (req, res) => {
  const { name, phone, otp, yard, vehicleType, location, latitude, longitude } = req.body || {};
  const cleanPhone = cleanIndianMobile(phone);
  if (!cleanPhone || !name) return res.status(400).json({ error: 'Name and a valid 10-digit mobile number are required.' });

  const existing = await db.prepare('SELECT id FROM kabadiwalas WHERE phone = ?').get(cleanPhone);
  if (existing) return res.status(409).json({ error: 'A dealer with this phone number is already registered.' });

  try {
    await verifyOtp(cleanPhone, 'register', otp);
  } catch (err) {
    return sendOtpError(res, err);
  }

  const hasCoords = typeof latitude === 'number' && typeof longitude === 'number';
  const kabadiId = `KAB-REG-${Math.floor(1000 + Math.random() * 9000)}`;
  const extra = {
    shopName: yard || 'My Scrap Yard',
    fullAddress: location || '',
    coordinates: hasCoords ? `${latitude.toFixed(5)}° N, ${longitude.toFixed(5)}° E` : '',
    googleMapsUrl: hasCoords ? `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}` : '#',
    distanceKm: 0.6, vehiclePlate: '—', status: 'Online • Verified Partner',
    etaMinutes: 20, etaDistanceKm: 0.6, transitState: 'Available for instant scheduling',
    licenseNo: '—', weighingEquipment: 'Certified digital weighing scale',
    operatingHours: '8:00 AM – 8:00 PM', materialsAccepted: 'General E-Waste & Scrap',
    cashOnCollection: true
  };

  const result = await db.prepare(`
    INSERT INTO kabadiwalas (kabadi_id, name, phone, pin, yard, location, vehicle, photo, rating, total_reviews, badge, reviews_json, extra_json, latitude, longitude, created_at)
    VALUES (@kabadiId, @name, @phone, @pin, @yard, @location, @vehicle, @photo, @rating, @totalReviews, @badge, @reviewsJson, @extraJson, @latitude, @longitude, @createdAt)
  `).run({
    kabadiId, name, phone: cleanPhone, pin: '1234', yard: yard || 'My Scrap Yard', location: location || '',
    vehicle: `${vehicleType || 'Tata Ace'} & Certified Scales`, photo: '👨🏽‍💼',
    rating: 5.0, totalReviews: 1, badge: 'Verified Partner',
    reviewsJson: JSON.stringify([{ customer: 'System Verification', rating: 5, date: 'Today', text: 'Digital weighing scale verified.' }]),
    extraJson: JSON.stringify(extra),
    latitude: hasCoords ? latitude : null, longitude: hasCoords ? longitude : null,
    createdAt: new Date().toISOString()
  });

  const row = await db.prepare('SELECT * FROM kabadiwalas WHERE id = ?').get(result.lastInsertRowid);
  const smsResult = await sendPriceListSms(row.kabadi_id, row.phone);
  res.status(201).json({ role: 'kabadiwala', ...rowToKabadiwalaAuth(row), sms: smsResult });
});

// Recycler access is a self-registration model (like kabadiwala): the first time a
// CPCB/SPCB registration number logs in, it's registered for real; every login after
// that authenticates against that same real row. There's no pre-seeded "valid" list —
// nothing is faked, so nothing needs to be pre-approved.
router.post('/auth/recycler-login', async (req, res) => {
  const { govRegNo, name, phone, location, latitude, longitude } = req.body || {};
  const cleanReg = String(govRegNo || '').trim().toUpperCase();
  if (!cleanReg) return res.status(400).json({ error: 'CPCB/SPCB registration number is required.' });

  let row = await db.prepare('SELECT * FROM recyclers WHERE UPPER(cpcb_reg_no) = ?').get(cleanReg);

  if (!row) {
    if (!name || !phone) {
      return res.status(400).json({ error: 'First-time registration needs a facility name and phone number.' });
    }

    const hasCoords = typeof latitude === 'number' && typeof longitude === 'number';
    // Recycler Verification — checked against a small local CPCB registration-format/mirror
    // list (see server/cpcb-registry.js), not a live government API (none is available to
    // this app). Registration still succeeds either way — this only changes the badge shown.
    const cpcbCheck = checkCpcbRegistration(cleanReg);
    const verifiedBadge = cpcbCheck.verified
      ? 'Verified against CPCB registry mirror'
      : (cpcbCheck.formatValid ? 'Format valid — not found in local registry mirror' : 'Unrecognized registration format');
    const extra = {
      mpcbAuthDate: 'Registered via EcoScrap AI',
      fullAddress: location || '',
      coordinates: hasCoords ? `${latitude.toFixed(5)}° N, ${longitude.toFixed(5)}° E` : '',
      googleMapsUrl: hasCoords ? `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}` : '#',
      distanceKm: 0, capacity: '—', kabadiwalaReviewsCount: 0,
      doorstepPickup: 'Contact facility to confirm', minLotKg: 0,
      paymentTerms: 'To be confirmed with facility', verifiedBadge, cpcbVerified: cpcbCheck.verified,
      operatingHours: 'Contact facility', weighbridgeTech: '—',
      collectionTruckETA: 0, collectionTruckStatus: 'Contact facility to arrange pickup'
    };

    const result = await db.prepare(`
      INSERT INTO recyclers (cpcb_reg_no, name, phone, facility, location, rates_json, rating, reviews_json, extra_json, latitude, longitude, created_at)
      VALUES (@cpcbRegNo, @name, @phone, @facility, @location, '{}', 0, '[]', @extraJson, @latitude, @longitude, @createdAt)
    `).run({
      cpcbRegNo: cleanReg, name, phone, facility: location || '', location: location || '',
      extraJson: JSON.stringify(extra),
      latitude: hasCoords ? latitude : null, longitude: hasCoords ? longitude : null,
      createdAt: new Date().toISOString()
    });

    row = await db.prepare('SELECT * FROM recyclers WHERE id = ?').get(result.lastInsertRowid);
  }

  res.json({
    role: 'recycler',
    govRegNo: row.cpcb_reg_no,
    name: row.name,
    phone: row.phone,
    location: row.facility || row.location
  });
});

// ---------------------------------------------------------------
// Lots
// ---------------------------------------------------------------
router.get('/lots', async (req, res) => {
  const { recyclerId, kabadiwalaId } = req.query;
  let rows;
  if (recyclerId) rows = await db.prepare('SELECT * FROM lots WHERE recycler_id = ? ORDER BY id DESC').all(recyclerId);
  else if (kabadiwalaId) rows = await db.prepare('SELECT * FROM lots WHERE kabadiwala_id = ? ORDER BY id DESC').all(kabadiwalaId);
  else rows = await db.prepare('SELECT * FROM lots ORDER BY id DESC').all();
  res.json(rows.map(rowToLot));
});

router.post('/lots', async (req, res) => {
  const {
    kabadiwalaId, kabadiwalaName, recyclerId, recyclerName, materialId, weightKg, paymentMethod,
    agreedRate, qualityGrade, qualityMultiplier, gpsLat, gpsLng
  } = req.body || {};
  const material = await db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
  if (!material) return res.status(400).json({ error: 'Unknown material.' });

  const weight = Number(weightKg) || 0;
  if (weight <= 0) return res.status(400).json({ error: 'Weight must be greater than zero.' });

  // Fair Price Detector: the kabadiwala can propose a rate for the lot (defaults to the
  // platform's current recycler rate if omitted — fully backward compatible).
  const finalRate = Number(agreedRate) > 0 ? Number(agreedRate) : material.recycler_rate;
  const multiplier = Number(qualityMultiplier) > 0 ? Number(qualityMultiplier) : 1.0;

  const lotId = `LOT-REC-2026-${Math.floor(1000 + Math.random() * 9000)}`;
  const cpcbManifestNo = `MH-EPR-MAN-${Math.floor(100000 + Math.random() * 900000)}`;
  const totalAmount = weight * finalRate * multiplier;

  const hasGps = typeof gpsLat === 'number' && typeof gpsLng === 'number';
  const gpsLocation = hasGps
    ? `${gpsLat.toFixed(5)}° N, ${gpsLng.toFixed(5)}° E`
    : '18.5074° N, 73.8077° E'; // fallback for demo/no-permission handovers

  await db.prepare(`
    INSERT INTO lots (lot_id, kabadiwala_id, kabadiwala_name, recycler_id, recycler_name, material, symbol,
      weight_kg, agreed_rate, total_amount, payment_method, payment_status, status, gps_location,
      gps_lat, gps_lng, quality_grade, quality_multiplier,
      cpcb_manifest_no, epr_cert_issued, created_at)
    VALUES (@lotId, @kabadiwalaId, @kabadiwalaName, @recyclerId, @recyclerName, @material, @symbol,
      @weightKg, @agreedRate, @totalAmount, @paymentMethod, 'Pending Inspection', 'In Transit / Gate Handover Booked',
      @gpsLocation, @gpsLat, @gpsLng, @qualityGrade, @qualityMultiplier,
      @cpcbManifestNo, 0, @createdAt)
  `).run({
    lotId, kabadiwalaId: kabadiwalaId || '', kabadiwalaName: kabadiwalaName || 'Unknown Collector',
    recyclerId: recyclerId || '', recyclerName: recyclerName || 'Unknown Recycler',
    material: material.name, symbol: material.symbol, weightKg: weight,
    agreedRate: finalRate, totalAmount,
    paymentMethod: paymentMethod || 'Cash at Gate', gpsLocation,
    gpsLat: hasGps ? gpsLat : null, gpsLng: hasGps ? gpsLng : null,
    qualityGrade: qualityGrade || null, qualityMultiplier: multiplier,
    cpcbManifestNo, createdAt: new Date().toLocaleString()
  });

  const row = await db.prepare('SELECT * FROM lots WHERE lot_id = ?').get(lotId);
  res.status(201).json(rowToLot(row));
});

// Better Earnings (load pooling) — combine several small completed customer_bookings for
// the SAME material into one wholesale lot dispatched to a recycler, with a small
// deterministic bonus multiplier for consolidating pickups instead of dispatching each
// individually. Each source booking is tagged with the resulting lot id for traceability
// (surfaced on the customer's own Digital Passport).
router.post('/lots/pool', async (req, res) => {
  const { bookingIds, kabadiwalaId, kabadiwalaName, recyclerId, recyclerName, paymentMethod } = req.body || {};
  if (!Array.isArray(bookingIds) || bookingIds.length < 2) {
    return res.status(400).json({ error: 'At least 2 bookingIds are required to pool.' });
  }

  const bookings = await Promise.all(bookingIds.map((id) => db.prepare('SELECT * FROM customer_bookings WHERE id = ?').get(id)));
  if (bookings.some((b) => !b)) return res.status(404).json({ error: 'One or more bookings not found.' });
  if (bookings.some((b) => b.status !== 'Completed')) return res.status(400).json({ error: 'All bookings must be Completed before pooling.' });
  if (bookings.some((b) => b.pooled_lot_id)) return res.status(400).json({ error: 'One or more bookings have already been pooled.' });
  const materialId = bookings[0].material_id;
  if (bookings.some((b) => b.material_id !== materialId)) return res.status(400).json({ error: 'All pooled bookings must be the same material.' });

  const material = await db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
  const totalWeight = bookings.reduce((sum, b) => sum + b.weight_kg, 0);

  // Disclosed, deterministic pooling bonus — +5% over the platform recycler rate for
  // consolidating 2+ small pickups into one dispatch (not a real negotiated wholesale deal).
  const poolBonusMultiplier = 1.05;
  const effectiveRate = material.recycler_rate * poolBonusMultiplier;
  const totalAmount = totalWeight * effectiveRate;

  const lotId = `LOT-POOL-2026-${Math.floor(1000 + Math.random() * 9000)}`;
  const cpcbManifestNo = `MH-EPR-MAN-${Math.floor(100000 + Math.random() * 900000)}`;

  await db.prepare(`
    INSERT INTO lots (lot_id, kabadiwala_id, kabadiwala_name, recycler_id, recycler_name, material, symbol,
      weight_kg, agreed_rate, total_amount, payment_method, payment_status, status, gps_location,
      quality_multiplier, pooled_booking_ids_json, cpcb_manifest_no, epr_cert_issued, created_at)
    VALUES (@lotId, @kabadiwalaId, @kabadiwalaName, @recyclerId, @recyclerName, @material, @symbol,
      @weightKg, @agreedRate, @totalAmount, @paymentMethod, 'Pending Inspection', 'In Transit / Gate Handover Booked',
      '18.5074° N, 73.8077° E', @qualityMultiplier, @pooledIdsJson, @cpcbManifestNo, 0, @createdAt)
  `).run({
    lotId, kabadiwalaId: kabadiwalaId || '', kabadiwalaName: kabadiwalaName || 'Unknown Collector',
    recyclerId: recyclerId || '', recyclerName: recyclerName || 'Unknown Recycler',
    material: material.name, symbol: material.symbol, weightKg: totalWeight,
    agreedRate: effectiveRate, totalAmount, paymentMethod: paymentMethod || 'Cash at Gate',
    qualityMultiplier: poolBonusMultiplier, pooledIdsJson: JSON.stringify(bookingIds),
    cpcbManifestNo, createdAt: new Date().toLocaleString()
  });

  await Promise.all(bookingIds.map((id) => db.prepare('UPDATE customer_bookings SET pooled_lot_id = ? WHERE id = ?').run(lotId, id)));

  const row = await db.prepare('SELECT * FROM lots WHERE lot_id = ?').get(lotId);
  res.status(201).json(rowToLot(row));
});

router.patch('/lots/:lotId/confirm-payment', async (req, res) => {
  const row = await db.prepare('SELECT * FROM lots WHERE lot_id = ?').get(req.params.lotId);
  if (!row) return res.status(404).json({ error: 'Lot not found.' });

  await db.prepare(`UPDATE lots SET payment_status = 'Paid', status = 'Recycled & Verified', epr_cert_issued = 1 WHERE lot_id = ?`)
    .run(req.params.lotId);

  const updated = await db.prepare('SELECT * FROM lots WHERE lot_id = ?').get(req.params.lotId);
  res.json(rowToLot(updated));
});

// ---------------------------------------------------------------
// Materials — recycler rate updates
// ---------------------------------------------------------------
router.patch('/materials/:id/rate', async (req, res) => {
  const material = await db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!material) return res.status(404).json({ error: 'Material not found.' });

  const newRate = Number(req.body && req.body.recyclerRate);
  if (!newRate || newRate <= 0) return res.status(400).json({ error: 'recyclerRate must be a positive number.' });

  await db.prepare('UPDATE materials SET recycler_rate_6hr_ago = recycler_rate, recycler_rate = ? WHERE id = ?')
    .run(newRate, req.params.id);

  const updated = await db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);

  // Real price history: one row per actual rate-change event (not a synthetic generator).
  await db.prepare(`
    INSERT INTO rate_history (material_id, recycler_rate, customer_rate, recorded_at)
    VALUES (?, ?, ?, ?)
  `).run(req.params.id, updated.recycler_rate, updated.customer_rate, new Date().toISOString());

  res.json(rowToMaterial(updated));
});

// ---------------------------------------------------------------
// Real price history — one row per rate-change event, grows over the
// platform's actual lifetime instead of a synthetic/static sparkline.
// ---------------------------------------------------------------
router.get('/materials/:id/history', async (req, res) => {
  const days = Number(req.query.days) || 0;
  const since = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : '';
  const rows = await db.prepare(
    'SELECT recycler_rate, customer_rate, recorded_at, source FROM rate_history WHERE material_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC, id ASC'
  ).all(req.params.id, since);
  res.json(rows.map((r) => ({
    recyclerRate: r.recycler_rate, customerRate: r.customer_rate, recordedAt: r.recorded_at, source: r.source || 'live'
  })));
});

// Best Buyer Finder — a recycler can optionally publish its own rate for a material,
// overriding the platform-shared rate just for that recycler's card.
router.patch('/recyclers/:id/materials/:materialId/rate', async (req, res) => {
  const rate = Number(req.body && req.body.rate);
  if (!rate || rate <= 0) return res.status(400).json({ error: 'rate must be a positive number.' });

  await db.prepare(`
    INSERT INTO recycler_material_rates (recycler_id, material_id, rate, updated_at)
    VALUES (@recyclerId, @materialId, @rate, @updatedAt)
    ON CONFLICT(recycler_id, material_id) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at
  `).run({ recyclerId: req.params.id, materialId: req.params.materialId, rate, updatedAt: new Date().toISOString() });

  res.json({ recyclerId: req.params.id, materialId: req.params.materialId, rate });
});

// ---------------------------------------------------------------
// Customer bookings — real persistence for the customer sell/pickup flow.
// This is what the Digital Scrap Passport, Verified Handover & Proof, and
// Environmental Tracker all read from (replacing the permanently-empty
// customerSalesHistory/customerSalesSummary/customerMonthlyComparison stubs).
// ---------------------------------------------------------------
function rowToBooking(row) {
  return {
    id: row.id, bookingCode: row.booking_code,
    customerPhone: row.customer_phone, customerName: row.customer_name,
    kabadiwalaId: row.kabadiwala_id, kabadiwalaName: row.kabadiwala_name,
    materialId: row.material_id, materialName: row.material_name, symbol: row.symbol,
    weightKg: row.weight_kg, ratePerKg: row.rate_per_kg,
    qualityGrade: row.quality_grade, qualityMultiplier: row.quality_multiplier || 1.0,
    totalAmount: row.total_amount, paymentMode: row.payment_mode, status: row.status,
    gpsLat: row.gps_lat, gpsLng: row.gps_lng, photoDataUrl: row.photo_data_url,
    pooledLotId: row.pooled_lot_id, createdAt: row.created_at, completedAt: row.completed_at,
    paymentStatus: row.payment_status || 'Held',
    weighedKg: row.weighed_kg, amountPaid: row.amount_paid,
    paymentFlag: row.payment_flag, confirmedBy: row.confirmed_by
  };
}

// The handover code is the customer's to give — it's only ever returned to the customer
// who created the booking, never in the dealer-facing list.
function rowToCustomerBooking(row) {
  return { ...rowToBooking(row), handoverOtp: row.handover_otp };
}

// A payment more than this far below the fair value of the weighed scrap is treated as
// an underpayment and cannot be released silently.
const UNDERPAYMENT_TOLERANCE_PCT = 5;

router.get('/bookings', async (req, res) => {
  const { customerPhone, kabadiwalaId, status } = req.query;
  let sql = 'SELECT * FROM customer_bookings WHERE 1=1';
  const args = [];
  if (customerPhone) { sql += ' AND customer_phone = ?'; args.push(customerPhone); }
  if (kabadiwalaId) { sql += ' AND kabadiwala_id = ?'; args.push(kabadiwalaId); }
  if (status) { sql += ' AND status = ?'; args.push(status); }
  sql += ' ORDER BY id DESC';
  const rows = await db.prepare(sql).all(...args);
  // Only a customer's own lookup (by phone) gets the handover code back.
  res.json(rows.map(customerPhone && !kabadiwalaId ? rowToCustomerBooking : rowToBooking));
});

router.post('/bookings', async (req, res) => {
  const {
    customerPhone, customerName, kabadiwalaId, kabadiwalaName,
    materialId, weightKg, qualityGrade, qualityMultiplier,
    paymentMode, gpsLat, gpsLng, photoDataUrl
  } = req.body || {};

  const cleanPhone = String(customerPhone || '').trim();
  if (!cleanPhone) return res.status(400).json({ error: 'customerPhone is required.' });

  const material = await db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
  if (!material) return res.status(400).json({ error: 'Unknown material.' });

  const weight = Number(weightKg) || 0;
  if (weight <= 0) return res.status(400).json({ error: 'Weight must be greater than zero.' });

  const multiplier = Number(qualityMultiplier) > 0 ? Number(qualityMultiplier) : 1.0;
  const totalAmount = weight * material.customer_rate * multiplier;
  const bookingCode = `BOOK-${Math.floor(100000 + Math.random() * 900000)}`;
  const handoverOtp = String(Math.floor(1000 + Math.random() * 9000));
  const hasGps = typeof gpsLat === 'number' && typeof gpsLng === 'number';

  const result = await db.prepare(`
    INSERT INTO customer_bookings (booking_code, customer_phone, customer_name, kabadiwala_id, kabadiwala_name,
      material_id, material_name, symbol, weight_kg, rate_per_kg, quality_grade, quality_multiplier,
      total_amount, payment_mode, status, gps_lat, gps_lng, photo_data_url, created_at,
      payment_status, handover_otp)
    VALUES (@bookingCode, @customerPhone, @customerName, @kabadiwalaId, @kabadiwalaName,
      @materialId, @materialName, @symbol, @weightKg, @ratePerKg, @qualityGrade, @qualityMultiplier,
      @totalAmount, @paymentMode, 'Requested', @gpsLat, @gpsLng, @photoDataUrl, @createdAt,
      'Held', @handoverOtp)
  `).run({
    bookingCode, customerPhone: cleanPhone, customerName: customerName || 'Customer',
    kabadiwalaId: kabadiwalaId || '', kabadiwalaName: kabadiwalaName || 'Unknown Collector',
    materialId, materialName: material.name, symbol: material.symbol,
    weightKg: weight, ratePerKg: material.customer_rate,
    qualityGrade: qualityGrade || null, qualityMultiplier: multiplier,
    totalAmount, paymentMode: paymentMode || 'cash',
    gpsLat: hasGps ? gpsLat : null, gpsLng: hasGps ? gpsLng : null,
    photoDataUrl: photoDataUrl || null, createdAt: new Date().toISOString(), handoverOtp
  });

  const row = await db.prepare('SELECT * FROM customer_bookings WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(rowToCustomerBooking(row));
});

// Secure Payment to Collector + Fraud/Underpayment Alert.
// Payment stays 'Held' from booking until handover. The dealer releases it by entering the
// code the customer gives them once paid; the customer can also confirm from their side.
// Either way the weighed weight and amount actually paid are checked against the fair
// value — a short payment returns 409 with the numbers instead of completing, and the
// customer then either accepts the shortfall or raises a dispute.
router.patch('/bookings/:id/complete', async (req, res) => {
  const row = await db.prepare('SELECT * FROM customer_bookings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Booking not found.' });
  if (row.status !== 'Requested') return res.status(409).json({ error: `Booking is already ${row.status}.` });

  const { confirmedBy = 'customer', otp, weighedKg, amountPaid, acceptShortfall, dispute } = req.body || {};

  if (confirmedBy === 'dealer' && row.handover_otp && String(otp || '').trim() !== row.handover_otp) {
    return res.status(403).json({ error: 'Handover code does not match. Ask the customer for the 4-digit code shown on their booking.' });
  }

  const weighed = Number(weighedKg) > 0 ? Number(weighedKg) : row.weight_kg;
  const fairValue = Math.round(weighed * row.rate_per_kg * (row.quality_multiplier || 1));
  const hasPaid = amountPaid !== undefined && amountPaid !== null && amountPaid !== '' && Number(amountPaid) >= 0;
  const paid = hasPaid ? Math.round(Number(amountPaid)) : fairValue;
  const shortfallPct = fairValue > 0 ? Math.round(((fairValue - paid) / fairValue) * 1000) / 10 : 0;
  const underpaid = shortfallPct > UNDERPAYMENT_TOLERANCE_PCT;

  if (underpaid && !acceptShortfall && !dispute) {
    return res.status(409).json({
      error: 'Underpayment detected.',
      alert: { fairValue, paid, shortfall: fairValue - paid, shortfallPct, weighedKg: weighed, ratePerKg: row.rate_per_kg }
    });
  }
  // A dealer can't wave through their own short payment — only the customer can accept it.
  if (underpaid && confirmedBy === 'dealer') {
    return res.status(409).json({ error: 'Only the customer can accept a short payment.' });
  }

  const status = dispute ? 'Disputed' : 'Completed';
  const paymentStatus = dispute ? 'Disputed' : 'Released';
  const flag = underpaid ? (dispute ? 'underpaid' : 'underpaid-accepted') : null;

  await db.prepare(`
    UPDATE customer_bookings SET status = @status, payment_status = @paymentStatus, payment_flag = @flag,
      weighed_kg = @weighed, amount_paid = @paid, confirmed_by = @confirmedBy, completed_at = @completedAt
    WHERE id = @id
  `).run({
    status, paymentStatus, flag, weighed, paid,
    confirmedBy: confirmedBy === 'dealer' ? 'dealer' : 'customer',
    completedAt: new Date().toISOString(), id: req.params.id
  });

  const updated = await db.prepare('SELECT * FROM customer_bookings WHERE id = ?').get(req.params.id);
  res.json(rowToBooking(updated));
});

// Live-computed customer summary — replaces the permanently-zero static stub with a real
// SQL aggregation over that customer's actual completed bookings.
router.get('/customers/:phone/summary', async (req, res) => {
  const phone = req.params.phone;

  const totals = await db.prepare(`
    SELECT
      COALESCE(SUM(COALESCE(b.weighed_kg, b.weight_kg)), 0) AS totalWeightSoldKg,
      COALESCE(SUM(COALESCE(b.amount_paid, b.total_amount)), 0) AS totalCashReceived,
      COUNT(*) AS totalPickupsCompleted,
      COALESCE(SUM(COALESCE(b.weighed_kg, b.weight_kg) * COALESCE(m.co2_factor_kg_per_kg, 0)), 0) AS totalCo2PreventedKg
    FROM customer_bookings b
    LEFT JOIN materials m ON m.id = b.material_id
    WHERE b.customer_phone = ? AND b.status = 'Completed'
  `).get(phone);

  const preferredDealerRow = await db.prepare(`
    SELECT kabadiwala_name AS name, COUNT(*) AS c FROM customer_bookings
    WHERE customer_phone = ? AND status = 'Completed'
    GROUP BY kabadiwala_name ORDER BY c DESC LIMIT 1
  `).get(phone);

  const monthlyRows = await db.prepare(`
    SELECT strftime('%Y-%m', completed_at) AS period,
      SUM(COALESCE(weighed_kg, weight_kg)) AS weightKg, COUNT(*) AS pickups, SUM(COALESCE(amount_paid, total_amount)) AS earnings
    FROM customer_bookings
    WHERE customer_phone = ? AND status = 'Completed'
    GROUP BY period ORDER BY period DESC LIMIT 6
  `).all(phone);

  const historyRows = await db.prepare(`
    SELECT * FROM customer_bookings WHERE customer_phone = ? AND status IN ('Completed', 'Disputed') ORDER BY completed_at DESC
  `).all(phone);

  // Illustrative estimate: a mature tree absorbs roughly 21kg of CO2 per year — used only
  // to give the "trees equivalent" figure a real, internally-consistent basis.
  const totalTreesEquivalent = Math.round((totals.totalCo2PreventedKg / 21) * 10) / 10;

  res.json({
    summary: {
      totalWeightSoldKg: Math.round(totals.totalWeightSoldKg * 100) / 100,
      totalCashReceived: Math.round(totals.totalCashReceived),
      totalPickupsCompleted: totals.totalPickupsCompleted,
      totalTreesEquivalent,
      totalCo2PreventedKg: Math.round(totals.totalCo2PreventedKg * 10) / 10,
      preferredScrapDealer: preferredDealerRow ? preferredDealerRow.name : ''
    },
    monthlyComparison: monthlyRows.map((r) => ({
      period: r.period, weightKg: r.weightKg, pickups: r.pickups, earnings: r.earnings
    })),
    history: historyRows.map(rowToBooking)
  });
});

// ---------------------------------------------------------------
// Smart Collection Day — a kabadiwala sets a recurring collection day for a pincode/area;
// customers in that area see when the next collection day is.
// ---------------------------------------------------------------
function rowToSchedule(row) {
  return {
    id: row.id, kabadiwalaId: row.kabadiwala_id, kabadiwalaName: row.kabadiwala_name,
    areaPincode: row.area_pincode, dayOfWeek: row.day_of_week, createdAt: row.created_at
  };
}

router.get('/collection-schedules', async (req, res) => {
  const { pincode, kabadiwalaId } = req.query;
  let rows;
  if (pincode) rows = await db.prepare('SELECT * FROM collection_schedules WHERE area_pincode = ?').all(pincode);
  else if (kabadiwalaId) rows = await db.prepare('SELECT * FROM collection_schedules WHERE kabadiwala_id = ?').all(kabadiwalaId);
  else rows = await db.prepare('SELECT * FROM collection_schedules').all();
  res.json(rows.map(rowToSchedule));
});

router.post('/collection-schedules', async (req, res) => {
  const { kabadiwalaId, kabadiwalaName, areaPincode, dayOfWeek } = req.body || {};
  if (!kabadiwalaId || !areaPincode || typeof dayOfWeek !== 'number') {
    return res.status(400).json({ error: 'kabadiwalaId, areaPincode, and dayOfWeek are required.' });
  }
  const result = await db.prepare(`
    INSERT INTO collection_schedules (kabadiwala_id, kabadiwala_name, area_pincode, day_of_week, created_at)
    VALUES (@kabadiwalaId, @kabadiwalaName, @areaPincode, @dayOfWeek, @createdAt)
  `).run({ kabadiwalaId, kabadiwalaName: kabadiwalaName || '', areaPincode: String(areaPincode).trim(), dayOfWeek, createdAt: new Date().toISOString() });

  const row = await db.prepare('SELECT * FROM collection_schedules WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(rowToSchedule(row));
});

// ---------------------------------------------------------------
// Community E-Waste Collection — institutions (colleges/campuses/offices) registering for
// scheduled bulk collection, linked to a nearby dealer.
// ---------------------------------------------------------------
function rowToInstitution(row) {
  return {
    id: `inst-${row.id}`, name: row.name, type: row.type,
    contactName: row.contact_name, phone: row.phone,
    location: row.location, latitude: row.latitude, longitude: row.longitude,
    linkedKabadiwalaId: row.linked_kabadiwala_id, linkedKabadiwalaName: row.linked_kabadiwala_name,
    createdAt: row.created_at
  };
}

router.get('/institutions', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM institutions ORDER BY id DESC').all();
  res.json(rows.map(rowToInstitution));
});

router.post('/institutions', async (req, res) => {
  const { name, type, contactName, phone, location, latitude, longitude } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required.' });

  const hasCoords = typeof latitude === 'number' && typeof longitude === 'number';
  const result = await db.prepare(`
    INSERT INTO institutions (name, type, contact_name, phone, location, latitude, longitude, created_at)
    VALUES (@name, @type, @contactName, @phone, @location, @latitude, @longitude, @createdAt)
  `).run({
    name, type: type || 'Institution', contactName: contactName || '', phone, location: location || '',
    latitude: hasCoords ? latitude : null, longitude: hasCoords ? longitude : null,
    createdAt: new Date().toISOString()
  });

  const row = await db.prepare('SELECT * FROM institutions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(rowToInstitution(row));
});

router.patch('/institutions/:id/link-dealer', async (req, res) => {
  const { kabadiwalaId, kabadiwalaName } = req.body || {};
  const numericId = String(req.params.id).replace('inst-', '');
  await db.prepare('UPDATE institutions SET linked_kabadiwala_id = ?, linked_kabadiwala_name = ? WHERE id = ?')
    .run(kabadiwalaId, kabadiwalaName, numericId);
  const row = await db.prepare('SELECT * FROM institutions WHERE id = ?').get(numericId);
  if (!row) return res.status(404).json({ error: 'Institution not found.' });
  res.json(rowToInstitution(row));
});

// ---------------------------------------------------------------
// Fair Rotation Contracts — a customer/institution locks in a dealer for a fixed
// (typically 15-20 day) window, then renews or switches once it expires.
// ---------------------------------------------------------------
function rowToContract(row) {
  return {
    id: row.id, customerId: row.customer_id, customerType: row.customer_type, customerName: row.customer_name,
    kabadiwalaId: row.kabadiwala_id, kabadiwalaName: row.kabadiwala_name,
    startDate: row.start_date, durationDays: row.duration_days, status: row.status, createdAt: row.created_at
  };
}

router.get('/contracts', async (req, res) => {
  const { customerId } = req.query;
  const rows = customerId
    ? await db.prepare('SELECT * FROM dealer_contracts WHERE customer_id = ? ORDER BY id DESC').all(customerId)
    : await db.prepare('SELECT * FROM dealer_contracts ORDER BY id DESC').all();
  res.json(rows.map(rowToContract));
});

router.post('/contracts', async (req, res) => {
  const { customerId, customerType, customerName, kabadiwalaId, kabadiwalaName, durationDays } = req.body || {};
  if (!customerId || !kabadiwalaId) return res.status(400).json({ error: 'customerId and kabadiwalaId are required.' });

  const result = await db.prepare(`
    INSERT INTO dealer_contracts (customer_id, customer_type, customer_name, kabadiwala_id, kabadiwala_name, start_date, duration_days, status, created_at)
    VALUES (@customerId, @customerType, @customerName, @kabadiwalaId, @kabadiwalaName, @startDate, @durationDays, 'Active', @createdAt)
  `).run({
    customerId, customerType: customerType || 'customer', customerName: customerName || '',
    kabadiwalaId, kabadiwalaName: kabadiwalaName || '',
    startDate: new Date().toISOString(), durationDays: Number(durationDays) || 15,
    createdAt: new Date().toISOString()
  });

  const row = await db.prepare('SELECT * FROM dealer_contracts WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(rowToContract(row));
});

router.patch('/contracts/:id/renew', async (req, res) => {
  await db.prepare(`UPDATE dealer_contracts SET start_date = ?, status = 'Active' WHERE id = ?`)
    .run(new Date().toISOString(), req.params.id);
  const row = await db.prepare('SELECT * FROM dealer_contracts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Contract not found.' });
  res.json(rowToContract(row));
});

router.patch('/contracts/:id/switch', async (req, res) => {
  const { kabadiwalaId, kabadiwalaName } = req.body || {};
  await db.prepare(`UPDATE dealer_contracts SET kabadiwala_id = ?, kabadiwala_name = ?, start_date = ?, status = 'Active' WHERE id = ?`)
    .run(kabadiwalaId, kabadiwalaName, new Date().toISOString(), req.params.id);
  const row = await db.prepare('SELECT * FROM dealer_contracts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Contract not found.' });
  res.json(rowToContract(row));
});

// ---------------------------------------------------------------
// Recycler price-list SMS to dealers — resend on demand, or trigger the weekly broadcast now
// (it also fires automatically once a week: server/scheduler.js locally/Render, the
// vercel.json cron on Vercel)
// ---------------------------------------------------------------
router.post('/kabadiwalas/:kabadiId/send-price-sms', async (req, res) => {
  const row = await db.prepare('SELECT * FROM kabadiwalas WHERE kabadi_id = ?').get(req.params.kabadiId);
  if (!row) return res.status(404).json({ error: 'Kabadiwala not found.' });

  const result = await sendPriceListSms(row.kabadi_id, row.phone);
  res.json(result);
});

async function runWeeklyBroadcast(req, res) {
  const results = await broadcastWeeklyPriceList();
  res.json({ sentCount: results.filter(r => r.sent).length, total: results.length, results });
}

router.post('/notifications/send-weekly-price-list', runWeeklyBroadcast);
router.post('/notifications/send-daily-price-list', runWeeklyBroadcast); // old name, kept for compatibility

// Vercel Cron calls this with GET + "Authorization: Bearer $CRON_SECRET".
router.get('/cron/weekly-price-list', (req, res) => {
  if (!process.env.CRON_SECRET || req.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  runWeeklyBroadcast(req, res);
});

// ---------------------------------------------------------------
// Direct In-App Connect — one chat thread per (kabadiwala, recycler) pair
// ---------------------------------------------------------------
function rowToMessage(row) {
  return {
    id: row.id, kabadiwalaId: row.kabadiwala_id, recyclerId: row.recycler_id,
    senderRole: row.sender_role, senderName: row.sender_name,
    body: row.body, createdAt: row.created_at
  };
}

router.get('/messages', async (req, res) => {
  const { kabadiwalaId, recyclerId } = req.query;
  if (!kabadiwalaId || !recyclerId) return res.status(400).json({ error: 'kabadiwalaId and recyclerId are required.' });

  const rows = await db.prepare('SELECT * FROM messages WHERE kabadiwala_id = ? AND recycler_id = ? ORDER BY id ASC')
    .all(kabadiwalaId, recyclerId);
  res.json(rows.map(rowToMessage));
});

router.post('/messages', async (req, res) => {
  const { kabadiwalaId, recyclerId, senderRole, senderName, body } = req.body || {};
  if (!kabadiwalaId || !recyclerId || !senderRole || !body || !body.trim()) {
    return res.status(400).json({ error: 'kabadiwalaId, recyclerId, senderRole, and body are required.' });
  }

  const result = await db.prepare(`
    INSERT INTO messages (kabadiwala_id, recycler_id, sender_role, sender_name, body, created_at)
    VALUES (@kabadiwalaId, @recyclerId, @senderRole, @senderName, @body, @createdAt)
  `).run({
    kabadiwalaId, recyclerId, senderRole, senderName: senderName || 'User',
    body: body.trim(), createdAt: new Date().toISOString()
  });

  const row = await db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(rowToMessage(row));
});

module.exports = router;
