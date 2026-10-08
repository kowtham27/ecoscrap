// SMS sending. Two providers:
//  - textbee.dev (FREE): sends through your own Android phone's SIM via the textbee app.
//    Used whenever TEXTBEE_API_KEY + TEXTBEE_DEVICE_ID are set.
//  - Fast2SMS (paid; its API needs a one-time ₹100 recharge): "q" Quick SMS route for custom
//    text (no DLT template needed) and the "otp" route for codes.
const FAST2SMS_URL = 'https://www.fast2sms.com/dev/bulkV2';
const TEXTBEE_URL = 'https://api.textbee.dev/api/v1/gateway/devices';

function useTextbee() {
  return !!(process.env.TEXTBEE_API_KEY && process.env.TEXTBEE_DEVICE_ID);
}

async function callTextbee(phone, message) {
  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  if (cleanPhone.length !== 10) {
    return { sent: false, reason: `Invalid 10-digit phone number: "${phone}"` };
  }
  try {
    const res = await fetch(`${TEXTBEE_URL}/${encodeURIComponent(process.env.TEXTBEE_DEVICE_ID)}/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.TEXTBEE_API_KEY },
      body: JSON.stringify({ recipients: [`+91${cleanPhone}`], message })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && !(data.data && data.data.success === false)) {
      return { sent: true, requestId: (data.data && (data.data.smsBatchId || data.data._id)) || null };
    }
    return { sent: false, reason: data.message || data.error || `textbee error (HTTP ${res.status})` };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

async function callFast2Sms(phone, extraParams) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    return { sent: false, reason: 'FAST2SMS_API_KEY is not set on the server — SMS skipped.' };
  }

  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  if (cleanPhone.length !== 10) {
    return { sent: false, reason: `Invalid 10-digit phone number: "${phone}"` };
  }

  const params = new URLSearchParams({ ...extraParams, flash: '0', numbers: cleanPhone });

  try {
    const res = await fetch(`${FAST2SMS_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { authorization: apiKey }
    });
    const data = await res.json();
    if (data && data.return === true) {
      return { sent: true, requestId: data.request_id };
    }
    return { sent: false, reason: (data && data.message) ? [].concat(data.message).join(', ') : 'Fast2SMS rejected the request.' };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

function sendSms(phone, message) {
  if (useTextbee()) return callTextbee(phone, message);
  return callFast2Sms(phone, { route: 'q', message, language: 'english' });
}

// OTP: Fast2SMS's dedicated OTP route ("Your OTP: 123456") first; if the account can't
// use that route, fall back to a Quick SMS with our own wording.
async function sendOtpSms(phone, otp) {
  if (useTextbee()) return sendSms(phone, `${otp} is your EcoScrap AI verification code. Valid for 5 minutes. Do not share it with anyone.`);
  const viaOtpRoute = await callFast2Sms(phone, { route: 'otp', variables_values: otp });
  if (viaOtpRoute.sent) return viaOtpRoute;
  console.warn('[sms] OTP route failed, retrying via Quick SMS:', viaOtpRoute.reason);
  return sendSms(phone, `${otp} is your EcoScrap AI verification code. Valid for 5 minutes. Do not share it with anyone.`);
}

// materialRows: [{ symbol, recycler_rate, best_rate?, best_buyer? }] — best_rate/best_buyer
// come from recyclers' own posted rates (recycler_material_rates), when any beat the board rate.
function buildPriceListMessage(materialRows, { weekly = false } = {}) {
  const lines = materialRows.map((m) => {
    const rate = m.best_rate || m.recycler_rate;
    return `${m.symbol} Rs${rate}/kg${m.best_buyer ? ` (${m.best_buyer})` : ''}`;
  });
  const heading = weekly ? "This Week's Recycler Buying Rates" : "Today's Recycler Buying Rates";
  return `EcoScrap AI - ${heading}: ${lines.join(', ')}. Open the app to sell your lots.`;
}

module.exports = { sendSms, sendOtpSms, buildPriceListMessage };
