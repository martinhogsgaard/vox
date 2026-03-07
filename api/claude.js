export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const bodyWithSearch = {
      ...body,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    };

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    };

    // First call
    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify(bodyWithSearch)
    });
    let data = await response.json();

    // If Claude wants to use web search, handle the tool loop
    let iterations = 0;
    while (data.stop_reason === 'tool_use' && iterations < 3) {
      iterations++;

      // Find tool use blocks
      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      // Build messages with tool results
      const messages = [
        ...(bodyWithSearch.messages || []),
        { role: 'assistant', content: data.content },
        {
          role: 'user',
          content: toolUseBlocks.map(block => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(block.input) // Anthropic handles the actual search
          }))
        }
      ];

      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers,
        body: JSON.stringify({ ...bodyWithSearch, messages })
      });
      data = await response.json();
    }

    // Extract only text blocks for the app
    if (data.content && Array.isArray(data.content)) {
      const textBlocks = data.content.filter(b => b.type === 'text');
      if (textBlocks.length > 0) {
        return res.status(200).json({ ...data, content: textBlocks });
      }
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'API call failed', message: error.message });
  }
}
