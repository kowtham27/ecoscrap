// Ask EcoScrap AI — a real conversational assistant through the Gemini API.
// It answers ANY question the user asks (general knowledge, how-tos, app help, recycling,
// maths, writing, etc.), and is additionally grounded in the platform's LIVE data (current
// rates, registered dealers, safety guides) so EcoScrap-specific answers stay accurate.
// Uses the same GEMINI_API_KEY as the scanner; the key never reaches the browser.

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_TURNS = 20;
const MAX_MESSAGE_CHARS = 2000;

const LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi', mr: 'Marathi', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam'
};

class ChatError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

function buildSystemPrompt({ materials, kabadiwalas, safetyGuides, lang, clientContext }) {
  const langName = LANGUAGE_NAMES[lang] || 'English';
  const priceBoard = materials.map((m) =>
    `- ${m.name} (${m.symbol}): doorstep buyback ₹${m.customer_rate}/kg, wholesale recycler ₹${m.recycler_rate}/kg. Hazard: ${m.hazard_level || 'n/a'}. Typical items: ${m.description || 'n/a'}`
  ).join('\n');
  const dealers = kabadiwalas.slice(0, 15).map((k) =>
    `- ${k.name}, ${k.location || 'location n/a'}, rating ${k.rating ?? 'n/a'}`
  ).join('\n') || '- (none registered yet)';
  const safety = safetyGuides.map((g) => `- ${g.title}: ${g.safe_method}`).join('\n');

  const extra = [];
  if (clientContext.userRole) extra.push(`The user is currently using the app as: ${clientContext.userRole}.`);
  if (clientContext.nearestDealer) extra.push(`Nearest registered dealer to the user right now: ${clientContext.nearestDealer}.`);

  return `You are "EcoScrap AI", a friendly, genuinely helpful general-purpose AI assistant built into the EcoScrap (E-Setu) app — an Indian platform that connects households to verified scrap dealers (kabadiwalas) and recyclers for fair doorstep e-waste pickup.

You can help with ANYTHING the user asks — general knowledge, everyday questions, studies, maths, writing, tech help, health/safety basics, environment and recycling, or using this app. Do NOT refuse or redirect just because a question is unrelated to scrap. Only steer back to EcoScrap when it is actually relevant.

Reply in ${langName} (unless the user clearly writes in another language — then match theirs).
Your replies are also read aloud by text-to-speech, so: keep them concise (usually 1–4 short sentences, longer only if the user asks for detail), use plain sentences, and avoid markdown, tables, emojis, code blocks and bullet symbols unless the user specifically asks for them.
Be honest: if you don't know something or it needs real-time information you don't have (news, weather, live stock prices), say so briefly instead of inventing it. For serious medical, legal or financial matters, give helpful general guidance and suggest a professional.

How the app works (use when relevant): scan a photo of the item to identify the material and grade, check the live price board, request a pickup, and a verified dealer arrives with a certified scale and pays at the doorstep (cash/UPI). Recyclers buy pooled lots from dealers.

LIVE price board (₹ per kg, current — always use these exact figures for EcoScrap prices, never other numbers):
${priceBoard}

Registered dealers:
${dealers}

Safety guidance on the platform:
${safety}
${extra.length ? '\n' + extra.join('\n') : ''}`;
}

function sanitiseHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text.slice(0, MAX_MESSAGE_CHARS) }]
    }));
}

async function chat({ messages, lang, clientContext }, platformData) {
  if (!isConfigured()) {
    throw new ChatError('AI assistant is not set up: add GEMINI_API_KEY to the server .env file.', 503);
  }
  const contents = sanitiseHistory(messages);
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    throw new ChatError('Send at least one user message.', 400);
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const ctx = {
    userRole: clientContext && typeof clientContext.userRole === 'string' ? clientContext.userRole.slice(0, 40) : '',
    nearestDealer: clientContext && typeof clientContext.nearestDealer === 'string' ? clientContext.nearestDealer.slice(0, 200) : ''
  };
  const body = {
    system_instruction: { parts: [{ text: buildSystemPrompt({ ...platformData, lang, clientContext: ctx }) }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
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
    throw new ChatError(err.name === 'AbortError' ? 'The assistant took too long to respond. Try again.' : `Could not reach Gemini: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload.error && payload.error.message ? payload.error.message : `HTTP ${res.status}`;
    console.error('[assistant] Gemini error:', res.status, detail);
    if (res.status === 429) throw new ChatError('The assistant is busy (rate limit reached). Try again in a minute.', 429);
    throw new ChatError(`Gemini error: ${detail}`);
  }

  const candidate = payload.candidates && payload.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map((p) => p.text || '').join('').trim()
    : '';
  if (!text) {
    const reason = (candidate && candidate.finishReason) || (payload.promptFeedback && payload.promptFeedback.blockReason) || 'empty response';
    throw new ChatError(`The assistant returned no answer (${reason}).`);
  }
  return { reply: text, model };
}

module.exports = { chat, isConfigured, ChatError };
