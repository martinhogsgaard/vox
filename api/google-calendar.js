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
  return response.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, access_token, refresh_token, event } = req.body;
  let token = access_token;

  // Refresh token if needed
  if (!token && refresh_token) {
    const refreshed = await refreshAccessToken(refresh_token);
    if (refreshed.access_token) token = refreshed.access_token;
    else return res.status(401).json({ error: 'Could not refresh token' });
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  try {
    if (action === 'list') {
      // Get today's events
      const now = new Date();
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59);

      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${now.toISOString()}&` +
        `timeMax=${endOfDay.toISOString()}&` +
        `singleEvents=true&orderBy=startTime`;

      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'create') {
      const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers,
        body: JSON.stringify(event)
      });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'delete') {
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${event.id}`, {
        method: 'DELETE',
        headers
      });
      return res.status(200).json({ success: r.ok });

    } else if (action === 'upcoming') {
      // Get next 7 days
      const now = new Date();
      const nextWeek = new Date(now);
      nextWeek.setDate(nextWeek.getDate() + 7);

      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${now.toISOString()}&` +
        `timeMax=${nextWeek.toISOString()}&` +
        `singleEvents=true&orderBy=startTime&maxResults=10`;

      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
