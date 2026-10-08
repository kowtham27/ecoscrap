// Vercel serverless entry point. Vercel runs stateless functions (no persistent
// process), so unlike server/server.js this does NOT start the daily SMS
// scheduler (a setTimeout-based timer can't survive between invocations here) —
// the automatic daily broadcast only runs on the Render deployment. Manual
// "send now" buttons still work fine since those are real per-request calls.
require('../server/env').loadEnv();

const path = require('node:path');
const express = require('express');
const { initDb } = require('../server/db');
const apiRouter = require('../server/api');

const app = express();

// Larger limit for /api/scan photo uploads (downscaled client-side to ~1MB or less).
app.use(express.json({ limit: '8mb' }));

let dbReadyPromise = null;
app.use((req, res, next) => {
  if (!dbReadyPromise) dbReadyPromise = initDb();
  dbReadyPromise.then(() => next()).catch((err) => {
    console.error('Failed to initialize database:', err);
    res.status(500).json({ error: 'Database initialization failed.' });
  });
});

app.use('/api', apiRouter);

const PROJECT_ROOT = path.join(__dirname, '..');
app.use(express.static(PROJECT_ROOT));

app.get('*', (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'index.html'));
});

module.exports = app;
