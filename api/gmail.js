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

function encodeSubject(str) {
  const encoded = Buffer.from(str, 'utf-8').toString('base64');
  return `=?UTF-8?B?${encoded}?=`;
}

function decodeBase64url(data) {
  if (!data) return '';
  try {
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
  } catch { return ''; }
}

// Udtræk tekst — håndterer text/plain, text/html og nested multipart
function extractText(payload) {
  if (!payload) return '';

  // Direkte text/plain
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64url(payload.body.data);
  }

  // Direkte text/html — strip tags
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = decodeBase64url(payload.body.data);
    return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
               .replace(/<[^>]+>/g, ' ')
               .replace(/\s+/g, ' ')
               .trim();
  }

  if (payload.parts) {
    // Prøv text/plain først i alle parts
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64url(part.body.data);
      }
    }
    // Prøv text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = decodeBase64url(part.body.data);
        return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ')
                   .trim();
      }
    }
    // Rekursivt i nested parts
    for (const part of payload.parts) {
      const text = extractText(part);
      if (text) return text;
    }
  }

  return '';
}

function makeEmail({ to, subject, body, cc, attachment }) {
  const boundary = 'vox_' + Date.now();
  if (!attachment) {
    const lines = [
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      `Subject: ${encodeSubject(subject)}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      '',
      Buffer.from(body, 'utf-8').toString('base64')
    ];
    return Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const encodedFilename = encodeSubject(attachment.filename);
  const parts = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    '',
    Buffer.from(body, 'utf-8').toString('base64'),
    '',
    `--${boundary}`,
    `Content-Type: ${attachment.mimeType}; name="${encodedFilename}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${encodedFilename}"`,
    '',
    attachment.data,
    '',
    `--${boundary}--`
  ];
  return Buffer.from(parts.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vox-ten-iota.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, to, subject, body, cc, query, messageId, threadId } = req.body;

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
      const { attachment } = req.body;
      let attachmentData = attachment || null;
      if (!attachmentData && req.body.driveFileId) {
        const driveToken = tokenData.access_token;
        const fileMetaRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${req.body.driveFileId}?fields=name,mimeType`,
          { headers: { Authorization: `Bearer ${driveToken}` } }
        );
        const fileMeta = await fileMetaRes.json();
        const fileRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${req.body.driveFileId}?alt=media`,
          { headers: { Authorization: `Bearer ${driveToken}` } }
        );
        if (fileRes.ok) {
          const buffer = await fileRes.arrayBuffer();
          attachmentData = {
            filename: fileMeta.name,
            mimeType: fileMeta.mimeType || 'application/octet-stream',
            data: Buffer.from(buffer).toString('base64')
          };
        }
      }
      const raw = makeEmail({ to, subject, body, cc, attachment: attachmentData });
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
      const bodyText = extractText(data.payload);
      console.log(`[Gmail get] id:${messageId} mimeType:${data.payload?.mimeType} bodyLen:${bodyText.length} parts:${data.payload?.parts?.length || 0}`);
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
      const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      const firstWord = words[0] || q.toLowerCase();
      function nameMatches(name, email) {
        const nameLower = name.toLowerCase();
        const emailUser = email.split('@')[0].toLowerCase();
        if (words.length > 1) return words.every(w => nameLower.includes(w));
        return nameLower.includes(firstWord) || emailUser.includes(firstWord);
      }

      try {
        const rA = await fetch(
          `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(q)}&readMask=names,emailAddresses&pageSize=10`,
          { headers }
        );
        if (rA.ok) {
          const dataA = await rA.json();
          const results = (dataA.results || []).map(p => ({
            name: p.person?.names?.[0]?.displayName || '',
            emails: (p.person?.emailAddresses || []).map(e => e.value)
          })).filter(c => c.emails.length > 0 && nameMatches(c.name, c.emails[0]));
          allContacts.push(...results);
        }

        const rB = await fetch(
          `https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses&pageSize=1000`,
          { headers }
        );
        if (rB.ok) {
          const dataB = await rB.json();
          (dataB.connections || [])
            .map(p => ({ name: p.names?.[0]?.displayName || '', emails: (p.emailAddresses || []).map(e => e.value) }))
            .filter(c => c.emails.length > 0 && nameMatches(c.name, c.emails[0]))
            .forEach(c => {
              const exists = allContacts.find(a => a.name.toLowerCase() === c.name.toLowerCase());
              if (exists) c.emails.forEach(e => { if (!exists.emails.includes(e)) existing.emails.push(e); });
              else allContacts.push(c);
            });
        }

        const rC = await fetch(
          `https://people.googleapis.com/v1/otherContacts:search?query=${encodeURIComponent(q)}&readMask=names,emailAddresses&pageSize=10`,
          { headers }
        );
        if (rC.ok) {
          const dataC = await rC.json();
          (dataC.results || [])
            .map(p => ({ name: p.person?.names?.[0]?.displayName || '', emails: (p.person?.emailAddresses || []).map(e => e.value) }))
            .filter(c => c.emails.length > 0 && nameMatches(c.name, c.emails[0]))
            .forEach(c => {
              const exists = allContacts.find(a => a.name.toLowerCase() === c.name.toLowerCase());
              if (exists) c.emails.forEach(e => { if (!exists.emails.includes(e)) exists.emails.push(e); });
              else allContacts.push(c);
            });
        }
      } catch(e) { console.log('People API error:', e.message); }

      try {
        const emailSet = new Set();
        const searches = [
          { url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(q + ' in:sent')}`, headerName: 'To' },
          { url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(firstWord + ' in:sent')}`, headerName: 'To' },
          { url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(q)}`, headerName: 'From' },
          { url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(firstWord)}`, headerName: 'From' },
        ];
        for (const { url, headerName } of searches) {
          const r = await fetch(url, { headers });
          if (!r.ok) continue;
          const data = await r.json();
          if (!data.messages) continue;
          await Promise.all(data.messages.slice(0, 5).map(async m => {
            const mr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=${headerName}`, { headers });
            if (!mr.ok) return;
            const md = await mr.json();
            const header = md.payload?.headers?.find(h => h.name === headerName)?.value || '';
            const matches = [...header.matchAll(/([^<,]+)<([^>]+)>/g)];
            for (const match of matches) {
              const name = match[1].replace(/['"\\]/g, '').trim();
              const email = match[2].trim().toLowerCase();
              if (nameMatches(name, email)) emailSet.add(JSON.stringify({ name, email }));
            }
          }));
        }
        for (const s of emailSet) {
          const { name, email } = JSON.parse(s);
          if (!allContacts.some(c => c.emails.includes(email))) allContacts.push({ name, emails: [email] });
        }
      } catch(e) { console.log('Mail search error:', e.message); }

      const grouped = [];
      allContacts.forEach(c => {
        const existing = grouped.find(g => g.name.toLowerCase() === c.name.toLowerCase());
        if (existing) c.emails.forEach(e => { if (!existing.emails.includes(e)) existing.emails.push(e); });
        else grouped.push({ name: c.name, emails: [...c.emails] });
      });
      return res.status(200).json({ contacts: grouped.slice(0, 5) });

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    console.error('Gmail error:', err);
    return res.status(500).json({ error: err.message });
  }
}
