// Shared price-list SMS logic — used on registration, manual resend, and the weekly broadcast.
const { db } = require('./db');
const { sendSms, buildPriceListMessage } = require('./sms');

// Board recycler rate per material, upgraded to the best rate any registered recycler has
// posted for it themselves (recycler_material_rates), with that recycler's name.
async function loadRecyclerPriceList() {
  const [materials, overrides] = await Promise.all([
    db.prepare('SELECT id, symbol, recycler_rate FROM materials').all(),
    db.prepare(`
      SELECT r.material_id, r.rate, rc.name AS recycler_name
      FROM recycler_material_rates r
      LEFT JOIN recyclers rc ON 'rec-' || rc.id = r.recycler_id
    `).all()
  ]);
  return materials.map((m) => {
    const best = overrides
      .filter((o) => o.material_id === m.id && o.rate > m.recycler_rate)
      .sort((a, b) => b.rate - a.rate)[0];
    return best
      ? { ...m, best_rate: best.rate, best_buyer: (best.recycler_name || '').split(' ').slice(0, 2).join(' ') }
      : m;
  });
}

async function sendPriceListSms(kabadiId, phone, { weekly = false } = {}) {
  const message = buildPriceListMessage(await loadRecyclerPriceList(), { weekly });
  const result = await sendSms(phone, message);

  await db.prepare(`
    INSERT INTO sms_log (phone, kabadi_id, message, sent, reason, created_at)
    VALUES (@phone, @kabadiId, @message, @sent, @reason, @createdAt)
  `).run({
    phone, kabadiId, message, sent: result.sent ? 1 : 0,
    reason: result.reason || null, createdAt: new Date().toISOString()
  });

  return result;
}

async function broadcastWeeklyPriceList() {
  const kabadiwalas = await db.prepare('SELECT kabadi_id, phone FROM kabadiwalas').all();
  const results = [];
  for (const k of kabadiwalas) {
    const result = await sendPriceListSms(k.kabadi_id, k.phone, { weekly: true });
    results.push({ kabadiId: k.kabadi_id, phone: k.phone, ...result });
  }
  return results;
}

module.exports = { sendPriceListSms, broadcastWeeklyPriceList, loadRecyclerPriceList };
