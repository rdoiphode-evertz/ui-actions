#!/usr/bin/env node

// =============================================================================
// mabl Impact Check Script
// =============================================================================
// Purpose:
//   Automatically detects which mabl tests are affected by a PR's file changes
//   and posts a checklist comment on the PR. Reviewers check a box to trigger
//   a specific test run against the staging environment.
//
// This script handles TWO event types (both routed through the same workflow):
//
//   EVENT_ACTION = 'created'
//     Fires when someone posts a staging URL comment on the PR.
//     → Reads changed files → matches against mabl-mapping.json
//     → Posts a fresh checkbox comment showing affected tests
//
//   EVENT_ACTION = 'edited'
//     Fires when a reviewer checks a checkbox in the mabl comment.
//     GitHub automatically edits the comment ([ ] → [x]) which fires this event.
//     → Detects which checkbox was checked → triggers that mabl test run
//     → Polls mabl every 30s → updates that line with live status
// =============================================================================

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────

// Base URL for all mabl REST API calls
const MABL_API_BASE    = 'https://api.mabl.com';

// Base URL for all GitHub REST API calls
const GITHUB_API_BASE  = 'https://api.github.com';

// Hidden HTML marker appended to every mabl comment we post.
// Used to identify our comment when searching through PR comments.
// Invisible in rendered GitHub markdown.
const COMMENT_MARKER   = '<!-- mabl-impact-check -->';

// Regex to extract plan ID from the hidden marker embedded in each checkbox line.
// Each line looks like: - [ ] <!-- plan:mock-plan-001 --> Test Name · ⚪ Not run
const PLAN_ID_REGEX    = /<!-- plan:([^>]+) -->/;

// Regex to extract staging URL from the hidden marker at the top of the mabl comment.
// Embedded when comment is first created so checkbox clicks always know which URL to test.
const STAGING_REGEX    = /<!-- staging:([\w.-]+) -->/;

// How often to poll mabl for run status after a test is triggered (30 seconds)
const POLL_INTERVAL_MS = 30_000;

// Maximum time to wait for a mabl run before giving up (35 minutes).
// mabl tests typically take 15–30 minutes. Workflow timeout is set to 45 minutes.
const MAX_WAIT_MS      = 35 * 60_000;

// ─── Environment variables (injected by the workflow) ─────────────────────────

const {
  MABL_API_KEY,   // mabl CI/CD API key — stored in GitHub Secrets
  GITHUB_TOKEN,   // GitHub token — auto-provided by Actions, used to post/edit comments
  PR_NUMBER,      // PR number (e.g. "4") — used in GitHub API paths
  COMMIT_SHA,     // Full SHA of the commit that triggered this run
  REPO,           // "owner/repo" format, e.g. "rdoiphode-evertz/ui-actions"
  EVENT_ACTION,   // "created" or "edited" — determines which handler to run
  CHANGED_FILES,  // Comma-separated list of files changed in this PR
  COMMENT_ID,     // ID of the comment that was edited (only set for 'edited' events)
} = process.env;

// Comment bodies are written to temp files by the workflow step using toJSON()
// so that special characters (backticks, $, newlines) are safely preserved.
// COMMENT_BODY      = current body of the comment (after checkbox check for 'edited')
// COMMENT_BODY_FROM = body before the edit (only present for 'edited' events)
const COMMENT_BODY      = JSON.parse(fs.readFileSync('/tmp/comment-body.json', 'utf8')) || '';
const COMMENT_BODY_FROM = JSON.parse(fs.readFileSync('/tmp/comment-body-from.json', 'utf8')) || '';

// ─── Glob pattern matching ────────────────────────────────────────────────────
// Converts glob patterns from mabl-mapping.json into regex and tests file paths.
// Supports:
//   *  → matches any characters within a single path segment (not /)
//   ** → matches any characters including path separators (across folders)
// Example: "src/components/**" matches "src/components/browse/player.ts"

function matchesPattern(filePath, pattern) {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape all regex special chars except * ?
    .replace(/\*\*/g, '\x00')              // temporarily replace ** with a placeholder
    .replace(/\*/g, '[^/]*')               // single * matches anything except /
    .replace(/\x00/g, '.*');               // ** matches everything including /
  return new RegExp(`^${regexStr}$`).test(filePath);
}

// ─── mabl API helpers ─────────────────────────────────────────────────────────

// Generic mabl API request wrapper.
// Automatically attaches the API key header required by all mabl endpoints.
// Logs each request method, endpoint, and HTTP status to Actions console.
async function mablRequest(endpoint, options = {}) {
  const method = options.method || 'GET';
  const res = await fetch(`${MABL_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'x-mabl-api-key': MABL_API_KEY, // mabl auth: API key in custom header
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.text();
  console.log(`[mabl] ${method} ${endpoint} → ${res.status} ${res.ok ? 'OK' : 'FAILED'}`);
  if (!res.ok) throw new Error(`mabl API ${endpoint} → HTTP ${res.status}: ${body}`);
  return JSON.parse(body);
}

// Triggers a new mabl plan run against a specific staging URL.
//
// API: POST https://api.mabl.com/testing/api/v0/plan-runs
//
// Request body:
//   plan_id     — ID of the mabl test plan to execute (from mabl-mapping.json)
//   environment.uri — the staging URL to run the tests against
//
// Response: { id: "run-xyz", status: "scheduled", ... }
//   The returned `id` is used to poll for run status.
async function triggerPlanRun(planId, stagingUrl) {
  return mablRequest('/testing/api/v0/plan-runs', {
    method: 'POST',
    body: JSON.stringify({
      plan_id: planId,
      environment: {
        // Ensure URL has https:// prefix — mabl requires a full URI
        uri: stagingUrl.startsWith('http') ? stagingUrl : `https://${stagingUrl}`,
      },
    }),
  });
}

// Fetches the current status of an in-progress or completed mabl run.
//
// API: GET https://api.mabl.com/testing/api/v0/plan-runs/{runId}
//
// Response: { id, status, start_time, completion_time, ... }
//   status values: "scheduled" | "running" | "succeeded" | "failed" | "cancelled" | "skipped"
//   completion_time - start_time = total run duration in milliseconds
async function getPlanRunStatus(runId) {
  return mablRequest(`/testing/api/v0/plan-runs/${runId}`);
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

// Generic GitHub API request wrapper.
// Attaches Bearer token auth and required GitHub API version header.
// Logs each request method, endpoint, and HTTP status to Actions console.
async function githubRequest(endpoint, options = {}) {
  const method = options.method || 'GET';
  const res = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,      // GitHub auth token
      'Accept': 'application/vnd.github+json',         // required GitHub API media type
      'X-GitHub-Api-Version': '2022-11-28',            // pin to stable API version
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.text();
  console.log(`[github] ${method} ${endpoint} → ${res.status} ${res.ok ? 'OK' : 'FAILED'}`);
  if (!res.ok) throw new Error(`GitHub API ${endpoint} → HTTP ${res.status}: ${body}`);
  return body ? JSON.parse(body) : {};
}

// Searches all PR comments for ALL existing mabl impact comments.
// Identified by the hidden COMMENT_MARKER string (<!-- mabl-impact-check -->).
// Returns all matches (there may be multiple from previous staging URL posts).
//
// API: GET /repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100
async function findAllMablComments(owner, repo) {
  const comments = await githubRequest(
    `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments?per_page=100`
  );
  return comments.filter(c => c.body && c.body.includes(COMMENT_MARKER));
}

// Minimizes a comment via the GitHub GraphQL API so it collapses with a
// "Show comment" button — same behaviour as outdated review suggestions.
// Uses the OUTDATED classifier since the old mabl comment is superseded by
// the new one posted for the latest staging URL.
//
// API: POST https://api.github.com/graphql  (minimizeComment mutation)
// Requires comment.node_id (the GraphQL global node ID, not the REST integer id).
async function minimizeComment(nodeId) {
  const mutation = `
    mutation($id: ID!) {
      minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
        minimizedComment { isMinimized }
      }
    }
  `;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: mutation, variables: { id: nodeId } }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`GraphQL minimizeComment error: ${JSON.stringify(data.errors)}`);
  console.log(`Minimized comment node ${nodeId}`);
}

// Minimizes all existing mabl comments (if any) then posts a fresh new one.
// Every new staging URL comment causes the previous mabl comment to collapse
// with "Show comment" — the latest is always open at the bottom of the PR.
//
// APIs used:
//   GET     /repos/{owner}/{repo}/issues/{pr_number}/comments  — find old comments
//   GraphQL minimizeComment mutation                           — collapse old comments
//   POST    /repos/{owner}/{repo}/issues/{pr_number}/comments  — create new comment
async function postOrReplaceComment(owner, repo, body) {
  // Append hidden marker so we can find this comment in future runs
  const fullBody = `${body}\n\n${COMMENT_MARKER}`;

  // Minimize all previous mabl comments so they collapse (not deleted — still viewable).
  // Best-effort: if minimize fails (permissions, rate limit, etc.) we log and continue
  // so the new comment is always posted regardless.
  const existing = await findAllMablComments(owner, repo);
  for (const comment of existing) {
    try {
      await minimizeComment(comment.node_id);
      console.log(`Minimized old comment #${comment.id}`);
    } catch (err) {
      console.warn(`Could not minimize comment #${comment.id}: ${err.message}`);
    }
  }

  // Post a fresh comment — appears open at the bottom of the PR
  await githubRequest(`/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: fullBody }),
  });
  console.log('Posted new comment');
}

// Updates an existing comment in-place (used during polling to update test status).
// Only updates the specific line that changed — rest of the comment stays intact.
//
// API: PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}
// Note: This edit is made by github-actions[bot], so sender.type = 'Bot',
//       which prevents the infinite loop (workflow condition ignores bot edits).
async function updateComment(owner, repo, commentId, body) {
  await githubRequest(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

// Fetches the current live body of a comment from GitHub API.
// Used before every write to avoid the race condition where concurrent checkbox
// runs overwrite each other's status updates. Each run only modifies its own
// plan line — by re-fetching first, all other lines are always preserved.
//
// API: GET /repos/{owner}/{repo}/issues/comments/{comment_id}
async function getCommentBody(owner, repo, commentId) {
  const comment = await githubRequest(`/repos/${owner}/${repo}/issues/comments/${commentId}`);
  return comment.body;
}

// Writes a status update for a single plan line and verifies the write stuck.
//
// Problem: when multiple checkbox runs complete at the same time, they all
// re-fetch the comment body within the same millisecond window (before any of
// them has written). They all get the same snapshot and overwrite each other.
//
// Solution: after writing, wait briefly then re-fetch and check that our line
// still shows the expected status. If another run overwrote it, retry with a
// random jitter delay so concurrent runs desynchronize and stop colliding.
// After MAX_WRITE_ATTEMPTS we give up (all retries logged to Actions console).
const MAX_WRITE_ATTEMPTS = 5;

async function writeLineStatus(owner, repo, commentId, planId, status, duration) {
  const expectedLabel = statusLabel(status, duration);

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Random jitter (0–2s) + linear backoff so concurrent runs desynchronize
      const jitter = Math.floor(Math.random() * 2000);
      const delay  = 1000 * attempt + jitter;
      console.log(`writeLineStatus retry ${attempt}/${MAX_WRITE_ATTEMPTS - 1}: waiting ${delay}ms`);
      await sleep(delay);
    }

    // Re-fetch live body so we never overwrite another run's line
    const liveBody    = await getCommentBody(owner, repo, commentId);
    const updatedBody = updateLineStatus(liveBody, planId, status, duration);
    await updateComment(owner, repo, commentId, updatedBody);

    // Brief pause to let GitHub persist the write before we verify
    await sleep(500);

    // Confirm our line shows the expected status
    const checkBody = await getCommentBody(owner, repo, commentId);
    const ourLine   = checkBody.split('\n').find(l => l.includes(`<!-- plan:${planId} -->`));
    if (ourLine && ourLine.includes(expectedLabel)) {
      if (attempt > 0) console.log(`writeLineStatus confirmed on attempt ${attempt + 1}`);
      return;
    }

    console.log(`writeLineStatus attempt ${attempt + 1}: our write was overwritten, retrying...`);
  }

  console.warn(`writeLineStatus: could not confirm status "${status}" for plan ${planId} after ${MAX_WRITE_ATTEMPTS} attempts`);
}

// ─── Comment formatting ───────────────────────────────────────────────────────

// Maps mabl run status values to human-readable labels with emoji.
// Optionally appends formatted duration (e.g. "2m 14s") when run completes.
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

// Builds the full mabl impact comment body with checkbox list.
// Each test gets one checkbox line with a hidden plan ID marker.
// Tests are split into "Directly Impacted" and "Indirectly Impacted" sections.
//
// Hidden markers embedded in the comment (invisible in rendered markdown):
//   <!-- staging:abc123.eio-ops.staging.evertz.tools --> at top — for checkbox trigger
//   <!-- plan:mock-plan-001 --> on each line — to identify which plan was checked
//   <!-- mabl-impact-check --> at bottom — to find this comment in future runs
// lastStatuses is an optional map of { planId: statusText } extracted from the
// previous mabl comment. When provided, each test line shows the last known
// terminal status instead of ⚪ Not run — giving reviewers instant context on
// what passed/failed on the previous staging URL without re-running everything.
function buildComment(tests, stagingUrl, shortSha, lastStatuses = {}) {
  const direct   = tests.filter(t => t.impact === 'direct');
  const indirect = tests.filter(t => t.impact === 'indirect');

  // Each checkbox line embeds the plan ID invisibly so we can detect which was clicked.
  // If a last-run status exists for this plan, show it (with a "previous" label)
  // so reviewers know it hasn't been run on this staging URL yet.
  const line = (t) => {
    const last = lastStatuses[t.id];
    const display = last ? `${last} _(previous)_` : statusLabel('not-run');
    return `- [ ] <!-- plan:${t.id} --> ${t.name} · ${display}`;
  };

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

// Compares the comment body before and after a checkbox click to find which
// plan was just checked. GitHub edits the comment changing "- [ ]" to "- [x]".
//
// Strategy: compare old and new bodies line by line, find the line that changed
// from unchecked to checked, then extract the plan ID from the hidden HTML comment.
//
// Returns the plan ID string (e.g. "mock-plan-001"), or null if no change found.
function findCheckedPlan(oldBody, newBody) {
  const oldLines = oldBody.split('\n');
  const newLines = newBody.split('\n');
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const oldLine = oldLines[i] || '';
    const newLine = newLines[i] || '';
    // Detect the exact [ ] → [x] transition on this line
    if (oldLine.includes('- [ ]') && newLine.includes('- [x]')) {
      const match = newLine.match(PLAN_ID_REGEX);
      if (match) return match[1];
    }
  }
  return null;
}

// Extracts the staging URL from the hidden marker embedded at the top of
// the mabl comment. This is always the URL from the latest staging comment
// since the comment is fully replaced on every new staging URL.
function extractStagingUrl(body) {
  const match = body.match(STAGING_REGEX);
  return match ? match[1] : null;
}

// Updates the status text on a specific plan's checkbox line.
// Replaces everything after the · separator on that line.
// This is idempotent — running it twice on the same line produces the same result.
//
// Example:
//   Before: - [x] <!-- plan:mock-plan-001 --> Browse Player · ⚪ Not run
//   After:  - [x] <!-- plan:mock-plan-001 --> Browse Player · ⏳ Running
function updateLineStatus(body, planId, status, duration) {
  return body.split('\n').map(line => {
    if (line.includes(`<!-- plan:${planId} -->`)) {
      // Replace everything from · to end of line with new status
      return line.replace(/· .*$/, `· ${statusLabel(status, duration)}`);
    }
    return line;
  }).join('\n');
}

// Parses an existing mabl comment body and returns the last known terminal
// status text per plan ID. Used to pre-populate the new comment when a fresh
// staging URL is posted — reviewers see what passed/failed last time without
// having to re-run everything.
//
// Only terminal statuses are preserved (✅ Passed, ❌ Failed, ⚫ Cancelled,
// ⏭️ Skipped). Transient statuses (⏳ Running, 🔄 Scheduled) and ⚪ Not run
// are discarded — those runs are no longer active on the new staging URL.
//
// Returns: { planId: statusText } e.g. { 'mock-plan-001': '❌ Failed' }
function extractLastStatuses(body) {
  if (!body) return {};
  const statuses = {};
  const TRANSIENT_PREFIXES = ['⏳', '🔄', '⚪'];
  for (const line of body.split('\n')) {
    const planMatch  = line.match(PLAN_ID_REGEX);
    const statusMatch = line.match(/· (.+)$/);
    if (!planMatch || !statusMatch) continue;
    // Strip the _(previous)_ suffix added by buildComment so it doesn't compound
    // on successive staging URL refreshes (e.g. "❌ Failed _(previous)_ _(previous)_")
    const statusText = statusMatch[1].trim().replace(/ _\(previous\)_$/, '');
    const isTransient = TRANSIENT_PREFIXES.some(p => statusText.startsWith(p));
    if (!isTransient) {
      statuses[planMatch[1]] = statusText;
    }
  }
  return statuses;
}

// ─── Polling helpers ──────────────────────────────────────────────────────────

// Simple promise-based sleep used between poll intervals
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns true if the mabl run has reached a final state (no more polling needed)
function isTerminal(status) {
  return ['succeeded', 'failed', 'cancelled', 'skipped'].includes(status);
}

// ─── Handler: new staging URL comment ────────────────────────────────────────
// Triggered when: EVENT_ACTION = 'created' and comment contains staging URL
//
// Flow:
//   1. Extract staging URL from the comment body
//   2. Load mabl-mapping.json to get file pattern → test plan mappings
//   3. Match PR's changed files against each pattern using glob matching
//   4. Deduplicate matched tests (direct impact wins over indirect)
//   5. Delete old mabl comment (if any) and post a fresh checkbox comment
async function handleNewStagingComment() {
  const [owner, repo] = REPO.split('/');
  const shortSha = COMMIT_SHA ? COMMIT_SHA.slice(0, 7) : 'unknown';

  // Extract the first URL from the comment — accepts any format (no domain restriction).
  const urlMatch = COMMENT_BODY.match(/https?:\/\/[\w.-]+(?::\d+)?(?:\/[\S]*)?|[\w.-]+\.[\w]{2,}(?:\/[\S]*)?/);
  if (!urlMatch) {
    console.log('No URL found in comment — skipping');
    return;
  }
  const stagingUrl = urlMatch[0].replace(/^https?:\/\//, '');

  console.log(`PR #${PR_NUMBER} | Commit: ${shortSha} | Staging: ${stagingUrl}`);

  // Load the file-to-test mapping from the repo
  // Format: { mappings: [{ pattern: "src/**", tests: [{ id, name, impact }] }] }
  const mappingPath = path.join(process.cwd(), '.github', 'mabl-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));

  // Parse the comma-separated changed files list (provided by the workflow via gh api)
  const changedFiles = CHANGED_FILES
    ? CHANGED_FILES.split(',').map(f => f.trim()).filter(Boolean)
    : [];
  console.log(`Changed files (${changedFiles.length}):`, changedFiles);

  // Match changed files against each mapping pattern and collect affected tests.
  // Use a Map keyed by plan ID to deduplicate — if same test appears in multiple
  // patterns, "direct" impact takes priority over "indirect".
  const affectedMap = new Map();
  for (const { pattern, tests } of mapping.mappings) {
    // Skip this pattern if none of the changed files match it
    if (!changedFiles.some(f => matchesPattern(f, pattern))) continue;
    for (const test of tests) {
      const existing = affectedMap.get(test.id);
      // Add test if not seen yet, or upgrade from indirect → direct if applicable
      if (!existing || (test.impact === 'direct' && existing.impact !== 'direct')) {
        affectedMap.set(test.id, { ...test });
      }
    }
  }

  const affectedTests = [...affectedMap.values()];

  // If no tests matched, post a simple "no tests" comment and exit
  if (affectedTests.length === 0) {
    await postOrReplaceComment(owner, repo,
      `## mabl Test Impact\n\n**Commit:** \`${shortSha}\` | **Staging:** [${stagingUrl}](https://${stagingUrl})\n\nNo mabl tests mapped to the changed files.\n\n_[View mapping](.github/mabl-mapping.json)_`
    );
    return;
  }

  console.log(`Affected tests: ${affectedTests.map(t => t.name).join(', ')}`);

  // Extract last known statuses from the most recent mabl comment (if any).
  // These are passed to buildComment so tests that already have a terminal result
  // (Passed/Failed) from a previous staging URL are shown with that status rather
  // than ⚪ Not run — saving reviewers from re-running tests they don't need to.
  const previousComments = await findAllMablComments(owner, repo);
  const lastBody = previousComments.length > 0
    ? previousComments[previousComments.length - 1].body
    : null;
  const lastStatuses = extractLastStatuses(lastBody);
  if (Object.keys(lastStatuses).length > 0) {
    console.log('Carrying over last statuses:', JSON.stringify(lastStatuses));
  }

  await postOrReplaceComment(owner, repo, buildComment(affectedTests, stagingUrl, shortSha, lastStatuses));
  console.log('Comment posted. Reviewer can check a box to trigger a test.');
}

// ─── Handler: checkbox checked ────────────────────────────────────────────────
// Triggered when: EVENT_ACTION = 'edited' and the edited comment is our mabl comment
// (identified by 'mabl-impact-check' marker in the condition)
//
// Flow:
//   1. Diff old vs new comment body to find which checkbox was just checked
//   2. Extract the staging URL from the hidden marker in the comment
//   3. Guard: if MABL_API_KEY not set, mark as failed and exit early
//   4. Immediately update that line to show ⏳ Running
//   5. Call mabl API to start the test run against the staging URL
//   6. Poll mabl every 30 seconds for run status
//   7. Update the checkbox line after each poll with current status
//   8. Stop when run reaches a terminal state or 35-minute timeout
async function handleCheckboxChecked() {
  // COMMENT_BODY_FROM is the comment body BEFORE the checkbox was checked.
  // Without it we can't detect which box changed.
  if (!COMMENT_BODY_FROM) {
    console.log('No previous body — skipping');
    return;
  }

  // Find which plan ID was just checked by comparing old and new comment bodies
  const planId = findCheckedPlan(COMMENT_BODY_FROM, COMMENT_BODY);
  if (!planId) {
    console.log('No checkbox [ ] → [x] transition found — skipping');
    return;
  }
  console.log(`Checkbox checked for plan: ${planId}`);

  // Get the staging URL that was embedded when this comment was originally created
  const stagingUrl = extractStagingUrl(COMMENT_BODY);
  if (!stagingUrl) throw new Error('Could not extract staging URL from comment body');

  const [owner, repo] = REPO.split('/');

  // Step 1: Immediately show ⏳ Running on the checked line so reviewer gets
  // instant feedback that their click was registered.
  // writeLineStatus re-fetches live body, writes, then verifies the write stuck —
  // retrying with jitter if a concurrent run overwrote it.
  await writeLineStatus(owner, repo, COMMENT_ID, planId, 'running');

  // Step 2: Trigger the mabl test run
  // POST https://api.mabl.com/testing/api/v0/plan-runs
  // Body: { plan_id, environment: { uri: staging URL } }
  // Response: { id: runId, status: "scheduled" }
  let runId;
  try {
    console.log(`Triggering mabl run — plan: ${planId} | staging: https://${stagingUrl}`);
    const run = await triggerPlanRun(planId, stagingUrl);
    runId = run.id;
    console.log(`Triggered run ${runId} for plan ${planId}`);
  } catch (err) {
    console.error('Failed to trigger mabl run:', err.message);
    await writeLineStatus(owner, repo, COMMENT_ID, planId, 'failed');
    return;
  }

  // Step 3: Poll mabl every 30 seconds until the run finishes or times out
  // GET https://api.mabl.com/testing/api/v0/plan-runs/{runId}
  // Updates the PR comment line after each poll so reviewer sees live progress
  const startTime = Date.now();
  let status = 'running';
  let duration = null;

  while (true) {
    // Safety timeout: give up after 35 minutes (workflow itself times out at 45 min)
    if (Date.now() - startTime > MAX_WAIT_MS) {
      console.log('Poll timeout — marking as failed');
      await writeLineStatus(owner, repo, COMMENT_ID, planId, 'failed');
      break;
    }

    // Wait 30 seconds before next poll
    await sleep(POLL_INTERVAL_MS);

    // Fetch current run status from mabl
    try {
      const run = await getPlanRunStatus(runId);
      status   = run.status;
      // Calculate duration only once run has a completion_time
      duration = run.completion_time ? run.completion_time - run.start_time : null;
      console.log(`Run ${runId}: ${status}`);
    } catch (err) {
      // Log poll errors but keep trying — transient network issues shouldn't fail the run
      console.warn(`Poll error: ${err.message}`);
    }

    // Write status using retry+verify so concurrent runs don't overwrite each other
    await writeLineStatus(owner, repo, COMMENT_ID, planId, status, duration);

    // Stop polling when run reaches a final state
    if (isTerminal(status)) {
      console.log(`Run complete: ${status}`);
      break;
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
// Routes to the correct handler based on which GitHub event triggered the workflow

async function main() {
  if (!PR_NUMBER) throw new Error('PR_NUMBER is not set');

  if (EVENT_ACTION === 'created') {
    // Staging URL was posted — show affected test list with checkboxes
    await handleNewStagingComment();
  } else if (EVENT_ACTION === 'edited') {
    // A checkbox was checked — trigger that specific test run
    await handleCheckboxChecked();
  } else {
    throw new Error(`Unexpected EVENT_ACTION: ${EVENT_ACTION}`);
  }
}

main().catch(err => {
  console.error('mabl impact check failed:', err.message);
  process.exit(1);
});
