const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VOX_FOLDER_NAME = 'Vox';

async function getTokens() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tokens?id=eq.google_calendar&select=*`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
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
    await fetch(`${SUPABASE_URL}/rest/v1/tokens?id=eq.google_calendar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ access_token: tokens.access_token, expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString() })
    });
  }
  return tokens;
}

// Find or create a folder by name under a parent
async function findOrCreateFolder(name, parentId, headers) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, { headers });
  const data = await search.json();
  if (data.files && data.files.length > 0) return data.files[0].id;

  // Create it
  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers,
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const folder = await create.json();
  return folder.id;
}

// Get root Drive folder id
async function getRootId(headers) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files/root?fields=id', { headers });
  const data = await res.json();
  return data.id;
}

// Extract text from a Google Doc
async function getDocText(fileId, headers) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers });
  if (!res.ok) return '';
  return await res.text();
}

// Extract text from a Sheet (first sheet as CSV)
async function getSheetText(fileId, headers) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`, { headers });
  if (!res.ok) return '';
  return await res.text();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, projectName } = req.body;

  let tokenData = await getTokens();
  if (!tokenData) return res.status(401).json({ error: 'Not connected' });
  if (new Date(tokenData.expires_at) < new Date()) {
    const refreshed = await refreshAccessToken(tokenData.refresh_token);
    if (!refreshed.access_token) return res.status(401).json({ error: 'Token refresh failed' });
    tokenData.access_token = refreshed.access_token;
  }

  const headers = {
    'Authorization': `Bearer ${tokenData.access_token}`,
    'Content-Type': 'application/json'
  };

  try {
    if (action === 'ensure_project_folder') {
      // Find or create Vox/ProjectName folder
      const rootId = await getRootId(headers);
      const voxId = await findOrCreateFolder(VOX_FOLDER_NAME, rootId, headers);
      const projectId = await findOrCreateFolder(projectName, voxId, headers);
      return res.status(200).json({ folderId: projectId, folderName: projectName });

    } else if (action === 'get_project_context') {
      // Get all files in Vox/ProjectName and extract text content
      const rootId = await getRootId(headers);
      const voxId = await findOrCreateFolder(VOX_FOLDER_NAME, rootId, headers);
      const projectId = await findOrCreateFolder(projectName, voxId, headers);

      // List files in project folder
      const q = `'${projectId}' in parents and trashed=false`;
      const listRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc&pageSize=20`,
        { headers }
      );
      const listData = await listRes.json();
      const files = listData.files || [];

      if (files.length === 0) {
        return res.status(200).json({ context: '', files: [], folderId: projectId });
      }

      // Extract text from each file (max 3 files, max 2000 chars each)
      const contexts = [];
      for (const file of files.slice(0, 5)) {
        let text = '';
        if (file.mimeType === 'application/vnd.google-apps.document') {
          text = await getDocText(file.id, headers);
        } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
          text = await getSheetText(file.id, headers);
        }
        if (text) {
          contexts.push(`--- ${file.name} ---\n${text.substring(0, 2000)}`);
        }
      }

      return res.status(200).json({
        context: contexts.join('\n\n'),
        files: files.map(f => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime })),
        folderId: projectId
      });

    } else if (action === 'list_files') {
      const rootId = await getRootId(headers);
      const voxId = await findOrCreateFolder(VOX_FOLDER_NAME, rootId, headers);
      const projectId = await findOrCreateFolder(projectName, voxId, headers);
      const q = `'${projectId}' in parents and trashed=false`;
      const listRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc`,
        { headers }
      );
      const data = await listRes.json();
      return res.status(200).json({ files: data.files || [], folderId: projectId });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Drive error:', err);
    return res.status(500).json({ error: err.message });
  }
}
