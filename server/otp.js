// Phone OTP for scrap dealers (registration + login), delivered by Fast2SMS.
// Stored in the database (not memory) so it also works on stateless Vercel functions.
// Only a salted SHA-256 of the code is kept; codes expire, attempts are capped, and
// resends are rate-limited per phone.
const crypto = require('node:crypto');
const { db } = require('./db');
const { sendOtpSms } = require('./sms');

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;

class OtpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function hashCode(phone, purpose, code) {
  const secret = process.env.OTP_SECRET || process.env.FAST2SMS_API_KEY || 'ecoscrap-otp';
  return crypto.createHmac('sha256', secret).update(`${phone}:${purpose}:${code}`).digest('hex');
}

// OTP_DEMO_MODE=true returns the code in the API response (and logs it) when the SMS could
// not be delivered — for local demos without SMS credit. Never enable it in production.
function demoMode() {
  return process.env.OTP_DEMO_MODE === 'true';
}

async function requestOtp(phone, purpose) {
  const now = Date.now();
  const existing = await db.prepare('SELECT last_sent_at FROM otp_codes WHERE phone = ? AND purpose = ?').get(phone, purpose);
  if (existing && now - Date.parse(existing.last_sent_at) < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - Date.parse(existing.last_sent_at))) / 1000);
    throw new OtpError(`Please wait ${waitSec} seconds before requesting another OTP.`, 429);
  }

  const code = String(crypto.randomInt(100000, 1000000));
  await db.prepare(`
    INSERT INTO otp_codes (phone, purpose, code_hash, expires_at, attempts, last_sent_at)
    VALUES (@phone, @purpose, @codeHash, @expiresAt, 0, @sentAt)
    ON CONFLICT(phone, purpose) DO UPDATE SET
      code_hash = excluded.code_hash, expires_at = excluded.expires_at,
      attempts = 0, last_sent_at = excluded.last_sent_at
  `).run({
    phone, purpose, codeHash: hashCode(phone, purpose, code),
    expiresAt: new Date(now + OTP_TTL_MS).toISOString(), sentAt: new Date(now).toISOString()
  });

  const sms = await sendOtpSms(phone, code);
  await db.prepare(`
    INSERT INTO sms_log (phone, kabadi_id, message, sent, reason, created_at)
    VALUES (?, NULL, ?, ?, ?, ?)
  `).run(phone, `OTP (${purpose})`, sms.sent ? 1 : 0, sms.reason || null, new Date().toISOString());

  const result = { sent: sms.sent, expiresInSec: OTP_TTL_MS / 1000 };
  if (!sms.sent) {
    if (!demoMode()) throw new OtpError(`Could not send OTP SMS: ${sms.reason}`, 502);
    console.log(`[otp] DEMO MODE — SMS not delivered (${sms.reason}). OTP for ${phone}: ${code}`);
    result.demoOtp = code;
    result.reason = sms.reason;
  }
  return result;
}

// Throws OtpError if the code is wrong/expired; consumes the OTP on success.
async function verifyOtp(phone, purpose, code) {
  const row = await db.prepare('SELECT * FROM otp_codes WHERE phone = ? AND purpose = ?').get(phone, purpose);
  if (!row) throw new OtpError('No OTP was requested for this number. Tap "Send OTP" first.', 401);
  if (Date.parse(row.expires_at) < Date.now()) {
    await db.prepare('DELETE FROM otp_codes WHERE phone = ? AND purpose = ?').run(phone, purpose);
    throw new OtpError('This OTP has expired. Please request a new one.', 401);
  }
  if (row.attempts >= MAX_ATTEMPTS) throw new OtpError('Too many wrong attempts. Please request a new OTP.', 429);

  const given = hashCode(phone, purpose, String(code || '').trim());
  const ok = given.length === row.code_hash.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(row.code_hash));
  if (!ok) {
    await db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ? AND purpose = ?').run(phone, purpose);
    throw new OtpError('Incorrect OTP. Please check the SMS and try again.', 401);
  }
  await db.prepare('DELETE FROM otp_codes WHERE phone = ? AND purpose = ?').run(phone, purpose);
}

module.exports = { requestOtp, verifyOtp, OtpError };
