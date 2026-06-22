#!/usr/bin/env node

// mabl Impact Check Script
// Triggered by GitHub Actions on every PR push.
// Flow:
//   1. Match changed files against .github/mabl-mapping.json
//   2. Post "Running..." comment to PR immediately
//   3. Trigger mabl plan runs against the staging URL
//   4. Poll mabl until all runs complete (or timeout)
//   5. Update PR comment with final results + links

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────

const MABL_API_BASE      = 'https://api.mabl.com';
const MABL_APP_BASE      = 'https://app.mabl.com';
const GITHUB_API_BASE    = 'https://api.github.com';
const COMMENT_MARKER     = '<!-- mabl-impact-check -->';
const POLL_INTERVAL_MS   = 30_000;       // poll mabl every 30s
const MAX_WAIT_MS        = 20 * 60_000;  // give up after 20 minutes

const {
  MABL_API_KEY,
  MABL_WORKSPACE_ID,
  GITHUB_TOKEN,
  PR_NUMBER,
  COMMIT_SHA,
  REPO,
  STAGING_URL,
  CHANGED_FILES,
  EVENT_NAME,
} = process.env;

// ─── Glob matching (no external deps) ──────────────────────────────────────

function matchesPattern(filePath, pattern) {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars except * and ?
    .replace(/\*\*/g, '\x00')              // temporarily replace **
    .replace(/\*/g, '[^/]*')               // * matches within one segment
    .replace(/\x00/g, '.*');              // ** matches across segments
  return new RegExp(`^${regexStr}$`).test(filePath);
}

// ─── mabl API ───────────────────────────────────────────────────────────────

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
  if (!res.ok) {
    throw new Error(`mabl API ${endpoint} → HTTP ${res.status}: ${body}`);
  }
  return JSON.parse(body);
}

async function triggerPlanRun(planId, stagingUrl) {
  console.log(`Triggering plan run: ${planId} against ${stagingUrl}`);
  return mablRequest('/testing/api/v0/plan-runs', {
    method: 'POST',
    body: JSON.stringify({
      plan_id: planId,
      environment: {
        uri: `https://${stagingUrl}`,
      },
    }),
  });
}

async function getPlanRunStatus(runId) {
  return mablRequest(`/testing/api/v0/plan-runs/${runId}`);
}

function mablPlanUrl(planId) {
  return `${MABL_APP_BASE}/workspaces/${MABL_WORKSPACE_ID}/plans/${planId}`;
}

function mablRunUrl(planId, runId) {
  return `${MABL_APP_BASE}/workspaces/${MABL_WORKSPACE_ID}/plans/${planId}/runs/${runId}`;
}

// ─── GitHub API ─────────────────────────────────────────────────────────────

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
  if (!res.ok) {
    throw new Error(`GitHub API ${endpoint} → HTTP ${res.status}: ${body}`);
  }
  return body ? JSON.parse(body) : {};
}

async function findExistingComment(owner, repo) {
  // GitHub paginates at 100 — for most PRs one page is enough
  const comments = await githubRequest(
    `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments?per_page=100`
  );
  return comments.find(c => c.body && c.body.includes(COMMENT_MARKER)) || null;
}

async function postOrUpdateComment(owner, repo, body) {
  const fullBody = `${body}\n\n${COMMENT_MARKER}`;
  const existing = await findExistingComment(owner, repo);

  if (existing) {
    await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: fullBody }),
    });
    console.log(`Updated comment #${existing.id}`);
  } else {
    await githubRequest(`/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: fullBody }),
    });
    console.log('Posted new comment');
  }
}

// ─── Comment formatting ──────────────────────────────────────────────────────

function statusEmoji(status) {
  const map = {
    succeeded:  '✅',
    failed:     '❌',
    running:    '⏳',
    scheduled:  '🔄',
    cancelled:  '⚫',
    skipped:    '⏭️',
    pending:     '🔄',
    'no-api-key': '⚠️',
  };
  return map[status] || '❓';
}

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function buildComment(tests, stagingUrl, shortSha, isRunning) {
  const direct   = tests.filter(t => t.impact === 'direct');
  const indirect = tests.filter(t => t.impact === 'indirect');

  const header = isRunning
    ? `## ⏳ mabl Tests Running...`
    : `## mabl Test Impact`;

  const formatRow = (t) => {
    const emoji    = statusEmoji(t.status);
    const label    = t.statusLabel || t.status || 'pending';
    const duration = t.duration ? ` (${formatDuration(t.duration)})` : '';
    // Run URL: if we have a real run ID, link directly to that run; else link to the plan page
    const runLink  = t.runUrl
      ? `[Open Run ↗](${t.runUrl})`
      : `[Open Plan ↗](${mablPlanUrl(t.id)})`;
    return `| ${t.name} | ${emoji} ${label}${duration} | ${runLink} |`;
  };

  const table = (list) => {
    if (list.length === 0) return '_None_\n';
    return [
      '| Test Plan | Status | Action |',
      '|-----------|--------|--------|',
      ...list.map(formatRow),
    ].join('\n') + '\n';
  };

  const now = new Date().toUTCString();

  return `${header}

**Commit:** \`${shortSha}\` | **Staging:** [${stagingUrl}](https://${stagingUrl})
**Last updated:** ${now}

### 🔴 Directly Impacted
${table(direct)}
### 🟡 Indirectly Impacted
${table(indirect)}
---
_Auto-generated on every push · [View mapping config](.github/mabl-mapping.json)_`;
}

// ─── Polling ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTerminal(status) {
  return ['succeeded', 'failed', 'cancelled', 'skipped'].includes(status);
}

async function pollUntilComplete(tests, owner, repo, shortSha) {
  const startTime = Date.now();

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > MAX_WAIT_MS) {
      console.log('Timeout reached — posting partial results');
      break;
    }

    // Check status of all runs
    let allDone = true;
    for (const test of tests) {
      if (!test.runId || isTerminal(test.status)) continue;

      try {
        const run = await getPlanRunStatus(test.runId);
        test.status      = run.status;
        test.statusLabel = run.status;
        test.duration    = run.completion_time
          ? run.completion_time - run.start_time
          : null;
        test.runUrl      = mablRunUrl(test.id, test.runId);
      } catch (err) {
        console.warn(`Could not fetch run status for ${test.name}: ${err.message}`);
      }

      if (!isTerminal(test.status)) allDone = false;
    }

    // Update comment with current state
    await postOrUpdateComment(
      owner, repo,
      buildComment(tests, STAGING_URL, shortSha, !allDone)
    );

    if (allDone) {
      console.log('All runs complete');
      break;
    }

    console.log(`Still running — waiting ${POLL_INTERVAL_MS / 1000}s...`);
    await sleep(POLL_INTERVAL_MS);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!PR_NUMBER)   throw new Error('PR_NUMBER is not set');
  if (!STAGING_URL) throw new Error('STAGING_URL is not set');

  const apiKeyMissing = !MABL_API_KEY || !MABL_WORKSPACE_ID;
  if (apiKeyMissing) {
    console.warn('MABL_API_KEY or MABL_WORKSPACE_ID not set — running in preview mode (no tests will be triggered)');
  }

  const [owner, repo] = REPO.split('/');
  const shortSha = COMMIT_SHA ? COMMIT_SHA.slice(0, 7) : 'unknown';

  console.log(`PR: #${PR_NUMBER} | Commit: ${shortSha} | Staging: ${STAGING_URL}`);

  // 1. Load mapping
  const mappingPath = path.join(process.cwd(), '.github', 'mabl-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));

  // 2. Match changed files → affected tests
  const changedFiles = CHANGED_FILES
    ? CHANGED_FILES.split(',').map(f => f.trim()).filter(Boolean)
    : [];

  console.log(`Changed files (${changedFiles.length}):`, changedFiles);

  // Collect affected tests, deduplicating by plan ID.
  // If the same plan appears as both direct and indirect, direct wins.
  const affectedMap = new Map();

  for (const { pattern, tests } of mapping.mappings) {
    const matches = changedFiles.some(f => matchesPattern(f, pattern));
    if (!matches) continue;

    for (const test of tests) {
      const existing = affectedMap.get(test.id);
      if (!existing || (test.impact === 'direct' && existing.impact !== 'direct')) {
        affectedMap.set(test.id, { ...test, status: 'pending', statusLabel: 'Pending', runId: null, runUrl: null });
      }
    }
  }

  const affectedTests = [...affectedMap.values()];

  if (affectedTests.length === 0) {
    console.log('No affected mabl tests found for this change');
    await postOrUpdateComment(owner, repo,
      `## mabl Test Impact\n\n` +
      `**Commit:** \`${shortSha}\` | **Staging:** [${STAGING_URL}](https://${STAGING_URL})\n\n` +
      `No mabl tests are mapped to the files changed in this PR.\n\n` +
      `_[View mapping config](.github/mabl-mapping.json)_`
    );
    return;
  }

  console.log(`Affected tests: ${affectedTests.map(t => t.name).join(', ')}`);

  // 3. Post initial "Running..." comment immediately
  await postOrUpdateComment(
    owner, repo,
    buildComment(affectedTests, STAGING_URL, shortSha, true)
  );

  // 4. Trigger mabl runs (skip if API key not configured)
  if (apiKeyMissing) {
    for (const test of affectedTests) {
      test.status      = 'no-api-key';
      test.statusLabel = '⚠️ API key not configured';
    }
    await postOrUpdateComment(owner, repo, buildComment(affectedTests, STAGING_URL, shortSha, false));
    console.log('Preview mode — comment posted with affected tests. Add MABL_API_KEY secret to enable test triggering.');
    return;
  }

  for (const test of affectedTests) {
    try {
      const run = await triggerPlanRun(test.id, STAGING_URL);
      test.runId       = run.id;
      test.status      = run.status || 'scheduled';
      test.statusLabel = test.status;
      test.runUrl      = mablRunUrl(test.id, run.id);
      console.log(`Triggered run ${run.id} for "${test.name}"`);
    } catch (err) {
      console.error(`Failed to trigger run for "${test.name}": ${err.message}`);
      test.status      = 'failed';
      test.statusLabel = 'Trigger failed';
    }
  }

  // 5. Poll until all done, updating the comment each cycle
  await pollUntilComplete(affectedTests, owner, repo, shortSha);
}

main().catch(err => {
  console.error('mabl impact check failed:', err.message);
  process.exit(1);
});
