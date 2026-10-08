// Fires the weekly recycler price-list SMS broadcast automatically (default: every Monday
// 8:00 AM server-local time). Uses a plain setTimeout/reschedule loop — no external cron
// needed, but only runs while this Node process stays alive (Render / local). On Vercel the
// same broadcast is triggered by the cron in vercel.json instead.
const { broadcastWeeklyPriceList } = require('./priceNotify');

const WEEKLY_DAY = Number(process.env.PRICE_SMS_WEEKDAY ?? 1); // 0 = Sunday … 6 = Saturday
const WEEKLY_HOUR = Number(process.env.PRICE_SMS_HOUR ?? 8);
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout can't wait longer than ~24.8 days

function nextRunDate(day, hour) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  next.setDate(next.getDate() + ((day - next.getDay() + 7) % 7));
  if (next <= now) next.setDate(next.getDate() + 7);
  return next;
}

function startWeeklyPriceListScheduler() {
  function scheduleNext() {
    const runAt = nextRunDate(WEEKLY_DAY, WEEKLY_HOUR);
    console.log(`[scheduler] Next weekly price-list SMS broadcast: ${runAt.toString()}`);

    const wait = () => {
      const delay = runAt - Date.now();
      if (delay > 0) return setTimeout(wait, Math.min(delay, MAX_TIMEOUT_MS));
      fire();
    };
    wait();
  }

  async function fire() {
    console.log('[scheduler] Sending weekly price-list SMS to all registered dealers...');
    try {
      const results = await broadcastWeeklyPriceList();
      const sentCount = results.filter(r => r.sent).length;
      console.log(`[scheduler] Weekly price-list SMS sent to ${sentCount}/${results.length} dealers.`);
    } catch (err) {
      console.error('[scheduler] Weekly price-list broadcast failed:', err);
    }
    scheduleNext();
  }

  scheduleNext();
}

module.exports = { startWeeklyPriceListScheduler };
