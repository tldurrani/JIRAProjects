// netlify/functions/confluence.js
// READ-ONLY. Given a Confluence page link (or its numeric id), returns the page
// title and the Jira ticket keys it mentions, in plan order.
//
// Used by the Planning tab: the page decides which tickets are listed and the
// order they start in; Jira supplies everything else about them live.
//
//   GET /api/confluence?page=<page link or id>
//   -> { id, title, url, keys: ["DM-1","DEVO-2",...], tableKeys: 73 }
//
// The link the user pastes is only ever used to pull out the numeric page id.
// The request itself always goes to the fixed Confluence site below, so this
// can't be pointed at another host.

const CONFLUENCE_BASE = process.env.CONFLUENCE_BASE_URL || 'https://riversidejira.atlassian.net/wiki';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

function getAuth() {
  const email = (process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL || '').trim();
  const token = (process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN || '').trim();
  if (!email || !token) return null;
  return Buffer.from(`${email}:${token}`).toString('base64');
}

// Accepts a full page URL (.../pages/123456/Some+Title), an old-style
// viewpage.action?pageId=123456 link, or just the number.
function parsePageId(input) {
  const s = String(input == null ? '' : input).trim();
  if (/^\d{3,}$/.test(s)) return s;
  let m = s.match(/\/pages\/(\d{3,})/);
  if (m) return m[1];
  m = s.match(/[?&]pageId=(\d{3,})/);
  return m ? m[1] : null;
}

// Ticket-shaped strings in document order, each once. The shape is loose
// (it will also match things like "Q4-2026" or "SHA-256"), so the caller
// narrows it to real project keys.
function distinctKeys(text) {
  const re = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
  const seen = new Set(), out = [];
  let m;
  while ((m = re.exec(text))) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

// A plan page usually mentions tickets in several places: a sentence in the
// summary, a table of the plan itself, links in the evidence and risks
// sections. Document order would put whatever the summary happens to name
// first ahead of the plan. So the table that lists the most tickets is taken
// to BE the plan and goes first, in its row order; tickets mentioned anywhere
// else follow in the order they appear.
function orderedKeys(body) {
  const tables = String(body || '').match(/<table[\s\S]*?<\/table>/gi) || [];
  let plan = [];
  tables.forEach((t) => { const k = distinctKeys(t); if (k.length > plan.length) plan = k; });
  const inPlan = new Set(plan);
  const rest = distinctKeys(body).filter((k) => !inPlan.has(k));
  return { keys: plan.concat(rest), tableKeys: plan.length };
}

async function confluenceGet(path, auth) {
  const res = await fetch(`${CONFLUENCE_BASE}${path}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`Confluence ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'GET') return reply(405, { error: 'Method not allowed' });

  const id = parsePageId((event.queryStringParameters || {}).page);
  if (!id) return reply(400, { error: 'Paste the link to a Confluence page (the address in your browser), or its page number.' });

  const auth = getAuth();
  if (!auth) return reply(500, { error: 'Confluence credentials are not configured on the server.' });

  try {
    const data = await confluenceGet(`/rest/api/content/${id}?expand=body.storage,version`, auth);
    const body = (data.body && data.body.storage && data.body.storage.value) || '';
    const { keys, tableKeys } = orderedKeys(body);
    const links = data._links || {};
    const url = (links.base || CONFLUENCE_BASE) + (links.webui || `/pages/viewpage.action?pageId=${id}`);
    return reply(200, { id: String(data.id || id), title: data.title || `Page ${id}`, url, keys, tableKeys });
  } catch (e) {
    if (e.status === 404) return reply(404, { error: 'That page was not found, or this app does not have access to it.' });
    if (e.status === 401 || e.status === 403) return reply(502, { error: 'Confluence refused the request. Check the Confluence credentials on the server.' });
    return reply(502, { error: 'Could not read the page from Confluence: ' + e.message });
  }
};

// exported for tests
exports._internal = { parsePageId, distinctKeys, orderedKeys };
