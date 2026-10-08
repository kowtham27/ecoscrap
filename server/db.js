// E-Setu real persistence layer — libSQL (SQLite-compatible).
// Locally this talks to a plain file (data/esetu.db) with zero setup, just like before.
// In production it points at Turso (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN) — same client,
// same SQL, same code path either way, so nothing behaves differently between the two.
const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@libsql/client');
const SEED_DATA = require('./seed-data');

const usingTurso = !!process.env.TURSO_DATABASE_URL;
console.log('[db] TURSO_DATABASE_URL present:', usingTurso);

// Only touch the local filesystem when actually falling back to a local file —
// serverless platforms (Vercel) have a read-only filesystem and would crash
// on this mkdir even though they never use the path (they always set Turso vars).
// Wrapped defensively too: a failure here should never be fatal on its own.
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!usingTurso) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[db] Could not create local data dir (non-fatal):', err.message);
  }
}

const url = usingTurso ? process.env.TURSO_DATABASE_URL : `file:${path.join(DATA_DIR, 'esetu.db')}`;
const client = createClient(usingTurso ? { url, authToken: process.env.TURSO_AUTH_TOKEN } : { url });

// Call-site compatibility shim: every existing call is either
//   db.prepare(sql).get/all/run({ named: 'params' })   — used for INSERT/UPDATE
//   db.prepare(sql).get/all/run(pos1, pos2, ...)        — used for '?' SELECT filters
// libSQL's execute() accepts either shape as `args`, so this just routes to it async.
function toLibsqlArgs(args) {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return args[0];
  }
  return args;
}

const db = {
  async exec(sql) {
    await client.executeMultiple(sql);
  },
  prepare(sql) {
    return {
      async get(...args) {
        const result = await client.execute({ sql, args: toLibsqlArgs(args) });
        return result.rows[0] ? { ...result.rows[0] } : undefined;
      },
      async all(...args) {
        const result = await client.execute({ sql, args: toLibsqlArgs(args) });
        return result.rows.map((r) => ({ ...r }));
      },
      async run(...args) {
        const result = await client.execute({ sql, args: toLibsqlArgs(args) });
        return { lastInsertRowid: result.lastInsertRowid, changes: result.rowsAffected };
      }
    };
  }
};

async function createSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      symbol TEXT UNIQUE,
      name TEXT, name_mr TEXT, name_hi TEXT, name_ta TEXT, name_te TEXT, name_kn TEXT, name_ml TEXT,
      icon TEXT, unit TEXT,
      customer_rate REAL, recycler_rate REAL, rate_6hr_ago REAL, recycler_rate_6hr_ago REAL,
      day_high REAL, day_low REAL, volume TEXT, change_pct TEXT, is_positive INTEGER,
      sparkline_json TEXT, description TEXT, metals TEXT, hazard_level TEXT, proper_process TEXT
    );

    CREATE TABLE IF NOT EXISTS kabadiwalas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kabadi_id TEXT UNIQUE,
      name TEXT, phone TEXT UNIQUE, pin TEXT, yard TEXT, location TEXT,
      vehicle TEXT, photo TEXT, rating REAL, total_reviews INTEGER, badge TEXT,
      reviews_json TEXT, extra_json TEXT, created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS recyclers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cpcb_reg_no TEXT UNIQUE,
      name TEXT, phone TEXT, facility TEXT, location TEXT,
      rates_json TEXT, rating REAL, reviews_json TEXT, extra_json TEXT, created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_id TEXT UNIQUE,
      kabadiwala_id TEXT, kabadiwala_name TEXT,
      recycler_id TEXT, recycler_name TEXT,
      material TEXT, symbol TEXT, weight_kg REAL, agreed_rate REAL, total_amount REAL,
      payment_method TEXT, payment_status TEXT, status TEXT,
      gps_location TEXT, cpcb_manifest_no TEXT, epr_cert_issued INTEGER,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS safety_guides (
      id TEXT PRIMARY KEY,
      title TEXT, title_mr TEXT, title_hi TEXT, icon TEXT, color TEXT,
      hazard TEXT, health_risk TEXT, safe_method TEXT,
      audio_script_en TEXT, audio_script_mr TEXT, audio_script_hi TEXT
    );

    CREATE TABLE IF NOT EXISTS sms_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT, kabadi_id TEXT, message TEXT,
      sent INTEGER, reason TEXT, created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kabadiwala_id TEXT NOT NULL,
      recycler_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(kabadiwala_id, recycler_id);

    CREATE TABLE IF NOT EXISTS customer_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_code TEXT UNIQUE,
      customer_phone TEXT NOT NULL,
      customer_name TEXT,
      kabadiwala_id TEXT, kabadiwala_name TEXT,
      material_id TEXT, material_name TEXT, symbol TEXT,
      weight_kg REAL, rate_per_kg REAL,
      quality_grade TEXT, quality_multiplier REAL DEFAULT 1.0,
      total_amount REAL, payment_mode TEXT,
      status TEXT NOT NULL DEFAULT 'Requested',
      gps_lat REAL, gps_lng REAL, photo_data_url TEXT,
      pooled_lot_id TEXT,
      created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_customer ON customer_bookings(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_bookings_kabadiwala ON customer_bookings(kabadiwala_id, status);

    CREATE TABLE IF NOT EXISTS recycler_material_rates (
      recycler_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      rate REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (recycler_id, material_id)
    );

    CREATE TABLE IF NOT EXISTS collection_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kabadiwala_id TEXT NOT NULL,
      kabadiwala_name TEXT,
      area_pincode TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_pincode ON collection_schedules(area_pincode);

    CREATE TABLE IF NOT EXISTS institutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT,
      contact_name TEXT, phone TEXT,
      location TEXT, latitude REAL, longitude REAL,
      linked_kabadiwala_id TEXT, linked_kabadiwala_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dealer_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL, customer_type TEXT NOT NULL, customer_name TEXT,
      kabadiwala_id TEXT NOT NULL, kabadiwala_name TEXT,
      start_date TEXT NOT NULL, duration_days INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id TEXT NOT NULL,
      recycler_rate REAL, customer_rate REAL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_history_material ON rate_history(material_id, recorded_at);
  `);
}

// Additive, idempotent column migrations for tables that already existed before a given
// feature was added — safe to run every boot against a live local or Turso database that
// may already have rows (never drops or renames anything).
async function migrateColumns(table, columns) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  const existing = new Set(info.map((c) => c.name));
  for (const { name, ddl } of columns) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl};`);
    }
  }
}

async function runMigrations() {
  await migrateColumns('kabadiwalas', [
    { name: 'latitude', ddl: 'REAL' },
    { name: 'longitude', ddl: 'REAL' }
  ]);
  await migrateColumns('recyclers', [
    { name: 'latitude', ddl: 'REAL' },
    { name: 'longitude', ddl: 'REAL' }
  ]);
  await migrateColumns('lots', [
    { name: 'gps_lat', ddl: 'REAL' },
    { name: 'gps_lng', ddl: 'REAL' },
    { name: 'quality_grade', ddl: 'TEXT' },
    { name: 'quality_multiplier', ddl: 'REAL DEFAULT 1.0' },
    { name: 'pooled_booking_ids_json', ddl: 'TEXT' }
  ]);
  await migrateColumns('materials', [
    { name: 'co2_factor_kg_per_kg', ddl: 'REAL DEFAULT 0' }
  ]);
  // Secure Payment to Collector: payment is held against a one-time handover code and
  // only released once the code is confirmed, with the weighed weight + amount actually
  // paid recorded so a short payment is flagged instead of silently closing the booking.
  await migrateColumns('customer_bookings', [
    { name: 'payment_status', ddl: "TEXT DEFAULT 'Held'" },
    { name: 'handover_otp', ddl: 'TEXT' },
    { name: 'weighed_kg', ddl: 'REAL' },
    { name: 'amount_paid', ddl: 'REAL' },
    { name: 'payment_flag', ddl: 'TEXT' },
    { name: 'confirmed_by', ddl: 'TEXT' }
  ]);
  await migrateColumns('rate_history', [
    { name: 'source', ddl: "TEXT DEFAULT 'live'" }
  ]);
  // Safety guide content originally only had English hazard/health-risk/safe-method text
  // (even the title/audio-script fields stopped at Hindi/Marathi) — extending to all 7
  // languages so Tamil/Telugu/Kannada/Malayalam users never silently see Hindi or English
  // for genuinely safety-critical warnings.
  await migrateColumns('safety_guides', [
    { name: 'title_ta', ddl: 'TEXT' }, { name: 'title_te', ddl: 'TEXT' },
    { name: 'title_kn', ddl: 'TEXT' }, { name: 'title_ml', ddl: 'TEXT' },
    { name: 'hazard_hi', ddl: 'TEXT' }, { name: 'hazard_mr', ddl: 'TEXT' },
    { name: 'hazard_ta', ddl: 'TEXT' }, { name: 'hazard_te', ddl: 'TEXT' },
    { name: 'hazard_kn', ddl: 'TEXT' }, { name: 'hazard_ml', ddl: 'TEXT' },
    { name: 'health_risk_hi', ddl: 'TEXT' }, { name: 'health_risk_mr', ddl: 'TEXT' },
    { name: 'health_risk_ta', ddl: 'TEXT' }, { name: 'health_risk_te', ddl: 'TEXT' },
    { name: 'health_risk_kn', ddl: 'TEXT' }, { name: 'health_risk_ml', ddl: 'TEXT' },
    { name: 'safe_method_hi', ddl: 'TEXT' }, { name: 'safe_method_mr', ddl: 'TEXT' },
    { name: 'safe_method_ta', ddl: 'TEXT' }, { name: 'safe_method_te', ddl: 'TEXT' },
    { name: 'safe_method_kn', ddl: 'TEXT' }, { name: 'safe_method_ml', ddl: 'TEXT' },
    { name: 'audio_script_ta', ddl: 'TEXT' }, { name: 'audio_script_te', ddl: 'TEXT' },
    { name: 'audio_script_kn', ddl: 'TEXT' }, { name: 'audio_script_ml', ddl: 'TEXT' }
  ]);
}

async function seedIfEmpty() {
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM materials').get();
  if (Number(countRow.c) > 0) return; // already seeded on a previous run

  const insertMaterial = db.prepare(`
    INSERT INTO materials (id, symbol, name, name_mr, name_hi, name_ta, name_te, name_kn, name_ml,
      icon, unit, customer_rate, recycler_rate, rate_6hr_ago, recycler_rate_6hr_ago,
      day_high, day_low, volume, change_pct, is_positive, sparkline_json, description, metals, hazard_level, proper_process)
    VALUES (@id, @symbol, @name, @nameMr, @nameHi, @nameTa, @nameTe, @nameKn, @nameMl,
      @icon, @unit, @customerRate, @recyclerRate, @rate6hrAgo, @recyclerRate6hrAgo,
      @dayHigh, @dayLow, @volume, @changePct, @isPositive, @sparklineJson, @description, @metals, @hazardLevel, @properProcess)
  `);
  for (const m of SEED_DATA.materials) {
    await insertMaterial.run({
      id: m.id, symbol: m.symbol, name: m.name, nameMr: m.nameMr, nameHi: m.nameHi,
      nameTa: m.nameTa, nameTe: m.nameTe, nameKn: m.nameKn, nameMl: m.nameMl,
      icon: m.icon, unit: m.unit, customerRate: m.customerRate, recyclerRate: m.recyclerRate,
      rate6hrAgo: m.rate6hrAgo, recyclerRate6hrAgo: m.recyclerRate6hrAgo,
      dayHigh: m.dayHigh, dayLow: m.dayLow, volume: m.volume, changePct: m.changePct,
      isPositive: m.isPositive ? 1 : 0, sparklineJson: JSON.stringify(m.sparkline),
      description: m.description, metals: m.metals, hazardLevel: m.hazardLevel, properProcess: m.properProcess
    });
  }

  const insertKabadiwala = db.prepare(`
    INSERT INTO kabadiwalas (kabadi_id, name, phone, pin, yard, location, vehicle, photo, rating, total_reviews, badge, reviews_json, extra_json, created_at)
    VALUES (@kabadiId, @name, @phone, @pin, @yard, @location, @vehicle, @photo, @rating, @totalReviews, @badge, @reviewsJson, @extraJson, @createdAt)
  `);
  const KABADIWALA_CORE_FIELDS = new Set(['id', 'name', 'phone', 'location', 'vehicle', 'photo', 'rating', 'totalReviews', 'badge', 'reviews']);
  for (const auth of SEED_DATA.predefinedKabadiwalas) {
    const idx = SEED_DATA.predefinedKabadiwalas.indexOf(auth);
    const display = SEED_DATA.kabadiwalas[idx] || {};
    const extra = {};
    for (const key of Object.keys(display)) {
      if (!KABADIWALA_CORE_FIELDS.has(key)) extra[key] = display[key];
    }
    await insertKabadiwala.run({
      kabadiId: auth.kabadiId, name: auth.name, phone: auth.phone, pin: auth.pin,
      yard: auth.yard, location: auth.location,
      vehicle: display.vehicle || 'Scrap Collection Vehicle', photo: display.photo || '👨🏽‍💼',
      rating: display.rating || 4.5, totalReviews: display.totalReviews || 0,
      badge: display.badge || 'Verified E-Setu Partner',
      reviewsJson: JSON.stringify(display.reviews || []),
      extraJson: JSON.stringify(extra),
      createdAt: new Date().toISOString()
    });
  }

  const insertRecycler = db.prepare(`
    INSERT INTO recyclers (cpcb_reg_no, name, phone, facility, location, rates_json, rating, reviews_json, extra_json, created_at)
    VALUES (@cpcbRegNo, @name, @phone, @facility, @location, @ratesJson, @rating, @reviewsJson, @extraJson, @createdAt)
  `);
  const RECYCLER_CORE_FIELDS = new Set(['id', 'name', 'cpcbRegNo', 'location', 'rates', 'rating', 'kabadiwalaReviews']);
  for (const auth of SEED_DATA.predefinedRecyclers) {
    const display = SEED_DATA.recyclers.find(r => r.cpcbRegNo === auth.cpcbRegNo) || {};
    const extra = {};
    for (const key of Object.keys(display)) {
      if (!RECYCLER_CORE_FIELDS.has(key)) extra[key] = display[key];
    }
    await insertRecycler.run({
      cpcbRegNo: auth.cpcbRegNo, name: auth.name, phone: auth.phone, facility: auth.facility,
      location: display.location || auth.facility,
      ratesJson: JSON.stringify(display.rates || {}),
      rating: display.rating || 4.5,
      reviewsJson: JSON.stringify(display.kabadiwalaReviews || []),
      extraJson: JSON.stringify(extra),
      createdAt: new Date().toISOString()
    });
  }
  const extraValid = SEED_DATA.validCpcbRegistrations.filter(
    no => !SEED_DATA.predefinedRecyclers.some(r => r.cpcbRegNo === no)
  );
  for (const cpcbRegNo of extraValid) {
    await insertRecycler.run({
      cpcbRegNo, name: 'Authorized Recycler (Not Yet Onboarded)', phone: '', facility: '',
      location: '', ratesJson: '{}', rating: 0, reviewsJson: '[]', extraJson: '{}', createdAt: new Date().toISOString()
    });
  }

  const insertLot = db.prepare(`
    INSERT INTO lots (lot_id, kabadiwala_id, kabadiwala_name, recycler_id, recycler_name, material, symbol,
      weight_kg, agreed_rate, total_amount, payment_method, payment_status, status, gps_location,
      cpcb_manifest_no, epr_cert_issued, created_at)
    VALUES (@lotId, @kabadiwalaId, @kabadiwalaName, @recyclerId, @recyclerName, @material, @symbol,
      @weightKg, @agreedRate, @totalAmount, @paymentMethod, @paymentStatus, @status, @gpsLocation,
      @cpcbManifestNo, @eprCertIssued, @createdAt)
  `);
  for (const lot of SEED_DATA.lots) {
    await insertLot.run({
      lotId: lot.lotId, kabadiwalaId: lot.kabadiwalaId, kabadiwalaName: lot.kabadiwalaName,
      recyclerId: lot.recyclerId, recyclerName: lot.recyclerName, material: lot.material, symbol: lot.symbol,
      weightKg: lot.weightKg, agreedRate: lot.agreedRate, totalAmount: lot.totalAmount,
      paymentMethod: lot.paymentMethod, paymentStatus: lot.paymentStatus, status: lot.status,
      gpsLocation: lot.gpsLocation, cpcbManifestNo: lot.cpcbManifestNo,
      eprCertIssued: lot.eprCertIssued ? 1 : 0, createdAt: lot.date
    });
  }

  const insertSafety = db.prepare(`
    INSERT INTO safety_guides (id, title, title_mr, title_hi, title_ta, title_te, title_kn, title_ml,
      icon, color, hazard, hazard_hi, hazard_mr, hazard_ta, hazard_te, hazard_kn, hazard_ml,
      health_risk, health_risk_hi, health_risk_mr, health_risk_ta, health_risk_te, health_risk_kn, health_risk_ml,
      safe_method, safe_method_hi, safe_method_mr, safe_method_ta, safe_method_te, safe_method_kn, safe_method_ml,
      audio_script_en, audio_script_mr, audio_script_hi, audio_script_ta, audio_script_te, audio_script_kn, audio_script_ml)
    VALUES (@id, @title, @titleMr, @titleHi, @titleTa, @titleTe, @titleKn, @titleMl,
      @icon, @color, @hazard, @hazardHi, @hazardMr, @hazardTa, @hazardTe, @hazardKn, @hazardMl,
      @healthRisk, @healthRiskHi, @healthRiskMr, @healthRiskTa, @healthRiskTe, @healthRiskKn, @healthRiskMl,
      @safeMethod, @safeMethodHi, @safeMethodMr, @safeMethodTa, @safeMethodTe, @safeMethodKn, @safeMethodMl,
      @audioScriptEn, @audioScriptMr, @audioScriptHi, @audioScriptTa, @audioScriptTe, @audioScriptKn, @audioScriptMl)
  `);
  for (const g of SEED_DATA.safetyGuides) {
    await insertSafety.run(g);
  }
}

async function seedCo2FactorsIfMissing() {
  const rows = await db.prepare('SELECT id FROM materials WHERE co2_factor_kg_per_kg IS NULL OR co2_factor_kg_per_kg = 0').all();
  if (!rows.length) return;
  for (const row of rows) {
    const factor = SEED_DATA.co2FactorsByMaterialId[row.id];
    if (factor) await db.prepare('UPDATE materials SET co2_factor_kg_per_kg = ? WHERE id = ?').run(factor, row.id);
  }
}

// Backfills the 7-language safety-guide columns onto rows that were seeded before this
// translation work existed (a live deployment's safety_guides rows predate the ta/te/kn/ml
// and hi/mr hazard/health-risk/safe-method columns added above).
async function seedSafetyGuideTranslationsIfMissing() {
  const rows = await db.prepare('SELECT id FROM safety_guides WHERE title_ta IS NULL').all();
  if (!rows.length) return;
  const byId = Object.fromEntries(SEED_DATA.safetyGuides.map((g) => [g.id, g]));
  for (const row of rows) {
    const g = byId[row.id];
    if (!g) continue;
    // The libsql/Turso HTTP driver requires the args object to have exactly the same
    // number of properties as named parameters in the SQL — passing the full seed-data
    // object (which also carries title/icon/color/hazard/etc. not referenced here) throws
    // "Number of arguments mismatch", so only the 27 referenced fields are picked out.
    await db.prepare(`
      UPDATE safety_guides SET
        title_ta = @titleTa, title_te = @titleTe, title_kn = @titleKn, title_ml = @titleMl,
        hazard_hi = @hazardHi, hazard_mr = @hazardMr, hazard_ta = @hazardTa, hazard_te = @hazardTe, hazard_kn = @hazardKn, hazard_ml = @hazardMl,
        health_risk_hi = @healthRiskHi, health_risk_mr = @healthRiskMr, health_risk_ta = @healthRiskTa, health_risk_te = @healthRiskTe, health_risk_kn = @healthRiskKn, health_risk_ml = @healthRiskMl,
        safe_method_hi = @safeMethodHi, safe_method_mr = @safeMethodMr, safe_method_ta = @safeMethodTa, safe_method_te = @safeMethodTe, safe_method_kn = @safeMethodKn, safe_method_ml = @safeMethodMl,
        audio_script_ta = @audioScriptTa, audio_script_te = @audioScriptTe, audio_script_kn = @audioScriptKn, audio_script_ml = @audioScriptMl
      WHERE id = @id
    `).run({
      id: g.id,
      titleTa: g.titleTa, titleTe: g.titleTe, titleKn: g.titleKn, titleMl: g.titleMl,
      hazardHi: g.hazardHi, hazardMr: g.hazardMr, hazardTa: g.hazardTa, hazardTe: g.hazardTe, hazardKn: g.hazardKn, hazardMl: g.hazardMl,
      healthRiskHi: g.healthRiskHi, healthRiskMr: g.healthRiskMr, healthRiskTa: g.healthRiskTa, healthRiskTe: g.healthRiskTe, healthRiskKn: g.healthRiskKn, healthRiskMl: g.healthRiskMl,
      safeMethodHi: g.safeMethodHi, safeMethodMr: g.safeMethodMr, safeMethodTa: g.safeMethodTa, safeMethodTe: g.safeMethodTe, safeMethodKn: g.safeMethodKn, safeMethodMl: g.safeMethodMl,
      audioScriptTa: g.audioScriptTa, audioScriptTe: g.audioScriptTe, audioScriptKn: g.audioScriptKn, audioScriptMl: g.audioScriptMl
    });
  }
}

// Price History needs a starting curve — without it a fresh install shows an empty chart
// until a recycler happens to publish a rate. The seed sparkline is spread back over the
// last 27 days and tagged source='seed' so the UI can label it; every real rate change
// after that is appended as source='live' by PATCH /materials/:id/rate.
async function seedRateHistoryIfEmpty() {
  const materials = await db.prepare('SELECT id, recycler_rate, customer_rate, sparkline_json FROM materials').all();
  const DAY = 24 * 60 * 60 * 1000;
  for (const m of materials) {
    const existing = await db.prepare('SELECT COUNT(*) AS c FROM rate_history WHERE material_id = ?').get(m.id);
    if (Number(existing.c) > 0) continue;
    const points = JSON.parse(m.sparkline_json || '[]');
    if (!points.length) continue;
    const ratio = m.recycler_rate ? m.customer_rate / m.recycler_rate : 1;
    const step = 3 * DAY;
    const start = Date.now() - (points.length - 1) * step;
    for (let i = 0; i < points.length; i++) {
      await db.prepare(`
        INSERT INTO rate_history (material_id, recycler_rate, customer_rate, recorded_at, source)
        VALUES (?, ?, ?, ?, 'seed')
      `).run(m.id, points[i], Math.round(points[i] * ratio), new Date(start + i * step).toISOString());
    }
  }
}

let initPromise = null;
function initDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await createSchema();
      await runMigrations();
      await seedIfEmpty();
      await seedCo2FactorsIfMissing();
      await seedSafetyGuideTranslationsIfMissing();
      await seedRateHistoryIfEmpty();
    })();
  }
  return initPromise;
}

module.exports = { db, initDb };
