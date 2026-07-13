// netlify/functions/releasenotes.js

const JIRA_BASE        = process.env.JIRA_BASE_URL  || 'https://riversidejira.atlassian.net';
const CONFLUENCE_PAGE_ID = '173182117';
const CONFLUENCE_BASE    = 'https://riversidejira.atlassian.net/wiki';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function getJiraAuth() {
  return Buffer.from(`${(process.env.JIRA_EMAIL||'').trim()}:${(process.env.JIRA_API_TOKEN||'').trim()}`).toString('base64');
}
function getConfluenceAuth() {
  const email = (process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL || '').trim();
  const token = (process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN || '').trim();
  return Buffer.from(`${email}:${token}`).toString('base64');
}
function getFirebaseProjectId() {
  return process.env.FIREBASE_PROJECT_ID || '';
}

async function jiraFetch(path) {
  const res = await fetch(`${JIRA_BASE}${path}`, {
    headers: { Authorization: `Basic ${getJiraAuth()}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
  return res.json();
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

// ── Firebase REST API (no SDK needed) ────────────────────────────────────────
async function firebaseGet(docPath) {
  const projectId = getFirebaseProjectId();
  if (!projectId) return null;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firebase GET ${res.status}`);
  const data = await res.json();
  return data;
}

async function firebasePatch(docPath, fields) {
  const projectId = getFirebaseProjectId();
  if (!projectId) return;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  // Build Firestore field format
  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')  firestoreFields[k] = { stringValue: v };
    if (typeof v === 'number')  firestoreFields[k] = { integerValue: v };
    if (typeof v === 'boolean') firestoreFields[k] = { booleanValue: v };
    if (Array.isArray(v)) {
      firestoreFields[k] = { arrayValue: { values: v.map(item => {
        const obj = {};
        for (const [ik, iv] of Object.entries(item)) {
          if (typeof iv === 'string')  obj[ik] = { stringValue: iv };
          if (typeof iv === 'number')  obj[ik] = { integerValue: iv };
        }
        return { mapValue: { fields: obj } };
      })}};
    }
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: firestoreFields }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn('Firebase PATCH failed:', res.status, text);
  }
}

// Save a published release to Firebase history
async function saveReleaseHistory(entry) {
  // entry: { versionId, versionName, releaseName, releaseDate, jiraUrl, confluenceUrl, publishedAt }
  try {
    // Read existing history
    const doc = await firebaseGet('releaseNotes/history');
    let existing = [];
    if (doc && doc.fields && doc.fields.releases && doc.fields.releases.arrayValue) {
      existing = (doc.fields.releases.arrayValue.values || []).map(v => {
        const f = v.mapValue?.fields || {};
        return {
          versionId:    f.versionId?.stringValue    || '',
          versionName:  f.versionName?.stringValue  || '',
          releaseName:  f.releaseName?.stringValue  || '',
          releaseDate:  f.releaseDate?.stringValue  || '',
          jiraUrl:      f.jiraUrl?.stringValue      || '',
          confluenceUrl:f.confluenceUrl?.stringValue|| '',
          publishedAt:  f.publishedAt?.stringValue  || '',
        };
      });
    }
    // Prepend new entry (most recent first), avoid duplicates by versionId
    existing = existing.filter(e => e.versionId !== entry.versionId);
    existing.unshift(entry);
    // Keep last 50
    existing = existing.slice(0, 50);
    await firebasePatch('releaseNotes/history', { releases: existing });
  } catch(e) {
    console.warn('Could not save release history:', e.message);
  }
}

// Read release history from Firebase
async function getReleaseHistory() {
  try {
    const doc = await firebaseGet('releaseNotes/history');
    if (!doc || !doc.fields || !doc.fields.releases) return [];
    const values = doc.fields.releases.arrayValue?.values || [];
    return values.map(v => {
      const f = v.mapValue?.fields || {};
      return {
        versionId:    f.versionId?.stringValue    || '',
        versionName:  f.versionName?.stringValue  || '',
        releaseName:  f.releaseName?.stringValue  || '',
        releaseDate:  f.releaseDate?.stringValue  || '',
        jiraUrl:      f.jiraUrl?.stringValue      || '',
        confluenceUrl:f.confluenceUrl?.stringValue|| '',
        publishedAt:  f.publishedAt?.stringValue  || '',
      };
    });
  } catch(e) {
    console.warn('Could not load release history:', e.message);
    return [];
  }
}

// Fetch fix versions for a project
async function getVersions(project) {
  const data = await jiraFetch(`/rest/api/3/project/${project}/versions`);
  return data
    .filter(v => !v.archived)
    .sort((a, b) => {
      const da = a.releaseDate || a.userReleaseDate || '';
      const db = b.releaseDate || b.userReleaseDate || '';
      return db.localeCompare(da);
    })
    .map(v => ({
      id:          v.id,
      name:        v.name,
      released:    v.released || false,
      releaseDate: v.releaseDate || v.userReleaseDate || null,
      description: v.description || '',
    }));
}

// Fetch all issues in a fix version
async function getIssues(versionId) {
  const jql = `fixVersion = ${versionId} AND issuetype != Epic ORDER BY issuetype ASC, priority ASC`;
  let startAt = 0, all = [];
  while (true) {
    const data = await jiraFetch(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,status,issuetype,priority,labels,components&maxResults=100&startAt=${startAt}`
    );
    all = all.concat(data.issues || []);
    if (all.length >= (data.total || 0) || !(data.issues || []).length) break;
    startAt += 100;
  }
  return all.map(i => ({
    key:        i.key,
    summary:    (i.fields.summary || '').trim(),
    status:     i.fields.status?.name || 'Unknown',
    type:       i.fields.issuetype?.name || 'Story',
    priority:   i.fields.priority?.name || 'Medium',
    labels:     i.fields.labels || [],
    components: (i.fields.components || []).map(c => c.name),
  }));
}

// Generate release notes via Claude
async function generateNotes(versionName, releaseDate, issues) {
  // Trim to max 80 issues to avoid token limits
  const trimmed = issues.slice(0, 80);
  const issueList = trimmed.map(i =>
    `${i.key}: [${i.type}] ${i.summary} (status: ${i.status})`
  ).join('\n');

  const prompt = `You are a technical writer creating release notes for DataManager, an educational assessment platform used by K-12 schools.

VERSION: ${versionName}
DATE: ${releaseDate || 'TBD'}
ISSUES (${trimmed.length} total):
${issueList}

INSTRUCTIONS:
1. Group issues into categories. Use only categories that have relevant issues:
   - Infrastructure & Configuration Enhancements
   - Performance & Stability Improvements
   - Security Improvements
   - Proctoring Improvements
   - Student Data Improvements
   - Rostering & File Processing Fixes
   - Observability & Diagnostics
   - Modernization & Workflow Enhancements
   - Learnosity & Testing Engine Enhancements
   - Admin & UI Improvements

2. For each issue write ONE clear bullet point sentence:
   - Start with a past-tense verb (Improved, Fixed, Resolved, Updated, Added, Enhanced)
   - Be specific about what changed and why it benefits users
   - End with the Jira key in parentheses: (DM-1234)
   - No internal implementation details
   - Keep under 25 words before the ticket reference

3. Return ONLY valid JSON, no markdown fences, no preamble:
{
  "categories": [
    {
      "name": "Category Name",
      "items": [
        { "key": "DM-1234", "text": "Improved X to Y for better Z (DM-1234)" }
      ]
    }
  ]
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  console.log('Claude response stop_reason:', data.stop_reason, 'content blocks:', data.content?.length);
  const textBlock = (data.content || []).find(b => b.type === 'text');
  const raw = textBlock ? textBlock.text.replace(/```json\n?|\n?```/g, '').trim() : '';
  if (!raw) throw new Error(`Empty response from Claude. stop_reason: ${data.stop_reason}, usage: ${JSON.stringify(data.usage)}`);
  try {
    return JSON.parse(raw);
  } catch(e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse JSON. First 200 chars: ' + raw.slice(0, 200));
  }
}


// Build Confluence HTML for a release section
function buildConfluenceHtml(releaseName, releaseDate, categories, versionId, project) {
  const dateObj = releaseDate ? new Date(releaseDate + 'T12:00:00') : null;
  const dateFormatted = dateObj
    ? dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'TBD';
  const dateISO = releaseDate || '';
  const jiraReleaseUrl = `${JIRA_BASE}/projects/${project}/versions/${versionId}/tab/release-report-all-issues`;

  let html = `<h1>Release ${releaseName} - <time datetime="${dateISO}">${dateFormatted}</time></h1>`;
  html += `<h2>Bugs and Enhancements</h2>`;

  for (const cat of categories) {
    if (!cat.items?.length) continue;
    html += `<h3>${cat.name}</h3><ul>`;
    for (const item of cat.items) {
      html += `<li><p>${item.text}</p></li>`;
    }
    html += `</ul>`;
  }

  // Jira release report embed
  html += `<p></p><div data-type="embed-card" data-layout="wide" data-width="100"><iframe src="${jiraReleaseUrl}"></iframe></div>`;
  html += `<p><a href="${jiraReleaseUrl}">${jiraReleaseUrl}</a></p>`;
  html += `<p></p>`;

  return html;
}

async function getConfluencePage() {
  const data = await confluenceFetch(`/rest/api/content/${CONFLUENCE_PAGE_ID}?expand=body.storage,version`);
  return {
    version: data.version?.number || 1,
    title:   data.title,
    body:    data.body?.storage?.value || '',
  };
}

async function publishToConfluence(newHtml, releaseName, currentVersion, currentBody, pageTitle) {
  const insertAt = currentBody.indexOf('<h1>');
  const intro    = insertAt === -1 ? '' : currentBody.slice(0, insertAt);
  const rest     = insertAt === -1 ? currentBody : currentBody.slice(insertAt);
  const updatedBody = intro + newHtml + rest;

  return confluenceFetch(`/rest/api/content/${CONFLUENCE_PAGE_ID}`, 'PUT', {
    id:      CONFLUENCE_PAGE_ID,
    type:    'page',
    status:  'current',
    title:   pageTitle,
    version: { number: currentVersion + 1, message: `Added release ${releaseName}` },
    body:    { storage: { value: updatedBody, representation: 'storage' } },
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  try {
    if (event.httpMethod === 'GET') {
      const { action, project = 'DM', version } = event.queryStringParameters || {};

      if (action === 'versions') {
        const versions = await getVersions(project);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ versions }) };
      }
      if (action === 'issues' && version) {
        const issues = await getIssues(version);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ issues }) };
      }
      if (action === 'history') {
        const history = await getReleaseHistory();
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ history }) };
      }
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { action } = body;

      if (action === 'generate') {
        const { versionName, releaseDate, issues } = body;
        if (!issues?.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No issues provided' }) };
        const result = await generateNotes(versionName, releaseDate, issues);
        return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
      }

      if (action === 'publish') {
        const { releaseName, releaseDate, categories, versionId, versionName, project = 'DM' } = body;
        if (!releaseName) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'releaseName is required' }) };

        const jiraUrl      = `${JIRA_BASE}/projects/${project}/versions/${versionId}/tab/release-report-all-issues`;
        const confluenceUrl = 'https://riversidejira.atlassian.net/wiki/spaces/LSPMDM/pages/173182117/DataManager+Release+Notes';

        const newHtml = buildConfluenceHtml(releaseName, releaseDate, categories, versionId, project);
        const page    = await getConfluencePage();
        await publishToConfluence(newHtml, releaseName, page.version, page.body, page.title);

        // Save to Firebase history
        await saveReleaseHistory({
          versionId,
          versionName: versionName || '',
          releaseName,
          releaseDate: releaseDate || '',
          jiraUrl,
          confluenceUrl,
          publishedAt: new Date().toISOString(),
        });

        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ success: true, jiraUrl, confluenceUrl }),
        };
      }

      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  } catch (err) {
    console.error('releasenotes error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
