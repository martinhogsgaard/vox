export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Add web search tool so Vox can look up real-time data
    const bodyWithSearch = {
      ...body,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search'
        }
      ]
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify(bodyWithSearch)
    });

    const data = await response.json();

    // Extract text from response — web search may return multiple content blocks
    if (data.content && Array.isArray(data.content)) {
      const textBlocks = data.content.filter(b => b.type === 'text');
      if (textBlocks.length > 0) {
        // Return simplified response with just the text content
        return res.status(200).json({
          ...data,
          content: textBlocks
        });
      }
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'API call failed', message: error.message });
  }
}
