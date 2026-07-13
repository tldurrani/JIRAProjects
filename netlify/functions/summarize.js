// netlify/functions/summarize.js
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { title, description } = body;
  if (!title || !description) return { statusCode: 400, body: JSON.stringify({ error: 'Missing title or description' }) };

  const isQSummary = description.length > 1000;
  const maxTokens = isQSummary ? 4000 : 600;

  const systemPrompt = isQSummary
    ? `You are a senior engineering PM writing quarterly reports.
You MUST write all 5 sections. Never truncate or cut off mid-sentence.
Cover EVERY theme provided — do not skip any.
Use this formatting:
- Bold section titles using **TITLE**
- Use bullet points (- item) for lists of stories, risks, or action items
- Keep paragraphs short and scannable
- Be specific: reference actual epic keys (e.g. DM-3093), story counts, and percentages`
    : `You are a senior engineering PM writing epic summaries.
Write 3-4 sentences. Use **bold** for key terms or story titles if helpful.
Reference specific story titles from the data. Describe what was accomplished, what is in progress, and what remains.
Keep it concise and factual.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: description.slice(0, 12000) }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: 'Anthropic API error', detail: errText }) };
    }

    const data = await response.json();
    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) return { statusCode: 500, body: JSON.stringify({ error: 'No response from Claude', detail: JSON.stringify(data) }) };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ summary: text }),
    };
  } catch(err) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Anthropic API', detail: err.message }) };
  }
};
