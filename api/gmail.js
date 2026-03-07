async function getTokens() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${supabaseUrl}/rest/v1/tokens?id=eq.google_calendar&select=*`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
  });
  const data = await res.json();
  return data?.[0] || null;
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  const tokens = await response.json();
  if (tokens.access_token) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    await fetch(`${supabaseUrl}/rest/v1/tokens?id=eq.google_calendar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
      body: JSON.stringify({ access_token: tokens.access_token, expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString() })
    });
  }
  return tokens;
}

function makeEmail({ to, subject, body, replyToMessageId, replyToThreadId }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
  ];
  if (replyToMessageId) lines.push(`In-Reply-To: ${replyToMessageId}`);
  lines.push('', body);
  const raw = lines.join('\r\n');
  return btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, to, subject, body, query, messageId, threadId } = req.body;

  let tokenData = await getTokens();
  if (!tokenData) return res.status(401).json({ error: 'Not connected' });
  if (new Date(tokenData.expires_at) < new Date()) {
    const refreshed = await refreshAccessToken(tokenData.refresh_token);
    if (!refreshed.access_token) return res.status(401).json({ error: 'Token refresh failed' });
    tokenData.access_token = refreshed.access_token;
  }

  const headers = { 'Authorization': `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' };

  try {
    if (action === 'send') {
      const raw = makeEmail({ to, subject, body });
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers,
        body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) })
      });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'list') {
      // List recent inbox messages
      const q = query || 'in:inbox';
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(q)}`, { headers });
      const data = await r.json();
      if (!data.messages) return res.status(200).json({ messages: [] });

      // Fetch subject + sender for each message
      const details = await Promise.all(data.messages.slice(0, 5).map(async m => {
        const mr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers });
        const md = await mr.json();
        const hdrs = md.payload?.headers || [];
        return {
          id: m.id,
          threadId: m.threadId,
          from: hdrs.find(h => h.name === 'From')?.value || '',
          subject: hdrs.find(h => h.name === 'Subject')?.value || '(no subject)',
          date: hdrs.find(h => h.name === 'Date')?.value || ''
        };
      }));
      return res.status(200).json({ messages: details });

    } else if (action === 'get') {
      // Get full message body
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, { headers });
      const data = await r.json();
      // Extract plain text body
      let body = '';
      const parts = data.payload?.parts || [data.payload];
      for (const part of parts) {
        if (part?.mimeType === 'text/plain' && part?.body?.data) {
          body = decodeURIComponent(escape(atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'))));
          break;
        }
      }
      const hdrs = data.payload?.headers || [];
      return res.status(200).json({
        id: data.id,
        threadId: data.threadId,
        from: hdrs.find(h => h.name === 'From')?.value || '',
        subject: hdrs.find(h => h.name === 'Subject')?.value || '',
        body: body.substring(0, 2000)
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
