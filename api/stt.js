// api/stt.js
// STT adapter — Groq Whisper (primær, gratis) + OpenAI Whisper (fallback)
// Understøtter: audio/webm (Chrome), audio/webm;codecs=opus (Chrome), audio/mp4 (Safari iOS)
//
// Vercel miljøvariabler:
//   GROQ_API_KEY   — https://console.groq.com — gratis, 7200 sek/dag, meget hurtig
//   OPENAI_API_KEY — fallback

export const config = {
  api: {
    bodyParser: false,
    // Øg body size limit til 10MB for store lydfiler
    responseLimit: false,
  },
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if(!boundaryMatch) {
      return res.status(400).json({ error: 'No multipart boundary in Content-Type' });
    }
    const boundary = boundaryMatch[1];

    // Læs hele request body
    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    const parts       = parseMultipart(rawBody, boundary);
    const audioPart   = parts.find(p => p.name === 'audio');
    const promptPart  = parts.find(p => p.name === 'prompt');
    const languagePart = parts.find(p => p.name === 'language');

    if(!audioPart || !audioPart.data || audioPart.data.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    const prompt   = promptPart?.text  || 'Martin, Mie, WoodUpp, ByAulum, Høgsgaard, weproduce, Timelog, Groq, Supabase, Vercel';
    const language = languagePart?.text || 'da';
    const filename = audioPart.filename || detectFilename(audioPart.contentType);
    const mimeType = audioPart.contentType || detectMimeType(filename);

    console.log(`[STT] ${audioPart.data.length} bytes | mime: ${mimeType} | file: ${filename} | lang: ${language}`);

    const groqKey   = process.env.GROQ_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if(!groqKey && !openaiKey) {
      return res.status(500).json({
        error: 'Ingen STT API nøgle konfigureret. Sæt GROQ_API_KEY eller OPENAI_API_KEY i Vercel dashboard → Settings → Environment Variables.'
      });
    }

    let text = '';
    if(groqKey) {
      text = await transcribeWithGroq(audioPart.data, filename, mimeType, prompt, language, groqKey, openaiKey);
    } else {
      text = await transcribeWithOpenAI(audioPart.data, filename, mimeType, prompt, language, openaiKey);
    }

    console.log(`[STT] Result: "${text.substring(0, 120)}"`);
    return res.status(200).json({ text });

  } catch(err) {
    console.error('[STT] Handler error:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}

// ── GROQ WHISPER ──
// whisper-large-v3-turbo: hurtig og god til dansk
// Skift til whisper-large-v3 for bedre præcision (lidt langsommere)
async function transcribeWithGroq(audioBuffer, filename, mimeType, prompt, language, groqKey, openaiKeyFallback) {
  // Groq understøtter: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm
  // Safari sender audio/mp4 — Groq håndterer det fint
  const safeMime = normalizeMimeForGroq(mimeType);

  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: safeMime });
  form.append('file', blob, filename);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', language);
  form.append('response_format', 'json');
  if(prompt) form.append('prompt', prompt);

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}` },
    body: form,
  });

  if(!response.ok) {
    const errText = await response.text();
    console.error('[STT] Groq error:', response.status, errText);

    // Fallback til OpenAI hvis tilgængelig
    if(openaiKeyFallback) {
      console.log('[STT] Falling back to OpenAI Whisper');
      return transcribeWithOpenAI(audioBuffer, filename, mimeType, prompt, language, openaiKeyFallback);
    }
    throw new Error(`Groq STT fejlede (${response.status}): ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.text?.trim() || '';
}

// ── OPENAI WHISPER ──
async function transcribeWithOpenAI(audioBuffer, filename, mimeType, prompt, language, apiKey) {
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append('file', blob, filename);
  form.append('model', 'whisper-1');
  form.append('language', language);
  form.append('response_format', 'json');
  if(prompt) form.append('prompt', prompt);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if(!response.ok) {
    const errText = await response.text();
    console.error('[STT] OpenAI error:', response.status, errText);
    throw new Error(`OpenAI STT fejlede (${response.status}): ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.text?.trim() || '';
}

// ── MIME HELPERS ──
function normalizeMimeForGroq(mimeType) {
  if(!mimeType) return 'audio/webm';
  // Groq forstår disse direkte
  const supported = ['audio/webm','audio/mp4','audio/mpeg','audio/mp3','audio/wav','audio/ogg','audio/flac','audio/m4a'];
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if(supported.includes(base)) return base;
  // codecs-varianter
  if(base.startsWith('audio/webm')) return 'audio/webm';
  if(base.startsWith('audio/mp4') || base === 'audio/x-m4a') return 'audio/mp4';
  return 'audio/webm'; // safe default
}

function detectMimeType(filename) {
  if(!filename) return 'audio/webm';
  if(filename.endsWith('.mp4') || filename.endsWith('.m4a')) return 'audio/mp4';
  if(filename.endsWith('.wav'))  return 'audio/wav';
  if(filename.endsWith('.ogg'))  return 'audio/ogg';
  if(filename.endsWith('.mp3'))  return 'audio/mpeg';
  return 'audio/webm';
}

function detectFilename(mimeType) {
  if(!mimeType) return 'audio.webm';
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if(base === 'audio/mp4' || base === 'audio/x-m4a') return 'audio.mp4';
  if(base === 'audio/wav')  return 'audio.wav';
  if(base === 'audio/ogg')  return 'audio.ogg';
  if(base === 'audio/mpeg' || base === 'audio/mp3') return 'audio.mp3';
  return 'audio.webm';
}

// ── MULTIPART PARSER ──
// Ingen formidable dependency — parser multipart/form-data fra raw Buffer
function parseMultipart(buffer, boundary) {
  const parts       = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const CRLFCRLF    = Buffer.from('\r\n\r\n');
  let pos = 0;

  while(pos < buffer.length) {
    const boundaryPos = buffer.indexOf(boundaryBuf, pos);
    if(boundaryPos === -1) break;
    pos = boundaryPos + boundaryBuf.length;

    // Slut-boundary
    if(buffer[pos] === 45 && buffer[pos+1] === 45) break;

    // Spring \r\n
    if(buffer[pos] === 13 && buffer[pos+1] === 10) pos += 2;

    const headerEnd = buffer.indexOf(CRLFCRLF, pos);
    if(headerEnd === -1) break;

    const headerStr = buffer.slice(pos, headerEnd).toString('utf-8');
    pos = headerEnd + 4;

    const nextBoundary = buffer.indexOf(boundaryBuf, pos);
    if(nextBoundary === -1) break;

    let dataEnd = nextBoundary;
    if(buffer[dataEnd-2] === 13 && buffer[dataEnd-1] === 10) dataEnd -= 2;
    const data = buffer.slice(pos, dataEnd);

    const headers = {};
    headerStr.split('\r\n').forEach(line => {
      const idx = line.indexOf(':');
      if(idx > -1) headers[line.slice(0,idx).trim().toLowerCase()] = line.slice(idx+1).trim();
    });

    const disposition   = headers['content-disposition'] || '';
    const nameMatch     = disposition.match(/name="([^"]+)"/);
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const ct            = headers['content-type'] || '';

    parts.push({
      name:        nameMatch?.[1] || '',
      filename:    filenameMatch?.[1] || null,
      contentType: ct,
      data,
      text: data.toString('utf-8'),
    });

    pos = nextBoundary;
  }

  return parts;
}
