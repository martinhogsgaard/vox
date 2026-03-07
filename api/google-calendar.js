async function getTokens() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const res = await fetch(`${supabaseUrl}/rest/v1/tokens?id=eq.google_calendar&select=*`, {
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`
    }
  });
  const data = await res.json();
  if (!data || data.length === 0) return null;
  return data[0];
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

  // Update token in Supabase
  if (tokens.access_token) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    await fetch(`${supabaseUrl}/rest/v1/tokens?id=eq.google_calendar`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({
        access_token: tokens.access_token,
        expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
      })
    });
  }
  return tokens;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, event } = req.body;

  // Get tokens from Supabase
  let tokenData = await getTokens();
  if (!tokenData) return res.status(401).json({ error: 'Calendar not connected' });

  // Refresh if expired
  if (new Date(tokenData.expires_at) < new Date()) {
    const refreshed = await refreshAccessToken(tokenData.refresh_token);
    if (!refreshed.access_token) return res.status(401).json({ error: 'Could not refresh token' });
    tokenData.access_token = refreshed.access_token;
  }

  const headers = {
    'Authorization': `Bearer ${tokenData.access_token}`,
    'Content-Type': 'application/json'
  };

  try {
    if (action === 'list') {
      const now = new Date();
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59);
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${now.toISOString()}&timeMax=${endOfDay.toISOString()}&singleEvents=true&orderBy=startTime`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'upcoming') {
      const now = new Date();
      const nextWeek = new Date(now);
      nextWeek.setDate(nextWeek.getDate() + 7);
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${now.toISOString()}&timeMax=${nextWeek.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=10`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'create') {
      const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST', headers,
        body: JSON.stringify(event)
      });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'delete') {
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${event.id}`, {
        method: 'DELETE', headers
      });
      return res.status(200).json({ success: r.ok });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
