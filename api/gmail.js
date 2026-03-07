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

function makeEmail({ to, subject, body }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    '',
    body
  ];
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
    console.log('Gmail action:', action);

    if (action === 'send') {
      const raw = makeEmail({ to, subject, body });
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers,
        body: JSON.stringify({ raw })
      });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'list') {
      const q = query || 'in:inbox';
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(q)}`, { headers });
      const data = await r.json();
      if (!data.messages) return res.status(200).json({ messages: [] });
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
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, { headers });
      const data = await r.json();
      let bodyText = '';
      const parts = data.payload?.parts || [data.payload];
      for (const part of parts) {
        if (part?.mimeType === 'text/plain' && part?.body?.data) {
          bodyText = decodeURIComponent(escape(atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'))));
          break;
        }
      }
      const hdrs = data.payload?.headers || [];
      return res.status(200).json({
        id: data.id,
        threadId: data.threadId,
        from: hdrs.find(h => h.name === 'From')?.value || '',
        subject: hdrs.find(h => h.name === 'Subject')?.value || '',
        body: bodyText.substring(0, 2000)
      });

    } else if (action === 'find_contact') {
      const q = req.body.query || '';
      const allContacts = [];

      // Helper: only match if name (not just email domain) contains query words
      const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      function nameMatches(name, email) {
        const nameLower = name.toLowerCase();
        const emailUser = email.split('@')[0].toLowerCase();
        return words.every(w => nameLower.includes(w) || emailUser.includes(w));
      }

      // 1. Try Google People API
      try {
        const r = await fetch(
          `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(q)}&readMask=names,emailAddresses&pageSize=5`,
          { headers }
        );
        if (r.ok) {
          const data = await r.json();
          const results = (data.results || []).map(p => ({
            name: p.person?.names?.[0]?.displayName || '',
            emails: (p.person?.emailAddresses || []).map(e => e.value)
          })).filter(c => c.emails.length > 0 && nameMatches(c.name, c.emails[0]));
          allContacts.push(...results);
        } else {
          console.log('People API status:', r.status);
        }
      } catch(e) { console.log('People API error:', e.message); }

      // 2. Search sent AND received mail — match on NAME only (not email domain)
      try {

        const emailSet = new Set();

        // Search sent mail
        const sentR = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&q=${encodeURIComponent('in:sent')}`,
          { headers }
        );
        // Search received mail too
        const recR = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&q=${encodeURIComponent('in:inbox')}`,
          { headers }
        );

        for (const [r, headerName] of [[sentR, 'To'], [recR, 'From']]) {
          if (!r.ok) continue;
          const data = await r.json();
          if (!data.messages) continue;
          await Promise.all(data.messages.slice(0, 20).map(async m => {
            const mr = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=${headerName}`,
              { headers }
            );
            if (!mr.ok) return;
            const md = await mr.json();
            const header = md.payload?.headers?.find(h => h.name === headerName)?.value || '';
            const matches = [...header.matchAll(/([^<,]+)<([^>]+)>/g)];
            for (const match of matches) {
              const name = match[1].trim();
              const email = match[2].trim().toLowerCase();
              if (nameMatches(name, email)) {
                emailSet.add(JSON.stringify({ name, email }));
              }
            }
          }));
        }

        for (const s of emailSet) {
          const { name, email } = JSON.parse(s);
          const exists = allContacts.some(c => c.emails.includes(email));
          if (!exists) allContacts.push({ name, emails: [email] });
        }
      } catch(e) { console.log('Mail search error:', e.message); }

      return res.status(200).json({ contacts: allContacts.slice(0, 5) });

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

  } catch (err) {
    console.error('Gmail error:', err);
    return res.status(500).json({ error: err.message });
  }
}
