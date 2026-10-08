// AI Scrap Scanner & Quality Checker — real image recognition through the Gemini API.
// The photo is sent from the browser to this server, and only the server talks to Google,
// so GEMINI_API_KEY never reaches the client. Gemini is constrained to a JSON schema whose
// materialId is an enum of the platform's own materials, so it can only answer with a
// material we actually price (or "none" when the photo isn't recognisable e-waste).

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const REQUEST_TIMEOUT_MS = 25000;

// Same grade -> payout multiplier table the calculator already used.
const GRADES = {
  A: { qualityMultiplier: 1.1, gradeLabel: 'High Grade' },
  B: { qualityMultiplier: 1.0, gradeLabel: 'Standard Grade' },
  C: { qualityMultiplier: 0.85, gradeLabel: 'Mixed / Lower Grade' }
};

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

function buildPrompt(materials) {
  const catalogue = materials.map((m) =>
    `- ${m.id} (${m.symbol}): ${m.name}. Typical items: ${m.description || 'n/a'}`
  ).join('\n');

  return `You are the scrap-intake inspector for an Indian e-waste collection platform.
Identify the main e-waste item in the photo and map it to exactly ONE material id from this catalogue:
${catalogue}

Mapping rules:
- Whole phones, laptops, routers, set-top boxes, hard drives and bare circuit boards -> the PCB material (the board is what carries the value).
- Loose cables, chargers with long leads, wire bundles -> copper wire.
- Phone/laptop/power-bank/EV batteries, including swollen ones -> lithium-ion batteries.
- Old curved-glass tube TVs/monitors -> CRT. Flat TVs, monitors, laptop screens on their own -> LCD/LED.
- Fans, mixer/grinder motors, speakers with magnets, compressors -> motors & magnets.
- Plastic casings, keyboards, remote shells with no boards -> plastics.
- If the photo is not e-waste, is too blurry/dark to judge, or shows no object, use "none".

Grade the condition for resale/recovery value:
- A: clean, intact, single material type, little contamination.
- B: normal used condition, some dirt or attached parts.
- C: broken, burnt, heavily mixed with other materials, or wet/corroded.

Confidence is your honest 0-100 certainty in the material choice; use below 50 when unsure.
Write itemDescription as a short plain-English name of what you see (e.g. "Old Android phone, cracked screen").
Write gradeReason as one short sentence. Set safetyWarning only for hazards (swollen/punctured battery, broken CRT glass, leaking parts), otherwise an empty string.
estimatedWeightKg is your rough guess of the item's weight in kg, or 0 if you cannot tell.`;
}

function buildSchema(materials) {
  return {
    type: 'object',
    properties: {
      materialId: { type: 'string', enum: [...materials.map((m) => m.id), 'none'] },
      itemDescription: { type: 'string' },
      confidence: { type: 'integer', minimum: 0, maximum: 100 },
      grade: { type: 'string', enum: ['A', 'B', 'C'] },
      gradeReason: { type: 'string' },
      safetyWarning: { type: 'string' },
      estimatedWeightKg: { type: 'number' }
    },
    required: ['materialId', 'itemDescription', 'confidence', 'grade', 'gradeReason', 'safetyWarning', 'estimatedWeightKg']
  };
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

class ScanError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function classifyScrapPhoto(imageDataUrl, materials) {
  if (!isConfigured()) {
    throw new ScanError('AI scanner is not set up: add GEMINI_API_KEY to the server .env file.', 503);
  }
  const image = parseDataUrl(imageDataUrl);
  if (!image) throw new ScanError('Send the photo as a JPEG/PNG/WebP data URL.', 400);

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: buildPrompt(materials) },
        { inline_data: { mime_type: image.mimeType, data: image.data } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseJsonSchema: buildSchema(materials)
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    throw new ScanError(err.name === 'AbortError' ? 'The AI scanner took too long to respond. Try again.' : `Could not reach Gemini: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload.error && payload.error.message ? payload.error.message : `HTTP ${res.status}`;
    console.error('[scan] Gemini error:', res.status, detail);
    if (res.status === 429) throw new ScanError('AI scanner is busy (rate limit reached). Try again in a minute.', 429);
    if (res.status === 400 || res.status === 403) throw new ScanError(`Gemini rejected the request: ${detail}`, 502);
    throw new ScanError(`Gemini error: ${detail}`);
  }

  const candidate = payload.candidates && payload.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map((p) => p.text || '').join('')
    : '';
  if (!text) {
    const reason = (candidate && candidate.finishReason) || (payload.promptFeedback && payload.promptFeedback.blockReason) || 'empty response';
    throw new ScanError(`The AI scanner returned no answer (${reason}).`);
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new ScanError('The AI scanner returned an unreadable answer.'); }

  const material = materials.find((m) => m.id === parsed.materialId) || null;
  const grade = GRADES[parsed.grade] ? parsed.grade : 'B';
  return {
    recognised: !!material,
    materialId: material ? material.id : null,
    itemDescription: String(parsed.itemDescription || '').slice(0, 140),
    confidencePct: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0))),
    grade,
    ...GRADES[grade],
    gradeReason: String(parsed.gradeReason || '').slice(0, 200),
    safetyWarning: String(parsed.safetyWarning || '').slice(0, 200),
    estimatedWeightKg: Number(parsed.estimatedWeightKg) > 0 ? Math.round(Number(parsed.estimatedWeightKg) * 100) / 100 : null,
    model
  };
}

module.exports = { classifyScrapPhoto, isConfigured, ScanError };
