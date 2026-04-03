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
  res.setHeader('Access-Control-Allow-Origin', 'https://vox-ten-iota.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, event } = req.body;

  let tokenData = await getTokens();
  if (!tokenData) return res.status(401).json({ error: 'Calendar not connected' });

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

    } else if (action === 'upcoming_14') {
      const now = new Date();
      const future = new Date(now);
      future.setFullYear(future.getFullYear() + 1);
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${now.toISOString()}&timeMax=${future.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=100`;
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

    } else if (action === 'list_date') {
      const date = req.body.date;
      const timeFrom = req.body.time_from;
      const timeTo = req.body.time_to;
      const offset = '+01:00';
      const dayStart = timeFrom
        ? new Date(`${date}T${timeFrom}:00${offset}`)
        : new Date(`${date}T00:00:00${offset}`);
      const dayEnd = timeTo
        ? new Date(`${date}T${timeTo}:00${offset}`)
        : new Date(`${date}T23:59:59${offset}`);
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${dayStart.toISOString()}&timeMax=${dayEnd.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=20`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'create') {
      let eventBody;
      const title = event.summary || event.title;
      const isReminder = event.reminder === true;
      const reminderOverrides = isReminder
        ? { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }
        : { useDefault: true };

      const description = event.description || '';
      const location = event.location || '';

      if (event.allday) {
        eventBody = {
          summary: isReminder ? `🔔 ${title}` : title,
          description,
          ...(location && { location }),
          start: { date: event.date },
          end: { date: event.date },
          reminders: reminderOverrides
        };
      } else {
        const startTime = event.time || '09:00';
        const durationMins = isReminder ? 15 : (event.duration || 60);
        const [hours, mins] = startTime.split(':').map(Number);
        const totalMins = hours * 60 + mins + durationMins;
        const endHours = String(Math.floor(totalMins / 60) % 24).padStart(2, '0');
        const endMins = String(totalMins % 60).padStart(2, '0');
        const endDate = totalMins >= 1440
          ? (() => { const d = new Date(event.date); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; })()
          : event.date;
        eventBody = {
          summary: isReminder ? `🔔 ${title}` : title,
          description,
          ...(location && { location }),
          start: { dateTime: `${event.date}T${startTime}:00`, timeZone: 'Europe/Copenhagen' },
          end: { dateTime: `${endDate}T${endHours}:${endMins}:00`, timeZone: 'Europe/Copenhagen' },
          reminders: reminderOverrides
        };
      }
      const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST', headers,
        body: JSON.stringify(eventBody)
      });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'search') {
      const now = new Date();
      const future = new Date(now);
      future.setDate(future.getDate() + 30);
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${now.toISOString()}&timeMax=${future.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=20&q=${encodeURIComponent(event.query)}`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'get') {
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${event.id}`, { headers });
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'delete') {
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${event.id}`, {
        method: 'DELETE', headers
      });
      return res.status(200).json({ success: r.ok });

    } else if (action === 'update') {
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${event.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify(event.updates)
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
