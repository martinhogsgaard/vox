// api/stt.js
// STT adapter — understøtter Groq Whisper (gratis) og OpenAI Whisper
//
// Miljøvariabler der skal sættes i Vercel dashboard:
//   GROQ_API_KEY    — til Groq Whisper (gratis tier, meget hurtig)
//   OPENAI_API_KEY  — til OpenAI Whisper (fallback)
//
// Groq foretrækkes: gratis op til 7200 sek audio/dag, hurtigere end OpenAI
//
// Kaldes fra frontend med FormData:
//   const form = new FormData();
//   form.append('audio', blob, 'audio.webm');
//   form.append('prompt', 'Martin, Mie, WoodUpp, ByAulum');
//   form.append('language', 'da');
//   fetch('/api/stt', { method: 'POST', body: form })

import formidable from 'formidable';
import fs from 'fs';
import path from 'path';

// Vercel kræver at body parsing slås fra for FormData
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse multipart form data
    const { fields, files } = await parseForm(req);
    const audioFile = files.audio?.[0] || files.audio;
    if (!audioFile) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const prompt = fields.prompt?.[0] || fields.prompt || '';
    const language = fields.language?.[0] || fields.language || 'da';

    // Forsøg Groq først (gratis), fallback til OpenAI
    const groqKey = process.env.GROQ_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    let result;
    if (groqKey) {
      result = await transcribeWithGroq(audioFile, prompt, language, groqKey);
    } else if (openaiKey) {
      result = await transcribeWithOpenAI(audioFile, prompt, language, openaiKey);
    } else {
      return res.status(500).json({ error: 'No STT API key configured. Set GROQ_API_KEY or OPENAI_API_KEY.' });
    }

    return res.status(200).json({ text: result });

  } catch (err) {
    console.error('[STT] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── GROQ WHISPER ──
// Model: whisper-large-v3-turbo (hurtig) eller whisper-large-v3 (bedst)
// Gratis: 7200 sek/dag, derefter $0.111/time audio
// Latency: typisk 200-400ms for korte sætninger
async function transcribeWithGroq(audioFile, prompt, language, apiKey) {
  const form = new FormData();

  // Læs filen og byg FormData
  const fileBuffer = fs.readFileSync(audioFile.filepath);
  const fileName = audioFile.originalFilename || 'audio.webm';
  const mimeType = audioFile.mimetype || 'audio/webm';
  const blob = new Blob([fileBuffer], { type: mimeType });
  form.append('file', blob, fileName);
  form.append('model', 'whisper-large-v3-turbo'); // Skift til 'whisper-large-v3' for bedste dansk genkendelse
  form.append('language', language);
  form.append('response_format', 'json');

  // Prompt hjælper Whisper med at genkende navne og fagtermer korrekt
  if (prompt) {
    form.append('prompt', prompt);
  }

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('[STT] Groq error:', response.status, err);
    // Hvis Groq fejler og vi har OpenAI, prøv den
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      console.log('[STT] Falling back to OpenAI Whisper');
      return await transcribeWithOpenAI(audioFile, prompt, language, openaiKey);
    }
    throw new Error('Groq STT failed: ' + err);
  }

  const data = await response.json();
  const text = data.text?.trim() || '';
  console.log('[STT] Groq result:', text.substring(0, 80));
  return text;
}

// ── OPENAI WHISPER ──
// Model: whisper-1
// Pris: $0.006/min audio
async function transcribeWithOpenAI(audioFile, prompt, language, apiKey) {
  const form = new FormData();

  const fileBuffer = fs.readFileSync(audioFile.filepath);
  const fileName = audioFile.originalFilename || 'audio.webm';
  const mimeType = audioFile.mimetype || 'audio/webm';
  const blob = new Blob([fileBuffer], { type: mimeType });
  form.append('file', blob, fileName);
  form.append('model', 'whisper-1');
  form.append('language', language);
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('[STT] OpenAI error:', response.status, err);
    throw new Error('OpenAI STT failed: ' + err);
  }

  const data = await response.json();
  const text = data.text?.trim() || '';
  console.log('[STT] OpenAI result:', text.substring(0, 80));
  return text;
}

// ── FORM PARSER ──
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: 25 * 1024 * 1024, // 25MB — Whisper's grænse
      keepExtensions: true,
    });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}
