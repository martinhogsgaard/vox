// Keywords that suggest web search is needed
const SEARCH_TRIGGERS = [
  'find', 'search', 'look up', 'what is', 'where is', 'address', 'price', 'cost',
  'weather', 'news', 'latest', 'current', 'today', 'restaurant', 'store', 'shop',
  'phone', 'number', 'hours', 'open', 'website', 'email', 'contact',
  'find', 'søg', 'hvad er', 'hvor er', 'adresse', 'pris', 'vejret', 'nyheder',
  'restaurant', 'butik', 'telefon', 'åbningstider', 'hjemmeside'
];

// Keywords that mean we should NOT search (fast actions)
const NO_SEARCH_TRIGGERS = [
  'ACTION:', 'create_event', 'send_email', 'find_contact', 'delete_event',
  'opret møde', 'opret projekt', 'send mail', 'slet møde', 'flyt møde',
  'har jeg møder', 'hvad sker der', 'kalender'
];

function shouldUseWebSearch(messages) {
  const lastMessage = messages?.[messages.length - 1]?.content || '';
  const text = (typeof lastMessage === 'string' ? lastMessage : '').toLowerCase();
  
  // Never search for action-type requests
  if (NO_SEARCH_TRIGGERS.some(t => text.includes(t.toLowerCase()))) return false;
  
  // Search if any search trigger found
  return SEARCH_TRIGGERS.some(t => text.includes(t.toLowerCase()));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vox-ten-iota.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const useSearch = shouldUseWebSearch(body.messages);

    const requestBody = useSearch
      ? { ...body, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }
      : body;

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      ...(useSearch && { 'anthropic-beta': 'web-search-2025-03-05' })
    };

    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify(requestBody)
    });
    let data = await response.json();

    // Handle web search tool loop
    let iterations = 0;
    while (data.stop_reason === 'tool_use' && iterations < 3) {
      iterations++;
      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      const messages = [
        ...(requestBody.messages || []),
        { role: 'assistant', content: data.content },
        {
          role: 'user',
          content: toolUseBlocks.map(block => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(block.input)
          }))
        }
      ];

      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers,
        body: JSON.stringify({ ...requestBody, messages })
      });
      data = await response.json();
    }

    // Return only text blocks
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
