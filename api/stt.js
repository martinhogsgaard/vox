// api/stt.js
// STT adapter — Groq Whisper (primær) + OpenAI Whisper (fallback)
// Chrome: audio/webm;codecs=opus → sendes som audio/ogg til Groq
// Safari iOS: audio/mp4 → sendes direkte

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if(!boundaryMatch) return res.status(400).json({ error: 'No multipart boundary' });
    const boundary = boundaryMatch[1];

    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    const parts        = parseMultipart(rawBody, boundary);
    const audioPart    = parts.find(p => p.name === 'audio');
    const promptPart   = parts.find(p => p.name === 'prompt');
    const languagePart = parts.find(p => p.name === 'language');

    if(!audioPart?.data?.length) return res.status(400).json({ error: 'No audio data' });

    // Minimum størrelse check — under 1KB er sandsynligvis tom optagelse
    if(audioPart.data.length < 1000) {
      console.warn(`[STT] Audio too small: ${audioPart.data.length} bytes`);
      return res.status(200).json({ text: '' });
    }

    const prompt   = promptPart?.text  || 'Martin, Mie, WoodUpp, ByAulum, Høgsgaard, weproduce, Timelog';
    const language = languagePart?.text || 'da';
    const origMime = audioPart.contentType || 'audio/webm';

    // Normalisér MIME og filnavn til hvad Groq accepterer
    const { mime, filename } = resolveGroqFormat(origMime, audioPart.filename);

    console.log(`[STT] ${audioPart.data.length} bytes | orig: ${origMime} → groq: ${mime} | file: ${filename}`);

    const groqKey   = process.env.GROQ_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if(!groqKey && !openaiKey) {
      return res.status(500).json({ error: 'Ingen STT API nøgle. Sæt GROQ_API_KEY i Vercel.' });
    }

    let text = '';
    if(groqKey) {
      text = await transcribeWithGroq(audioPart.data, filename, mime, prompt, language, groqKey, openaiKey);
    } else {
      text = await transcribeWithOpenAI(audioPart.data, filename, mime, prompt, language, openaiKey);
    }

    console.log(`[STT] Result: "${text.substring(0, 120)}"`);
    return res.status(200).json({ text });

  } catch(err) {
    console.error('[STT] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── FORMAT RESOLVER ──
// Send altid filen præcis som browseren optager den — ingen konvertering
// Groq accepterer: webm, mp4, wav, ogg, mp3, flac
function resolveGroqFormat(mimeType, originalFilename) {
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();

  if(base === 'audio/mp4' || base === 'audio/x-m4a') return { mime: 'audio/mp4', filename: 'audio.mp4' };
  if(base === 'audio/wav' || base === 'audio/wave')  return { mime: 'audio/wav',  filename: 'audio.wav'  };
  if(base === 'audio/ogg')                           return { mime: 'audio/ogg',  filename: 'audio.ogg'  };
  if(base === 'audio/mpeg' || base === 'audio/mp3')  return { mime: 'audio/mpeg', filename: 'audio.mp3'  };
  // Chrome webm (med eller uden codecs=opus) — send som webm
  return { mime: 'audio/webm', filename: 'audio.webm' };
}

// ── GROQ WHISPER ──
async function transcribeWithGroq(audioBuffer, filename, mimeType, prompt, language, groqKey, openaiKeyFallback) {
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append('file', blob, filename);
  form.append('model', 'whisper-large-v3');
  form.append('language', language);
  form.append('response_format', 'json');
  form.append('temperature', '0');  // Reducerer hallucination og forkert sprog
  if(prompt) form.append('prompt', prompt);

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}` },
    body: form,
  });

  if(!response.ok) {
    const errText = await response.text();
    console.error('[STT] Groq error:', response.status, errText.substring(0, 300));
    if(openaiKeyFallback) {
      console.log('[STT] Falling back to OpenAI');
      return transcribeWithOpenAI(audioBuffer, filename, mimeType, prompt, language, openaiKeyFallback);
    }
    throw new Error(`Groq STT fejlede (${response.status}): ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.text?.trim() || '';
}

// ── OPENAI WHISPER ──
async function transcribeWithOpenAI(audioBuffer, filename, mimeType, prompt, language, apiKey) {
  // OpenAI foretrækker webm direkte
  const oaiMime = mimeType === 'audio/ogg' ? 'audio/webm' : mimeType;
  const oaiFile = mimeType === 'audio/ogg' ? 'audio.webm' : filename;

  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: oaiMime });
  form.append('file', blob, oaiFile);
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
    throw new Error(`OpenAI STT fejlede (${response.status}): ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.text?.trim() || '';
}

// ── MULTIPART PARSER ──
function parseMultipart(buffer, boundary) {
  const parts       = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const CRLFCRLF    = Buffer.from('\r\n\r\n');
  let pos = 0;

  while(pos < buffer.length) {
    const boundaryPos = buffer.indexOf(boundaryBuf, pos);
    if(boundaryPos === -1) break;
    pos = boundaryPos + boundaryBuf.length;
    if(buffer[pos] === 45 && buffer[pos+1] === 45) break;
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
    parts.push({
      name:        nameMatch?.[1] || '',
      filename:    filenameMatch?.[1] || null,
      contentType: headers['content-type'] || '',
      data,
      text: data.toString('utf-8'),
    });
    pos = nextBoundary;
  }
  return parts;
}
