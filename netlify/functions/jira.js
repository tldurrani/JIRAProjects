// netlify/functions/jira.js
const JIRA_BASE  = process.env.JIRA_BASE_URL || 'https://riversidejira.atlassian.net';
const JIRA_EMAIL = (process.env.JIRA_EMAIL || '').trim();
const JIRA_TOKEN = (process.env.JIRA_API_TOKEN || '').trim();
const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

const ALLOWED_PATHS = [
  /^\/rest\/api\/3\/issue\/[A-Z][A-Z0-9]*-[A-Z0-9]+/,  // issue key: DM-123, BTS-GATE, BLUEPRINT-109
  /^\/rest\/api\/3\/search/,                              // JQL search
  /^\/rest\/api\/3\/project/,                             // project list
  /^\/rest\/api\/3\/myself/,                              // auth check
  /^\/rest\/api\/3\/label/,                               // label autocomplete
  /^\/rest\/api\/3\/version/,                             // fix versions for release notes
];

function isAllowed(path) {
  const pathOnly = path.split('?')[0];
  return ALLOWED_PATHS.some(re => re.test(pathOnly));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const jiraPath = event.queryStringParameters?.path;
  if (!jiraPath) return { statusCode: 400, body: JSON.stringify({ error: 'Missing ?path= parameter' }) };

  if (!isAllowed(jiraPath)) {
    console.error('Path not permitted:', jiraPath.split('?')[0]);
    return { statusCode: 403, body: JSON.stringify({ error: 'Path not permitted', path: jiraPath.split('?')[0] }) };
  }

  if (!JIRA_EMAIL || !JIRA_TOKEN) return { statusCode: 500, body: JSON.stringify({ error: 'Jira credentials not configured' }) };

  try {
    const url = `${JIRA_BASE}${jiraPath}`;
    const response = await fetch(url, { headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' } });
    const body = await response.text();
    return { statusCode: response.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }, body };
  } catch (err) {
    console.error('Jira proxy error:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Jira', detail: err.message }) };
  }
};
