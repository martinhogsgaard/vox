// api/stt.js
// STT adapter — Groq Whisper (gratis) med OpenAI Whisper som fallback
// Ingen eksterne dependencies — passer til Vercel uden package.json
//
// Miljøvariabler i Vercel dashboard:
//   GROQ_API_KEY   — gratis op til 7200 sek audio/dag, meget hurtig
//   OPENAI_API_KEY — fallback hvis Groq ikke er konfigureret

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vox-ten-iota.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) {
      return res.status(400).json({ error: 'No multipart boundary found in Content-Type' });
    }
    const boundary = boundaryMatch[1];

    // Læs hele request body som Buffer — ingen formidable nødvendig
    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    // Parse multipart — finder audio, prompt og language felter
    const parts = parseMultipart(rawBody, boundary);
    const audioPart = parts.find(p => p.name === 'audio');
    const promptPart = parts.find(p => p.name === 'prompt');
    const languagePart = parts.find(p => p.name === 'language');

    if (!audioPart || !audioPart.data || audioPart.data.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    const prompt = promptPart?.text || 'Martin, Mie, WoodUpp, ByAulum, Høgsgaard, weproduce, Timelog';
    const language = languagePart?.text || 'da';
    const filename = audioPart.filename || 'audio.webm';
    const mimeType = audioPart.contentType || 'audio/webm';

    console.log(`[STT] Received ${audioPart.data.length} bytes, mime: ${mimeType}, lang: ${language}`);

    const groqKey = process.env.GROQ_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!groqKey && !openaiKey) {
      return res.status(500).json({ error: 'Ingen STT API nøgle konfigureret. Sæt GROQ_API_KEY eller OPENAI_API_KEY i Vercel.' });
    }

    let text = '';
    if (groqKey) {
      text = await transcribeWithGroq(audioPart.data, filename, mimeType, prompt, language, groqKey, openaiKey);
    } else {
      text = await transcribeWithOpenAI(audioPart.data, filename, mimeType, prompt, language, openaiKey);
    }

    console.log(`[STT] Result: "${text.substring(0, 100)}"`);
    return res.status(200).json({ text });

  } catch (err) {
    console.error('[STT] Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── GROQ WHISPER ──
// whisper-large-v3-turbo: hurtig og god til dansk
// Skift til whisper-large-v3 for endnu bedre genkendelse (lidt langsommere)
async function transcribeWithGroq(audioBuffer, filename, mimeType, prompt, language, groqKey, openaiKeyFallback) {
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append('file', blob, filename);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', language);
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt);

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}` },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[STT] Groq error:', response.status, errText);
    if (openaiKeyFallback) {
      console.log('[STT] Falling back to OpenAI Whisper');
      return transcribeWithOpenAI(audioBuffer, filename, mimeType, prompt, language, openaiKeyFallback);
    }
    throw new Error(`Groq STT fejlede (${response.status}): ${errText}`);
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
  if (prompt) form.append('prompt', prompt);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[STT] OpenAI error:', response.status, errText);
    throw new Error(`OpenAI STT fejlede (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.text?.trim() || '';
}

// ── MANUEL MULTIPART PARSER ──
// Ingen formidable — parser multipart/form-data fra raw Buffer
// Returnerer array af { name, filename, contentType, data (Buffer), text (string) }
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const CRLFCRLF = Buffer.from('\r\n\r\n');

  let pos = 0;

  while (pos < buffer.length) {
    const boundaryPos = bufferIndexOf(buffer, boundaryBuf, pos);
    if (boundaryPos === -1) break;

    pos = boundaryPos + boundaryBuf.length;

    // Slut-boundary har -- efter sig
    if (buffer[pos] === 45 && buffer[pos + 1] === 45) break;

    // Spring over \r\n efter boundary
    if (buffer[pos] === 13 && buffer[pos + 1] === 10) pos += 2;

    // Find afslutning af headers
    const headerEnd = bufferIndexOf(buffer, CRLFCRLF, pos);
    if (headerEnd === -1) break;

    const headerStr = buffer.slice(pos, headerEnd).toString('utf-8');
    pos = headerEnd + 4;

    // Find start af næste boundary for at afgrænse data
    const nextBoundary = bufferIndexOf(buffer, boundaryBuf, pos);
    if (nextBoundary === -1) break;

    // Fjern afsluttende \r\n fra data
    let dataEnd = nextBoundary;
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) dataEnd -= 2;
    const data = buffer.slice(pos, dataEnd);

    // Parse headers til objekt
    const headers = {};
    headerStr.split('\r\n').forEach(line => {
      const idx = line.indexOf(':');
      if (idx > -1) {
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
    });

    const disposition = headers['content-disposition'] || '';
    const nameMatch = disposition.match(/name="([^"]+)"/);
    const filenameMatch = disposition.match(/filename="([^"]+)"/);

    parts.push({
      name: nameMatch?.[1] || '',
      filename: filenameMatch?.[1] || null,
      contentType: headers['content-type'] || '',
      data,
      text: data.toString('utf-8'),
    });

    pos = nextBoundary;
  }

  return parts;
}

// Buffer.indexOf er built-in i Node.js — men denne er mere eksplicit og sikker
function bufferIndexOf(buffer, search, start = 0) {
  const idx = buffer.indexOf(search, start);
  return idx;
}
