export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('https://vox-ten-iota.vercel.app?calendar=error');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = 'https://vox-ten-iota.vercel.app/api/google-callback';
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  try {
    // Exchange code for tokens
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await response.json();

    if (tokens.error) {
      console.error('Token error:', tokens);
      return res.redirect('https://vox-ten-iota.vercel.app?calendar=error');
    }

    // Store tokens securely in Supabase — never in URL
    await fetch(`${supabaseUrl}/rest/v1/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        id: 'google_calendar',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || '',
        expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
      })
    });

    // Redirect with NO tokens in URL
    res.redirect('https://vox-ten-iota.vercel.app?calendar=connected');

  } catch (err) {
    console.error('Callback error:', err);
    res.redirect('https://vox-ten-iota.vercel.app?calendar=error');
  }
}
