const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VOX_FOLDER_NAME = 'Vox';
const INBOX_FOLDER_NAME = 'Inbox';

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

async function findOrCreateFolder(name, parentId, headers) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, { headers });
  const data = await search.json();
  if (data.files && data.files.length > 0) return data.files[0].id;
  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers,
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const folder = await create.json();
  return folder.id;
}

async function getRootId(headers) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files/root?fields=id', { headers });
  const data = await res.json();
  return data.id;
}

async function getDocText(fileId, headers) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers });
  if (!res.ok) return '';
  return await res.text();
}

async function getSheetText(fileId, headers) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`, { headers });
  if (!res.ok) return '';
  return await res.text();
}

// Get file as base64 for binary files (PDF, Word etc)
async function getFileBase64(fileId, mimeType, headers) {
  // For Word/Office files, try to export as plain text first
  const exportMap = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'text/plain',
    'application/msword': 'text/plain',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'text/csv',
    'application/vnd.ms-excel': 'text/csv',
  };
  if (exportMap[mimeType]) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMap[mimeType])}`,
      { headers: { ...headers, 'Content-Type': undefined } }
    );
    if (res.ok) {
      const text = await res.text();
      return { type: 'text', content: text.substring(0, 50000) };
    }
  }
  // For PDF and images: download as base64
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: headers.Authorization }
  });
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { type: 'base64', content: base64, mimeType };
}

// Create a Google Doc with text content in a folder
async function createDoc(name, content, folderId, headers) {
  // Create empty doc
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId]
    })
  });
  const doc = await createRes.json();
  if (!doc.id) return null;

  // Insert content via Docs API
  const updateRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${doc.id}:batchUpdate`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requests: [{ insertText: { location: { index: 1 }, text: content } }]
      })
    }
  );
  return { id: doc.id, name, url: `https://docs.google.com/document/d/${doc.id}/edit` };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vox-ten-iota.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, projectName, content, docName } = req.body;

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
      const rootId = await getRootId(headers);
      const voxId = await findOrCreateFolder(VOX_FOLDER_NAME, rootId, headers);
      const projectId = await findOrCreateFolder(projectName, voxId, headers);
      return res.status(200).json({ folderId: projectId, folderName: projectName });

    } else if (action === 'get_project_context') {
      const rootId = await getRootId(headers);
      const voxId = await findOrCreateFolder(VOX_FOLDER_NAME, rootId, headers);
      const projectId = await findOrCreateFolder(projectName, voxId, headers);
      const q = `'${projectId}' in parents and trashed=false`;
      const listRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc&pageSize=20`,
        { headers }
      );
      const listData = await listRes.json();
      const files = listData.files || [];
      if (files.length === 0) return res.status(200).json({ context: '', files: [], folderId: projectId });
      const contexts = [];
      for (const file of files.slice(0, 5)) {
        let text = '';
        if (file.mimeType === 'application/vnd.google-apps.document') text = await getDocText(file.id, headers);
        else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') text = await getSheetText(file.id, headers);
        if (text) contexts.push(`--- ${file.name} ---\n${text.substring(0, 2000)}`);
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

    } else if (action === 'list_inbox') {
      // List files in Vox/Inbox
      const rootId = await getRootId(headers);
      console.log('Root ID:', rootId);
      const voxId = await findOrCreateFolder(VOX_FOLDER_NAME, rootId, headers);
      console.log('Vox folder ID:', voxId);
      const inboxId = await findOrCreateFolder(INBOX_FOLDER_NAME, voxId, headers);
      console.log('Inbox folder ID:', inboxId);
      const q = `'${inboxId}' in parents and trashed=false`;
      console.log('Query:', q);
      const listRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=modifiedTime desc`,
        { headers }
      );
      const data = await listRes.json();
      console.log('Inbox files response:', JSON.stringify(data));
      return res.status(200).json({ files: data.files || [], folderId: inboxId, debug: { rootId, voxId, inboxId } });

    } else if (action === 'read_inbox_file') {
      // Read a specific file from inbox (or by id) and return content for Claude
      const { fileId, fileName } = req.body;
      let targetId = fileId;
      let targetName = fileName;
      let targetMime = req.body.mimeType;

      // If no fileId, get first file from inbox
      if (!targetId) {
        const rootId = await getRootId(headers);
        const voxId = await findOrCreateFolder(VOX_FOLDER_NAME, rootId, headers);
        const inboxId = await findOrCreateFolder(INBOX_FOLDER_NAME, voxId, headers);
        const q = `'${inboxId}' in parents and trashed=false`;
        const listRes = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&orderBy=modifiedTime desc&pageSize=1`,
          { headers }
        );
        const listData = await listRes.json();
        const first = listData.files?.[0];
        if (!first) return res.status(200).json({ error: 'Inbox is empty' });
        targetId = first.id;
        targetName = first.name;
        targetMime = first.mimeType;
      }

      // Extract content based on type
      let fileContent = null;
      if (targetMime === 'application/vnd.google-apps.document') {
        const text = await getDocText(targetId, headers);
        fileContent = { type: 'text', content: text.substring(0, 50000) };
      } else if (targetMime === 'application/vnd.google-apps.spreadsheet') {
        const text = await getSheetText(targetId, headers);
        fileContent = { type: 'text', content: text.substring(0, 50000) };
      } else {
        fileContent = await getFileBase64(targetId, targetMime, headers);
      }

      return res.status(200).json({
        fileId: targetId,
        fileName: targetName,
        mimeType: targetMime,
        content: fileContent
      });

    } else if (action === 'save_to_project') {
      // Save text content as Google Doc in Vox/ProjectName/
      const rootId = await getRootId(headers);
      const voxId = await findOrCreateFolder(VOX_FOLDER_NAME, rootId, headers);
      const projectId = await findOrCreateFolder(projectName, voxId, headers);
      const name = docName || `Vox — ${new Date().toLocaleDateString('da-DK')}`;
      const doc = await createDoc(name, content, projectId, headers);
      if (!doc) return res.status(500).json({ error: 'Could not create document' });
      return res.status(200).json({ success: true, ...doc });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Drive error:', err);
    return res.status(500).json({ error: err.message });
  }
}
