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

// Confluence enforces page titles to be unique across an entire SPACE, not
// just among siblings under the same parent. Looking this up scoped to a
// parent (ancestor=X in CQL) could miss a page that already exists
// elsewhere in the space, and CQL search can also lag slightly behind a
// very recent create. This queries content directly by space+title, which
// is what actually determines whether a create will collide.
async function findPageByTitleInSpace(title) {
  const data = await confluenceFetch(
    `/rest/api/content?spaceKey=${encodeURIComponent(SPACE_KEY)}&title=${encodeURIComponent(title)}&type=page&expand=version`
  );
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

// Creates the page, but if Confluence rejects it because a page with that
// title already exists (a race, or our lookup missing it for any reason),
// self-heal by looking it up again and updating instead of failing.
async function createOrUpdatePage(parentId, title, htmlBody, knownExisting) {
  let existing = knownExisting;
  if (!existing) {
    try {
      return { result: await createPage(parentId, title, htmlBody), wasUpdate: false };
    } catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
      existing = await findPageByTitleInSpace(title);
      if (!existing) throw e; // genuinely something else went wrong
    }
  }
  const full = existing.version ? existing : await confluenceFetch(`/rest/api/content/${existing.id}?expand=version`);
  const result = await updatePage(existing.id, full.version.number, title, htmlBody);
  return { result, wasUpdate: true };
}

async function findOrCreateSection(team) {
  const title = sectionTitleForTeam(team);
  const existing = await findPageByTitleInSpace(title);
  if (existing) return { id: existing.id, title, created: false };
  const { result } = await createOrUpdatePage(
    FOLDER_ID,
    title,
    `<p>Sprint approval pages for the ${escapeHtml(team)} team live here. Each sprint gets its own page, created automatically from the Sprint Planning tab.</p>`,
    null
  );
  return { id: result.id, title, created: true };
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Pulls the current checked/unchecked state and "Approved By" text out of an
// existing page's storage-format body, keyed by ticket key (matched via the
// Jira link in the first cell, not row position - so this still lines up
// correctly even if tickets were added/removed/reordered since last publish).
function extractPreviousApprovals(oldHtml) {
  const map = {};
  if (!oldHtml) return map;
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(oldHtml))) {
    const rowHtml = m[1];
    const keyMatch = rowHtml.match(/\/browse\/([A-Z][A-Z0-9]*-\d+)/);
    if (!keyMatch) continue; // header row, or a row without a recognizable ticket link
    const key = keyMatch[1];
    const statusMatch = rowHtml.match(/<ac:task-status>(complete|incomplete)<\/ac:task-status>/);
    const approved = statusMatch ? statusMatch[1] === 'complete' : false;
    const tdMatches = rowHtml.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    const lastTd = tdMatches[tdMatches.length - 1] || '';
    const approvedBy = lastTd
      .replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    map[key] = { approved, approvedBy };
  }
  return map;
}

function buildSprintTableHtml(team, sprintName, rows, previousApprovals) {
  previousApprovals = previousApprovals || {};
  const generated = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const rowsHtml = rows.map((r, idx) => {
    const taskId = idx + 1;
    const labelsText = Array.isArray(r.labels) && r.labels.length ? r.labels.map(escapeHtml).join(', ') : '\u2014';
    const flagHtml = r.flagged ? '<span style="color:#c9372c;font-weight:600">\uD83D\uDEA9 Flagged</span>' : '';
    const prev = previousApprovals[r.key];
    const taskStatus = prev && prev.approved ? 'complete' : 'incomplete';
    const approvedByCell = prev && prev.approvedBy ? escapeHtml(prev.approvedBy) : '&nbsp;';
    return `<tr>
      <td><a href="${JIRA_BASE}/browse/${escapeHtml(r.key)}">${escapeHtml(r.key)}</a></td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.severity || '\u2014')}</td>
      <td>${labelsText}</td>
      <td>${escapeHtml(r.assignee || 'Unassigned')}</td>
      <td>${escapeHtml(r.reporter || '\u2014')}</td>
      <td>${fmtDate(r.created)}</td>
      <td>${escapeHtml(r.release || '\u2014')}</td>
      <td>${flagHtml}</td>
      <td>${escapeHtml(r.summary || '')}</td>
      <td><ac:task-list><ac:task><ac:task-id>${taskId}</ac:task-id><ac:task-status>${taskStatus}</ac:task-status><ac:task-body>Approved</ac:task-body></ac:task></ac:task-list></td>
      <td>${approvedByCell}</td>
    </tr>`;
  }).join('\n');

  // If every ticket points at the same release, call it out up top - that's
  // the "potential release date" for the sprint as a whole, not just a
  // per-ticket detail buried in a column.
  const distinctReleases = Array.from(new Set(rows.map(r => r.release).filter(Boolean)));
  const releaseNote = distinctReleases.length === 1
    ? `<p><strong>Target Release:</strong> ${escapeHtml(distinctReleases[0])}</p>`
    : '';

  // Column widths, in px - Summary and Approved By get the most room since
  // they hold prose/free text; everything else is a short fixed value so it
  // doesn't need to wrap at all. data-layout="full-width" is the same
  // attribute Confluence's editor sets when you choose the "Full width"
  // table option, so this renders across the whole page instead of
  // Confluence's default constrained/centered width.
  const colWidths = [90, 70, 80, 140, 120, 120, 100, 130, 70, 320, 100, 150];
  const colgroup = `<colgroup>${colWidths.map(w => `<col style="width: ${w}.0px;" />`).join('')}</colgroup>`;

  return `<h1>${escapeHtml(sprintName)} \u2014 ${escapeHtml(team)} \u2014 Sprint Approval</h1>
<p>Generated ${generated} from the Sprint Planning tab. Review each ticket below, check the box once approved, and add your name in the "Approved By" column.</p>
${releaseNote}
<table data-layout="full-width">
  ${colgroup}
  <tbody>
    <tr>
      <th>Ticket</th><th>Type</th><th>Severity</th><th>Labels</th><th>Assignee</th><th>Reporter</th><th>Created</th><th>Release</th><th>Flag</th><th>Summary</th><th>Approved</th><th>Approved By</th>
    </tr>
    ${rowsHtml}
  </tbody>
</table>`;
}

async function publishSprintPage({ team, sprintName, rows }) {
  const section = await findOrCreateSection(team);
  const pageTitle = `${sprintName} \u2014 ${team} \u2014 Sprint Approval`;

  let existing = await findPageByTitleInSpace(pageTitle);
  let previousApprovals = {};
  if (existing) {
    const full = await confluenceFetch(`/rest/api/content/${existing.id}?expand=body.storage,version`);
    previousApprovals = extractPreviousApprovals(full.body && full.body.storage && full.body.storage.value);
    existing = full; // carry the version forward so createOrUpdatePage doesn't need to re-fetch it
  }

  const html = buildSprintTableHtml(team, sprintName, rows, previousApprovals);
  const { result, wasUpdate } = await createOrUpdatePage(section.id, pageTitle, html, existing);

  const preservedCount = rows.filter(r => {
    const p = previousApprovals[r.key];
    return p && (p.approved || p.approvedBy);
  }).length;

  const url = `${CONFLUENCE_BASE}/spaces/${SPACE_KEY}/pages/${result.id}`;
  return { url, pageId: result.id, sectionTitle: section.title, sectionCreated: section.created, updated: wasUpdate, preservedApprovals: preservedCount };
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
