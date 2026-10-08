// Fast2SMS demo — sends one sample of each EcoScrap SMS to a phone number you own:
//   1. the weekly recycler price list a registered dealer receives
//   2. a dealer verification OTP (sample code, not tied to any login)
// Usage:  npm run sms:demo -- 9876543210
//         npm run sms:demo -- 9876543210 --preview   (print the texts, send nothing)
require('../server/env').loadEnv();

const { initDb } = require('../server/db');
const { loadRecyclerPriceList } = require('../server/priceNotify');
const { sendSms, sendOtpSms, buildPriceListMessage } = require('../server/sms');

async function main() {
  const phone = (process.argv[2] || '').replace(/\D/g, '').slice(-10);
  const preview = process.argv.includes('--preview');
  if (!/^[6-9]\d{9}$/.test(phone)) {
    console.error('Usage: npm run sms:demo -- <10-digit mobile number> [--preview]');
    process.exit(1);
  }
  if (!preview && !process.env.FAST2SMS_API_KEY && !(process.env.TEXTBEE_API_KEY && process.env.TEXTBEE_DEVICE_ID)) {
    console.error('No SMS provider set in .env — add TEXTBEE_API_KEY + TEXTBEE_DEVICE_ID (free) or FAST2SMS_API_KEY.');
    process.exit(1);
  }

  await initDb();
  const priceList = buildPriceListMessage(await loadRecyclerPriceList(), { weekly: true });
  const sampleOtp = String(Math.floor(100000 + Math.random() * 900000));

  console.log(`\n1) Weekly price list SMS (${priceList.length} chars):\n   ${priceList}`);
  console.log(`\n2) OTP SMS sample code: ${sampleOtp}\n`);
  if (preview) return;

  const r1 = await sendSms(phone, priceList);
  console.log(r1.sent ? `✅ Price list sent to ${phone} (request ${r1.requestId})` : `❌ Price list not sent: ${r1.reason}`);
  const r2 = await sendOtpSms(phone, sampleOtp);
  console.log(r2.sent ? `✅ OTP ${sampleOtp} sent to ${phone} (request ${r2.requestId})` : `❌ OTP not sent: ${r2.reason}`);
  process.exit(r1.sent && r2.sent ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
