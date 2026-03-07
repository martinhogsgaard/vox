export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('https://vox-ten-iota.vercel.app?calendar=error');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = 'https://vox-ten-iota.vercel.app/api/google-callback';

  try {
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

    // Pass tokens back to the app via URL params (stored in Supabase by the app)
    const params = new URLSearchParams({
      calendar: 'connected',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      expires_in: tokens.expires_in || 3600
    });

    res.redirect(`https://vox-ten-iota.vercel.app?${params}`);

  } catch (err) {
    console.error('Callback error:', err);
    res.redirect('https://vox-ten-iota.vercel.app?calendar=error');
  }
}
