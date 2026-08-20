// netlify/functions/sprintplanning.js
// Publishes Sprint Planning approval documents to Confluence.
//
// Structure created in Confluence:
//   Folder (given, id below)
//     └── "Sprint Planning <TEAM>"   (auto-created per team the first time it's needed)
//           └── "<Sprint Name> — <Team> — Sprint Approval"   (one page per sprint+team,
//                                                              updated in place on regenerate)

const CONFLUENCE_BASE = 'https://riversidejira.atlassian.net/wiki';
const SPACE_KEY = 'LSPMDM';
const FOLDER_ID = '926220304';
const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://riversidejira.atlassian.net';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function getConfluenceAuth() {
  const email = (process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL || '').trim();
  const token = (process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN || '').trim();
  return Buffer.from(`${email}:${token}`).toString('base64');
}

async function confluenceFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Basic ${getConfluenceAuth()}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${CONFLUENCE_BASE}${path}`, opts);
  if (!res.ok) throw new Error(`Confluence ${res.status}: ${await res.text()}`);
  return res.json();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sectionTitleForTeam(team) {
  return `Sprint Planning ${team || 'Unassigned'}`;
}

async function findChildPageByTitle(parentId, title) {
  const cql = `ancestor=${parentId} and title="${title.replace(/"/g, '\\"')}"`;
  const data = await confluenceFetch(`/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=1`);
  return (data.results && data.results[0]) || null;
}

async function createPage(parentId, title, htmlBody) {
  return confluenceFetch('/rest/api/content', 'POST', {
    type: 'page',
    title,
    space: { key: SPACE_KEY },
    ancestors: [{ id: parentId }],
    body: { storage: { value: htmlBody, representation: 'storage' } },
  });
}

async function updatePage(pageId, currentVersion, title, htmlBody) {
  return confluenceFetch(`/rest/api/content/${pageId}`, 'PUT', {
    id: pageId,
    type: 'page',
    status: 'current',
    title,
    version: { number: currentVersion + 1 },
    body: { storage: { value: htmlBody, representation: 'storage' } },
  });
}

async function findOrCreateSection(team) {
  const title = sectionTitleForTeam(team);
  const existing = await findChildPageByTitle(FOLDER_ID, title);
  if (existing) return { id: existing.id, title, created: false };
  const created = await createPage(
    FOLDER_ID,
    title,
    `<p>Sprint approval pages for the ${escapeHtml(team)} team live here. Each sprint gets its own page, created automatically from the Sprint Planning tab.</p>`
  );
  return { id: created.id, title, created: true };
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildSprintTableHtml(team, sprintName, rows) {
  const generated = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const rowsHtml = rows.map((r, idx) => {
    const taskId = idx + 1;
    const labelsText = Array.isArray(r.labels) && r.labels.length ? r.labels.map(escapeHtml).join(', ') : '\u2014';
    const flagHtml = r.flagged ? '<span style="color:#c9372c;font-weight:600">\uD83D\uDEA9 Flagged</span>' : '';
    return `<tr>
      <td><a href="${JIRA_BASE}/browse/${escapeHtml(r.key)}">${escapeHtml(r.key)}</a></td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.severity || '\u2014')}</td>
      <td>${labelsText}</td>
      <td>${escapeHtml(r.assignee || 'Unassigned')}</td>
      <td>${escapeHtml(r.reporter || '\u2014')}</td>
      <td>${fmtDate(r.created)}</td>
      <td>${flagHtml}</td>
      <td>${escapeHtml(r.summary || '')}</td>
      <td><ac:task-list><ac:task><ac:task-id>${taskId}</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Approved</ac:task-body></ac:task></ac:task-list></td>
      <td>&nbsp;</td>
    </tr>`;
  }).join('\n');

  return `<h1>${escapeHtml(sprintName)} \u2014 ${escapeHtml(team)} \u2014 Sprint Approval</h1>
<p>Generated ${generated} from the Sprint Planning tab. Review each ticket below, check the box once approved, and add your name in the "Approved By" column.</p>
<table>
  <tbody>
    <tr>
      <th>Ticket</th><th>Type</th><th>Severity</th><th>Labels</th><th>Assignee</th><th>Reporter</th><th>Created</th><th>Flag</th><th>Summary</th><th>Approved</th><th>Approved By</th>
    </tr>
    ${rowsHtml}
  </tbody>
</table>`;
}

async function publishSprintPage({ team, sprintName, rows }) {
  const section = await findOrCreateSection(team);
  const pageTitle = `${sprintName} \u2014 ${team} \u2014 Sprint Approval`;
  const html = buildSprintTableHtml(team, sprintName, rows);

  const existing = await findChildPageByTitle(section.id, pageTitle);
  let result;
  let wasUpdate = false;
  if (existing) {
    const full = await confluenceFetch(`/rest/api/content/${existing.id}?expand=version`);
    result = await updatePage(existing.id, full.version.number, pageTitle, html);
    wasUpdate = true;
  } else {
    result = await createPage(section.id, pageTitle, html);
  }
  const url = `${CONFLUENCE_BASE}/spaces/${SPACE_KEY}/pages/${result.id}`;
  return { url, pageId: result.id, sectionTitle: section.title, sectionCreated: section.created, updated: wasUpdate };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { team, sprintName, rows } = body;
  if (!team || !sprintName || !Array.isArray(rows) || !rows.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing team, sprintName, or rows' }) };
  }

  try {
    const result = await publishSprintPage({ team, sprintName, rows });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, ...result }) };
  } catch (e) {
    console.error('sprintplanning publish error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
