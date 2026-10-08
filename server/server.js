require('./env').loadEnv();

const path = require('node:path');
const express = require('express');
const { initDb } = require('./db');
const apiRouter = require('./api');
const { startDailyPriceListScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Larger limit for /api/scan photo uploads (downscaled client-side to ~1MB or less).
app.use(express.json({ limit: '8mb' }));
app.use('/api', apiRouter);

const PROJECT_ROOT = path.join(__dirname, '..');
// The frontend is served straight from the project root, so keep the database, installed
// packages and server code from being downloadable (data/esetu.db holds dealer PINs).
app.use(['/data', '/node_modules', '/server', '/api'], (req, res) => res.status(404).end());
app.use(express.static(PROJECT_ROOT));

app.get('*', (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`EcoScrap AI server running at http://localhost:${PORT}`);
      console.log(`  [db] ${process.env.TURSO_DATABASE_URL ? 'Turso (remote)' : 'local file (data/esetu.db)'}`);
      if (!process.env.FAST2SMS_API_KEY) {
        console.log('  [sms] FAST2SMS_API_KEY not set in .env — price-list SMS will be skipped (logged, not sent).');
      }
      if (process.env.GEMINI_API_KEY) {
        console.log(`  [scan] On-device YOLO scanner + Gemini grading (${process.env.GEMINI_MODEL || 'gemini-3.8-flash'})`);
      } else {
        console.log('  [scan] GEMINI_API_KEY not set — on-device YOLO still identifies materials; condition grading is skipped.');
      }
      startDailyPriceListScheduler();
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
