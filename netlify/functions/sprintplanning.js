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
//
// buildHtml is a function, not a pre-built string: (existingFullPageOrNull) => html.
// This matters because whichever page we end up updating - found via the
// caller's own lookup, or via the self-heal fallback below - needs its HTML
// built from THAT page's real current body, not from an earlier lookup that
// may have failed to find it. Building the HTML too early, before knowing
// which page (if any) will actually be updated, was exactly the bug that
// caused approval checkboxes/names to get silently wiped whenever the
// self-heal path fired.
async function createOrUpdatePage(parentId, title, buildHtml, knownExisting) {
  let existing = knownExisting;
  if (!existing) {
    try {
      return { result: await createPage(parentId, title, buildHtml(null)), wasUpdate: false };
    } catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
      existing = await findPageByTitleInSpace(title);
      if (!existing) throw e; // genuinely something else went wrong
    }
  }
  // Always fetch the full current body+version for whichever page we ended
  // up with - never reuse a partial/stale `existing` object here.
  const full = await confluenceFetch(`/rest/api/content/${existing.id}?expand=body.storage,version`);
  const html = buildHtml(full);
  const result = await updatePage(existing.id, full.version.number, title, html);
  return { result, wasUpdate: true };
}

async function findOrCreateSectionByTitle(title, placeholderHtml) {
  const existing = await findPageByTitleInSpace(title);
  if (existing) return { id: existing.id, title, created: false };
  const { result } = await createOrUpdatePage(FOLDER_ID, title, () => placeholderHtml, null);
  return { id: result.id, title, created: true };
}

const COMBINED_SECTION_TITLE = 'Sprint Planning \u2014 Combined';

// Figures out which team(s)+sprint(s) a set of rows actually spans - drives
// the page title, the H1/subtitle, whether Team/Sprint need their own
// columns, and which section (per-team, or the shared Combined section) the
// page lives under. Shared by buildSprintTableHtml and publishSprintPage so
// they can never disagree with each other.
function deriveDocMeta(rows) {
  const pairKey = r => `${r.team || 'Unassigned'}|||${r.sprintName || 'Unknown Sprint'}`;
  const pairs = [];
  const seen = new Set();
  rows.forEach(r => {
    const k = pairKey(r);
    if (!seen.has(k)) { seen.add(k); pairs.push({ team: r.team || 'Unassigned', sprintName: r.sprintName || 'Unknown Sprint' }); }
  });
  const isCombined = pairs.length > 1;
  const title = isCombined
    ? `${pairs.map(p => `${p.team} ${p.sprintName}`).join(' + ')} \u2014 Combined Sprint Approval`
    : `${pairs[0].sprintName} \u2014 ${pairs[0].team} \u2014 Sprint Approval`;
  return { pairs, isCombined, title };
}

async function findOrCreateSection(meta) {
  if (!meta.isCombined) {
    const team = meta.pairs[0].team;
    return findOrCreateSectionByTitle(
      sectionTitleForTeam(team),
      `<p>Sprint approval pages for the ${escapeHtml(team)} team live here. Each sprint gets its own page, created automatically from the Sprint Planning tab.</p>`
    );
  }
  return findOrCreateSectionByTitle(
    COMBINED_SECTION_TITLE,
    `<p>Sprint approval pages spanning more than one team live here, created automatically from the Sprint Planning tab.</p>`
  );
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
  const diag = { rowsScanned: 0, rowsMatchedKey: 0, rowsWithApprovalData: 0 };
  if (!oldHtml) return { map, diag };
  // Allow attributes on <tr> - Confluence can add row-level metadata
  // (highlight colors, etc.) after any edit/save, and a bare <tr> match
  // would silently skip every such row.
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(oldHtml))) {
    diag.rowsScanned++;
    const rowHtml = m[1];
    const keyMatch = rowHtml.match(/\/browse\/([A-Z][A-Z0-9]*-\d+)/);
    if (!keyMatch) continue; // header row, or a row without a recognizable ticket link
    diag.rowsMatchedKey++;
    const key = keyMatch[1];
    const statusMatch = rowHtml.match(/<ac:task-status>\s*(complete|incomplete)\s*<\/ac:task-status>/);
    const approved = statusMatch ? statusMatch[1] === 'complete' : false;
    const tdMatches = rowHtml.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    const lastTd = tdMatches[tdMatches.length - 1] || '';
    const approvedBy = lastTd
      .replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (approved || approvedBy) diag.rowsWithApprovalData++;
    map[key] = { approved, approvedBy };
  }
  return { map, diag };
}

function buildSprintTableHtml(rows, previousApprovals) {
  previousApprovals = previousApprovals || {};
  const generated = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const meta = deriveDocMeta(rows);
  const pairs = meta.pairs;
  const isCombined = meta.isCombined;

  const rowsHtml = rows.map((r, idx) => {
    const taskId = idx + 1;
    const labelsText = Array.isArray(r.labels) && r.labels.length ? r.labels.map(escapeHtml).join(', ') : '\u2014';
    const flagHtml = r.flagged ? '<span style="color:#c9372c;font-weight:600">\uD83D\uDEA9 Flagged</span>' : '';
    const prev = previousApprovals[r.key];
    const taskStatus = prev && prev.approved ? 'complete' : 'incomplete';
    const approvedByCell = prev && prev.approvedBy ? escapeHtml(prev.approvedBy) : '&nbsp;';
    const epicCell = r.epicKey
      ? `<a href="${JIRA_BASE}/browse/${escapeHtml(r.epicKey)}">${escapeHtml(r.epicKey)}${r.epicName ? ' \u2014 ' + escapeHtml(r.epicName) : ''}</a>`
      : '\u2014';
    const teamSprintCells = isCombined
      ? `<td>${escapeHtml(r.team || '\u2014')}</td><td>${escapeHtml(r.sprintName || '\u2014')}</td>`
      : '';
    return `<tr>
      <td><a href="${JIRA_BASE}/browse/${escapeHtml(r.key)}">${escapeHtml(r.key)}</a></td>
      <td>${escapeHtml(r.name || '')}</td>
      ${teamSprintCells}
      <td>${epicCell}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.severity || '\u2014')}</td>
      <td>${labelsText}</td>
      <td>${escapeHtml(r.assignee || 'Unassigned')}</td>
      <td>${escapeHtml(r.reporter || '\u2014')}</td>
      <td>${fmtDate(r.created)}</td>
      <td>${escapeHtml(r.release || '\u2014')}</td>
      <td>${flagHtml}</td>
      <td>${escapeHtml(r.summary || '')}</td>
      <td><ac:task-list><ac:task><ac:task-id>${taskId}</ac:task-id><ac:task-status>${taskStatus}</ac:task-status><ac:task-body>&nbsp;</ac:task-body></ac:task></ac:task-list></td>
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

  const title = meta.title;

  // When combined, spell out exactly which teams/sprints are included so
  // it's unambiguous at a glance which rows belong to which team.
  const includedNote = isCombined
    ? `<p><strong>Included:</strong> ${pairs.map(p => `${escapeHtml(p.team)} \u2014 ${escapeHtml(p.sprintName)}`).join(' &nbsp;|&nbsp; ')}</p>`
    : '';

  const headerCols = isCombined
    ? '<th>Ticket</th><th>Name</th><th>Team</th><th>Sprint</th><th>Epic</th><th>Type</th><th>Severity</th><th>Labels</th><th>Assignee</th><th>Reporter</th><th>Created</th><th>Release</th><th>Flag</th><th>Summary</th><th>Approved</th><th>Approved By</th>'
    : '<th>Ticket</th><th>Name</th><th>Epic</th><th>Type</th><th>Severity</th><th>Labels</th><th>Assignee</th><th>Reporter</th><th>Created</th><th>Release</th><th>Flag</th><th>Summary</th><th>Approved</th><th>Approved By</th>';

  // Column widths, in px - Name/Epic/Summary/Approved By get the most room
  // since they hold prose/free text; everything else is a short fixed value
  // so it doesn't need to wrap at all. data-layout="full-width" is the same
  // attribute Confluence's editor sets when you choose the "Full width"
  // table option, so this renders across the whole page instead of
  // Confluence's default constrained/centered width.
  const colWidths = isCombined
    ? [90, 200, 100, 130, 190, 70, 80, 130, 110, 110, 100, 120, 70, 260, 90, 140]
    : [90, 220, 190, 70, 80, 140, 120, 120, 100, 130, 70, 280, 90, 150];
  const colgroup = `<colgroup>${colWidths.map(w => `<col style="width: ${w}.0px;" />`).join('')}</colgroup>`;

  return `<h1>${escapeHtml(title)}</h1>
<p>Generated ${generated} from the Sprint Planning tab. Review each ticket below, check the box once approved, and add your name in the "Approved By" column.</p>
${includedNote}
${releaseNote}
<table data-layout="full-width">
  ${colgroup}
  <tbody>
    <tr>
      ${headerCols}
    </tr>
    ${rowsHtml}
  </tbody>
</table>`;
}

async function publishSprintPage({ rows }) {
  const meta = deriveDocMeta(rows);
  const section = await findOrCreateSection(meta);
  const pageTitle = meta.title;

  const existing = await findPageByTitleInSpace(pageTitle);
  let lastPreviousApprovals = {};
  let lastDiag = { rowsScanned: 0, rowsMatchedKey: 0, rowsWithApprovalData: 0 };

  function buildHtml(existingFull) {
    const oldBody = existingFull && existingFull.body && existingFull.body.storage && existingFull.body.storage.value;
    const { map, diag } = extractPreviousApprovals(oldBody);
    lastPreviousApprovals = map;
    lastDiag = diag;
    lastDiag.hadOldBody = !!oldBody;
    lastDiag.oldBodyLength = oldBody ? oldBody.length : 0;
    return buildSprintTableHtml(rows, map);
  }

  const { result, wasUpdate } = await createOrUpdatePage(section.id, pageTitle, buildHtml, existing);

  const preservedCount = rows.filter(r => {
    const p = lastPreviousApprovals[r.key];
    return p && (p.approved || p.approvedBy);
  }).length;

  const url = `${CONFLUENCE_BASE}/spaces/${SPACE_KEY}/pages/${result.id}`;
  return {
    url, pageId: result.id, sectionTitle: section.title, sectionCreated: section.created,
    updated: wasUpdate, preservedApprovals: preservedCount, combined: meta.isCombined,
    diag: { existingFoundInitially: !!existing, ...lastDiag },
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { rows } = body;
  if (!Array.isArray(rows) || !rows.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing rows' }) };
  }

  try {
    const result = await publishSprintPage({ rows });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, ...result }) };
  } catch (e) {
    console.error('sprintplanning publish error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
