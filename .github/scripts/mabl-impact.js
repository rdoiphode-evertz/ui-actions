#!/usr/bin/env node

// mabl Impact Check Script
// Handles two event actions:
//   created — staging URL comment posted → match changed files → post checkbox list
//   edited  — reviewer checked a box     → trigger mabl run  → poll → update that line

'use strict';

const fs   = require('fs');
const path = require('path');

const MABL_API_BASE    = 'https://api.mabl.com';
const GITHUB_API_BASE  = 'https://api.github.com';
const COMMENT_MARKER   = '<!-- mabl-impact-check -->';
const PLAN_ID_REGEX    = /<!-- plan:([^>]+) -->/;
const STAGING_REGEX    = /<!-- staging:([\w.-]+) -->/;
const POLL_INTERVAL_MS = 30_000;
const MAX_WAIT_MS      = 35 * 60_000;

const {
  MABL_API_KEY,
  GITHUB_TOKEN,
  PR_NUMBER,
  COMMIT_SHA,
  REPO,
  EVENT_ACTION,
  CHANGED_FILES,
  COMMENT_ID,
} = process.env;

// Comment bodies written by workflow step using toJSON() — parse as JSON strings
const COMMENT_BODY      = JSON.parse(fs.readFileSync('/tmp/comment-body.json', 'utf8')) || '';
const COMMENT_BODY_FROM = JSON.parse(fs.readFileSync('/tmp/comment-body-from.json', 'utf8')) || '';

// ─── Glob matching ────────────────────────────────────────────────────────────

function matchesPattern(filePath, pattern) {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  return new RegExp(`^${regexStr}$`).test(filePath);
}

// ─── mabl API ─────────────────────────────────────────────────────────────────

async function mablRequest(endpoint, options = {}) {
  const res = await fetch(`${MABL_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'x-mabl-api-key': MABL_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`mabl API ${endpoint} → HTTP ${res.status}: ${body}`);
  return JSON.parse(body);
}

async function triggerPlanRun(planId, stagingUrl) {
  return mablRequest('/testing/api/v0/plan-runs', {
    method: 'POST',
    body: JSON.stringify({
      plan_id: planId,
      environment: {
        uri: stagingUrl.startsWith('http') ? stagingUrl : `https://${stagingUrl}`,
      },
    }),
  });
}

async function getPlanRunStatus(runId) {
  return mablRequest(`/testing/api/v0/plan-runs/${runId}`);
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

async function githubRequest(endpoint, options = {}) {
  const res = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${endpoint} → HTTP ${res.status}: ${body}`);
  return body ? JSON.parse(body) : {};
}

async function findExistingComment(owner, repo) {
  const comments = await githubRequest(
    `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments?per_page=100`
  );
  return comments.find(c => c.body && c.body.includes(COMMENT_MARKER)) || null;
}

async function postOrReplaceComment(owner, repo, body) {
  const fullBody = `${body}\n\n${COMMENT_MARKER}`;
  const existing = await findExistingComment(owner, repo);
  if (existing) {
    await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'DELETE',
    });
    console.log(`Deleted old comment #${existing.id}`);
  }
  await githubRequest(`/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: fullBody }),
  });
  console.log('Posted new comment');
}

async function updateComment(owner, repo, commentId, body) {
  await githubRequest(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

// ─── Comment format ───────────────────────────────────────────────────────────

function statusLabel(status, duration) {
  const map = {
    succeeded: '✅ Passed',
    failed:    '❌ Failed',
    running:   '⏳ Running',
    scheduled: '🔄 Scheduled',
    cancelled: '⚫ Cancelled',
    skipped:   '⏭️ Skipped',
    'not-run': '⚪ Not run',
  };
  const label = map[status] || '❓ Unknown';
  if (!duration) return label;
  const s = Math.round(duration / 1000);
  const d = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${label} (${d})`;
}

function buildComment(tests, stagingUrl, shortSha) {
  const direct   = tests.filter(t => t.impact === 'direct');
  const indirect = tests.filter(t => t.impact === 'indirect');

  // Plan ID embedded in hidden HTML comment — invisible in rendered markdown
  const line = (t) =>
    `- [ ] <!-- plan:${t.id} --> ${t.name} · ${statusLabel('not-run')}`;

  const section = (list) =>
    list.length === 0 ? '_None_\n' : list.map(line).join('\n') + '\n';

  const now = new Date().toUTCString();

  return `## mabl Test Impact
<!-- staging:${stagingUrl} -->

**Commit:** \`${shortSha}\` | **Staging:** [${stagingUrl}](https://${stagingUrl})
**Last updated:** ${now}

### 🔴 Directly Impacted
${section(direct)}
### 🟡 Indirectly Impacted
${section(indirect)}
---
_Check a box to trigger that test against the staging URL · [View mapping](.github/mabl-mapping.json)_`;
}

// ─── Checkbox detection ───────────────────────────────────────────────────────

function findCheckedPlan(oldBody, newBody) {
  const oldLines = oldBody.split('\n');
  const newLines = newBody.split('\n');
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const oldLine = oldLines[i] || '';
    const newLine = newLines[i] || '';
    // Detect [ ] → [x] transition on same line
    if (oldLine.includes('- [ ]') && newLine.includes('- [x]')) {
      const match = newLine.match(PLAN_ID_REGEX);
      if (match) return match[1];
    }
  }
  return null;
}

function extractStagingUrl(body) {
  const match = body.match(STAGING_REGEX);
  return match ? match[1] : null;
}

// Replace status text after · on the matching plan line — idempotent
function updateLineStatus(body, planId, status, duration) {
  return body.split('\n').map(line => {
    if (line.includes(`<!-- plan:${planId} -->`)) {
      return line.replace(/· .*$/, `· ${statusLabel(status, duration)}`);
    }
    return line;
  }).join('\n');
}

// ─── Polling ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTerminal(status) {
  return ['succeeded', 'failed', 'cancelled', 'skipped'].includes(status);
}

// ─── Case 1: new staging comment ─────────────────────────────────────────────

async function handleNewStagingComment() {
  const [owner, repo] = REPO.split('/');
  const shortSha = COMMIT_SHA ? COMMIT_SHA.slice(0, 7) : 'unknown';

  const stagingUrl = COMMENT_BODY.match(/[\w.-]+\.staging\.evertz\.tools/)?.[0];
  if (!stagingUrl) throw new Error('No staging URL found in comment');

  console.log(`PR #${PR_NUMBER} | Commit: ${shortSha} | Staging: ${stagingUrl}`);

  const mappingPath = path.join(process.cwd(), '.github', 'mabl-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));

  const changedFiles = CHANGED_FILES
    ? CHANGED_FILES.split(',').map(f => f.trim()).filter(Boolean)
    : [];
  console.log(`Changed files (${changedFiles.length}):`, changedFiles);

  const affectedMap = new Map();
  for (const { pattern, tests } of mapping.mappings) {
    if (!changedFiles.some(f => matchesPattern(f, pattern))) continue;
    for (const test of tests) {
      const existing = affectedMap.get(test.id);
      if (!existing || (test.impact === 'direct' && existing.impact !== 'direct')) {
        affectedMap.set(test.id, { ...test });
      }
    }
  }

  const affectedTests = [...affectedMap.values()];

  if (affectedTests.length === 0) {
    await postOrReplaceComment(owner, repo,
      `## mabl Test Impact\n\n**Commit:** \`${shortSha}\` | **Staging:** [${stagingUrl}](https://${stagingUrl})\n\nNo mabl tests mapped to the changed files.\n\n_[View mapping](.github/mabl-mapping.json)_`
    );
    return;
  }

  console.log(`Affected tests: ${affectedTests.map(t => t.name).join(', ')}`);
  await postOrReplaceComment(owner, repo, buildComment(affectedTests, stagingUrl, shortSha));
  console.log('Comment posted. Reviewer can check a box to trigger a test.');
}

// ─── Case 2: checkbox checked ─────────────────────────────────────────────────

async function handleCheckboxChecked() {
  if (!COMMENT_BODY_FROM) {
    console.log('No previous body — skipping');
    return;
  }

  const planId = findCheckedPlan(COMMENT_BODY_FROM, COMMENT_BODY);
  if (!planId) {
    console.log('No checkbox [ ] → [x] transition found — skipping');
    return;
  }
  console.log(`Checkbox checked for plan: ${planId}`);

  const stagingUrl = extractStagingUrl(COMMENT_BODY);
  if (!stagingUrl) throw new Error('Could not extract staging URL from comment body');

  const [owner, repo] = REPO.split('/');

  if (!MABL_API_KEY) {
    console.warn('MABL_API_KEY not set — marking as failed');
    const body = updateLineStatus(COMMENT_BODY, planId, 'failed');
    await updateComment(owner, repo, COMMENT_ID,
      body + '\n\n> ⚠️ `MABL_API_KEY` secret is not configured'
    );
    return;
  }

  // Show "running" immediately
  let currentBody = updateLineStatus(COMMENT_BODY, planId, 'running');
  await updateComment(owner, repo, COMMENT_ID, currentBody);

  // Trigger mabl run
  let runId;
  try {
    const run = await triggerPlanRun(planId, stagingUrl);
    runId = run.id;
    console.log(`Triggered run ${runId} for plan ${planId}`);
  } catch (err) {
    console.error('Failed to trigger mabl run:', err.message);
    currentBody = updateLineStatus(currentBody, planId, 'failed');
    await updateComment(owner, repo, COMMENT_ID, currentBody);
    return;
  }

  // Poll until terminal or timeout
  const startTime = Date.now();
  let status = 'running';
  let duration = null;

  while (true) {
    if (Date.now() - startTime > MAX_WAIT_MS) {
      console.log('Poll timeout — marking as failed');
      status = 'failed';
      currentBody = updateLineStatus(currentBody, planId, status);
      await updateComment(owner, repo, COMMENT_ID, currentBody);
      break;
    }

    await sleep(POLL_INTERVAL_MS);

    try {
      const run = await getPlanRunStatus(runId);
      status   = run.status;
      duration = run.completion_time ? run.completion_time - run.start_time : null;
      console.log(`Run ${runId}: ${status}`);
    } catch (err) {
      console.warn(`Poll error: ${err.message}`);
    }

    currentBody = updateLineStatus(currentBody, planId, status, duration);
    await updateComment(owner, repo, COMMENT_ID, currentBody);

    if (isTerminal(status)) {
      console.log(`Run complete: ${status}`);
      break;
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!PR_NUMBER) throw new Error('PR_NUMBER is not set');

  if (EVENT_ACTION === 'created') {
    await handleNewStagingComment();
  } else if (EVENT_ACTION === 'edited') {
    await handleCheckboxChecked();
  } else {
    throw new Error(`Unexpected EVENT_ACTION: ${EVENT_ACTION}`);
  }
}

main().catch(err => {
  console.error('mabl impact check failed:', err.message);
  process.exit(1);
});
