// EcoScrap AI — pricing utilities. Pure, offline calculations (the photo scanner itself
// lives in js/scrap-scanner.js and server/gemini-scan.js).

// Compares an offered/agreed rate against a benchmark rate and flags it as fair, low, or
// high once the deviation passes `tolerancePct` (default 15%). Reused unchanged by the
// Fair Price Detector (Create Lot modal) and the Fraud/Underpayment Alert (payment
// confirmation) — one utility, two call sites.
function evaluateFairPrice(offeredRate, benchmarkRate, tolerancePct = 15) {
  const offered = Number(offeredRate) || 0;
  const benchmark = Number(benchmarkRate) || 0;
  if (!benchmark) return { status: 'fair', deviationPct: 0 };

  const deviationPct = ((offered - benchmark) / benchmark) * 100;
  let status = 'fair';
  if (deviationPct <= -tolerancePct) status = 'low';
  else if (deviationPct >= tolerancePct) status = 'high';

  return { status, deviationPct: Math.round(deviationPct * 10) / 10 };
}

// Renders a small inline-SVG sparkline for a series of numeric values — no chart library,
// matching this project's zero-dependency frontend.
function buildSparklineSvg(values, { width = 120, height = 32, color = '#16a34a' } = {}) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values.map((v, i) => {
    const x = Math.round(i * stepX * 10) / 10;
    const y = Math.round((height - ((v - min) / range) * height) * 10) / 10;
    return `${x},${y}`;
  }).join(' ');

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="display:block;">
    <polyline points="${points}" fill="none" style="stroke:${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

window.PriceUtils = { evaluateFairPrice, buildSparklineSvg };
