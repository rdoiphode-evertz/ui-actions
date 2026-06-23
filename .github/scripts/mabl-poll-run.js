// mabl Manual Run Poller
// Called by mabl-manual-run.yml after a reviewer clicks "▶ Run" in a PR comment.
// Polls mabl for the run result and posts a follow-up comment on the PR.

'use strict';

const MABL_API_BASE   = 'https://api.mabl.com';
const MABL_APP_BASE   = 'https://app.mabl.com';
const GITHUB_API_BASE = 'https://api.github.com';
const POLL_INTERVAL_MS = 30_000;
const MAX_WAIT_MS      = 35 * 60_000;  // tests can take 15-30 mins
const MANUAL_RUN_MARKER = '<!-- mabl-manual-run -->';

const {
  MABL_API_KEY,
  MABL_WORKSPACE_ID,
  GITHUB_TOKEN,
  REPO,
  PLAN_ID,
  RUN_ID,
  PR_NUMBER,
  PLAN_NAME,
  STAGING_URL,
  COMMIT_SHA,
} = process.env;

// ─── mabl API ───────────────────────────────────────────────────────────────

async function getPlanRunStatus(runId) {
  const res = await fetch(`${MABL_API_BASE}/testing/api/v0/plan-runs/${runId}`, {
    headers: { 'x-mabl-api-key': MABL_API_KEY },
  });
  if (!res.ok) throw new Error(`mabl API → HTTP ${res.status}`);
  return res.json();
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
  if (!res.ok) throw new Error(`GitHub API ${endpoint} → HTTP ${res.status}: ${body}`);
  return body ? JSON.parse(body) : {};
}

async function findExistingManualComment(owner, repo) {
  const comments = await githubRequest(
    `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments?per_page=100`
  );
  // Find a manual run comment for this specific run ID
  return comments.find(c => c.body && c.body.includes(`${MANUAL_RUN_MARKER}${RUN_ID}`)) || null;
}

async function postOrUpdateManualComment(owner, repo, body) {
  const marker = `${MANUAL_RUN_MARKER}${RUN_ID}`;
  const fullBody = `${body}\n\n${marker}`;
  const existing = await findExistingManualComment(owner, repo);

  if (existing) {
    await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: fullBody }),
    });
  } else {
    await githubRequest(`/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: fullBody }),
    });
  }
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function statusEmoji(status) {
  const map = {
    succeeded: '✅',
    failed:    '❌',
    running:   '⏳',
    scheduled: '🔄',
    cancelled: '⚫',
    skipped:   '⏭️',
  };
  return map[status] || '❓';
}

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function buildManualRunComment(status, statusLabel, duration, runUrl, isRunning) {
  const emoji     = statusEmoji(status);
  const shortSha  = COMMIT_SHA ? COMMIT_SHA.slice(0, 7) : 'unknown';
  const now       = new Date().toUTCString();
  const heading   = isRunning ? '⏳ mabl Manual Run — In Progress' : `${emoji} mabl Manual Run — ${statusLabel}`;
  const durationStr = duration ? ` · ${formatDuration(duration)}` : '';

  return `### ${heading}

**Test:** ${PLAN_NAME}
**Commit:** \`${shortSha}\` | **Staging:** [${STAGING_URL}](https://${STAGING_URL})
**Updated:** ${now}${durationStr}

[View Run in mabl ↗](${runUrl})

---
_Manually triggered · [View all impacts](#issuecomment-1)_`;
}

// ─── Polling ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTerminal(status) {
  return ['succeeded', 'failed', 'cancelled', 'skipped'].includes(status);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!MABL_API_KEY)      throw new Error('MABL_API_KEY secret is not set');
  if (!MABL_WORKSPACE_ID) throw new Error('MABL_WORKSPACE_ID secret is not set');
  if (!RUN_ID)            throw new Error('RUN_ID is not set');
  if (!PLAN_ID)           throw new Error('PLAN_ID is not set');
  if (!PR_NUMBER)         throw new Error('PR_NUMBER is not set');

  const [owner, repo] = REPO.split('/');
  const runUrl = `${MABL_APP_BASE}/workspaces/${MABL_WORKSPACE_ID}/plans/${PLAN_ID}/runs/${RUN_ID}`;

  console.log(`Polling run ${RUN_ID} for plan "${PLAN_NAME}" on PR #${PR_NUMBER}`);

  // Post initial "running" comment
  await postOrUpdateManualComment(owner, repo,
    buildManualRunComment('running', 'Running', null, runUrl, true)
  );

  const startTime = Date.now();
  let status = 'running';
  let duration = null;

  while (true) {
    if (Date.now() - startTime > MAX_WAIT_MS) {
      console.log('Timeout — posting partial result');
      status = 'failed';
      break;
    }

    await sleep(POLL_INTERVAL_MS);

    try {
      const run = await getPlanRunStatus(RUN_ID);
      status   = run.status;
      duration = run.completion_time ? run.completion_time - run.start_time : null;
      console.log(`Run ${RUN_ID} status: ${status}`);
    } catch (err) {
      console.warn(`Poll error: ${err.message}`);
    }

    // Update comment with current status
    await postOrUpdateManualComment(owner, repo,
      buildManualRunComment(status, status, duration, runUrl, !isTerminal(status))
    );

    if (isTerminal(status)) {
      console.log(`Run complete: ${status}`);
      break;
    }
  }
}

main().catch(err => {
  console.error('mabl poll run failed:', err.message);
  process.exit(1);
});
