// api/tts.js
// TTS adapter — understøtter OpenAI og ElevenLabs
//
// Miljøvariabler der skal sættes i Vercel dashboard:
//   OPENAI_API_KEY     — til OpenAI TTS
//   ELEVENLABS_API_KEY — til ElevenLabs TTS
//
// Kaldes fra frontend med:
//   fetch('/api/tts', {
//     method: 'POST',
//     body: JSON.stringify({ engine: 'openai', text: '...', voice: 'onyx' })
//   })

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vox-ten-iota.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { engine, text, voice, voiceId } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  // Begræns tekst til 4096 tegn (begge APIs har grænser)
  const safeText = text.trim().substring(0, 4096);

  try {
    if (engine === 'elevenlabs') {
      return await handleElevenLabs(req, res, safeText, voiceId);
    } else {
      // Default: OpenAI
      return await handleOpenAI(req, res, safeText, voice || 'onyx');
    }
  } catch (err) {
    console.error('[TTS] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── OPENAI TTS ──
// Modeller: tts-1 (hurtig, billig) eller tts-1-hd (bedre kvalitet)
// Stemmer: alloy, echo, fable, onyx, nova, shimmer
// Pris: tts-1 = $15/1M tegn, tts-1-hd = $30/1M tegn
async function handleOpenAI(req, res, text, voice) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',        // Skift til 'tts-1-hd' for bedre kvalitet
      input: text,
      voice: voice || 'onyx', // onyx = rolig, maskulin engelsk stemme
      response_format: 'mp3',
      speed: 1.0,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('[TTS] OpenAI error:', response.status, err);
    return res.status(response.status).json({ error: 'OpenAI TTS failed', details: err });
  }

  // Stream audio direkte tilbage til klienten
  const audioBuffer = await response.arrayBuffer();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', audioBuffer.byteLength);
  res.setHeader('Cache-Control', 'no-cache');
  return res.send(Buffer.from(audioBuffer));
}

// ── ELEVENLABS TTS ──
// Voice IDs til engelske stemmer (gode valg til PA-assistent):
//   pNInz6obpgDQGcFmaJgB — Adam (dyb, rolig)
//   EXAVITQu4vr4xnSDxMaL — Bella (klar, professionel)
//   VR6AewLTigWG4xSOukaG — Arnold (autoritativ)
//   21m00Tcm4TlvDq8ikWAM — Rachel (varm, venlig)
// Pris: ~$5/1M tegn på Starter plan
async function handleElevenLabs(req, res, text, voiceId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
  }

  const selectedVoiceId = voiceId || 'pNInz6obpgDQGcFmaJgB'; // Adam som default

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2', // Hurtigst og billigst — skift til eleven_multilingual_v2 for bedre kvalitet
        voice_settings: {
          stability: 0.5,        // 0-1: højere = mere konsistent men mindre udtryksfuld
          similarity_boost: 0.75, // 0-1: højere = tættere på original stemme
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    console.error('[TTS] ElevenLabs error:', response.status, err);
    return res.status(response.status).json({ error: 'ElevenLabs TTS failed', details: err });
  }

  const audioBuffer = await response.arrayBuffer();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', audioBuffer.byteLength);
  res.setHeader('Cache-Control', 'no-cache');
  return res.send(Buffer.from(audioBuffer));
}
