#!/usr/bin/env node

// mabl Impact Check Script
// Triggered by GitHub Actions on every PR push.
// Flow:
//   1. Match changed files against .github/mabl-mapping.json
//   2. Post PR comment with affected tests showing ⚪ Not run + ▶ Run buttons
//   Tests only run when a reviewer clicks ▶ Run (handled by Vercel function + mabl-manual-run.yml)

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────

const MABL_API_BASE      = 'https://api.mabl.com';
const MABL_APP_BASE      = 'https://app.mabl.com';
const GITHUB_API_BASE    = 'https://api.github.com';
const COMMENT_MARKER     = '<!-- mabl-impact-check -->';

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
  RUN_BUTTON_BASE_URL, // e.g. https://your-app.vercel.app/api/run — set after Vercel deploy
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

  // Delete old mabl comment if exists, then always create a fresh one
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

// ─── Comment formatting ──────────────────────────────────────────────────────

function statusEmoji(status) {
  const map = {
    succeeded:  '✅',
    failed:     '❌',
    running:    '⏳',
    scheduled:  '🔄',
    cancelled:  '⚫',
    skipped:    '⏭️',
    pending:   '🔄',
    'not-run': '⚪',
  };
  return map[status] || '❓';
}

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function buildComment(tests, stagingUrl, shortSha) {
  const direct   = tests.filter(t => t.impact === 'direct');
  const indirect = tests.filter(t => t.impact === 'indirect');
  const header   = `## mabl Test Impact`;

  const formatRow = (t) => {
    const emoji    = statusEmoji(t.status);
    const label    = t.statusLabel || t.status || 'pending';
    const duration = t.duration ? ` (${formatDuration(t.duration)})` : '';
    // If run completed → link to that run's results
    // If Vercel function configured → show ▶ Run button (triggers new run via Vercel)
    // Otherwise → link to the plan page in mabl UI
    let actionLink;
    if (t.runUrl) {
      actionLink = `[Open Run ↗](${t.runUrl})`;
    } else if (RUN_BUTTON_BASE_URL) {
      const params = new URLSearchParams({
        plan: t.id,
        pr: PR_NUMBER,
        staging_url: STAGING_URL,
        plan_name: t.name,
        commit_sha: COMMIT_SHA || '',
      });
      actionLink = `[▶ Run](${RUN_BUTTON_BASE_URL}?${params})`;
    } else {
      actionLink = `[▶ Run](${mablPlanUrl(t.id)})`;
    }
    return `| ${t.name} | ${emoji} ${label}${duration} | ${actionLink} |`;
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
_Click **▶ Run** to trigger a test against the staging URL · [View mapping config](.github/mabl-mapping.json)_`;
}

// ─── Polling ─────────────────────────────────────────────────────────────────

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!PR_NUMBER)   throw new Error('PR_NUMBER is not set');
  if (!STAGING_URL) throw new Error('STAGING_URL is not set');

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

  // Deduplicate by plan ID — direct impact wins over indirect
  const affectedMap = new Map();

  for (const { pattern, tests } of mapping.mappings) {
    const matches = changedFiles.some(f => matchesPattern(f, pattern));
    if (!matches) continue;

    for (const test of tests) {
      const existing = affectedMap.get(test.id);
      if (!existing || (test.impact === 'direct' && existing.impact !== 'direct')) {
        affectedMap.set(test.id, {
          ...test,
          status:      'not-run',
          statusLabel: 'Not run',
          runId:       null,
          runUrl:      null,
        });
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

  // 3. Post comment — tests show ⚪ Not run with ▶ Run buttons
  await postOrUpdateComment(owner, repo, buildComment(affectedTests, STAGING_URL, shortSha));
  console.log('Comment posted. Tests will run when reviewer clicks ▶ Run.');
}

main().catch(err => {
  console.error('mabl impact check failed:', err.message);
  process.exit(1);
});
