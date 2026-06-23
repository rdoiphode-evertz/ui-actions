// Vercel Serverless Function — mabl Run Button Handler
//
// This function is called when a reviewer clicks the "▶ Run" button in a PR comment.
// It:
//   1. Triggers a mabl plan run against the staging URL
//   2. Fires a repository_dispatch to GitHub so mabl-manual-run.yml picks up and polls
//   3. Redirects the user to the mabl run page
//
// Required Vercel environment variables:
//   MABL_API_KEY        — mabl CI/CD Integration API key
//   MABL_WORKSPACE_ID   — mabl workspace ID (from app.mabl.com/workspaces/<ID>/...)
//   GITHUB_TOKEN        — GitHub PAT with repo scope (to fire repository_dispatch)
//   GITHUB_REPO         — e.g. rdoiphode-evertz/ui-actions

const MABL_API_BASE  = 'https://api.mabl.com';
const MABL_APP_BASE  = 'https://app.mabl.com';
const GITHUB_API_BASE = 'https://api.github.com';

export default async function handler(req, res) {
  const { plan, pr, staging_url, plan_name, commit_sha } = req.query;

  // Basic input validation
  if (!plan || !pr || !staging_url) {
    return res.status(400).json({ error: 'Missing required params: plan, pr, staging_url' });
  }

  const {
    MABL_API_KEY,
    MABL_WORKSPACE_ID,
    GITHUB_TOKEN,
    GITHUB_REPO,
  } = process.env;

  if (!MABL_API_KEY || !MABL_WORKSPACE_ID || !GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Server misconfigured — missing environment variables' });
  }

  // 1. Trigger mabl plan run
  let runId;
  try {
    const mablRes = await fetch(`${MABL_API_BASE}/testing/api/v0/plan-runs`, {
      method: 'POST',
      headers: {
        'x-mabl-api-key': MABL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan_id: plan,
        environment: {
          uri: staging_url.startsWith('http') ? staging_url : `https://${staging_url}`,
        },
      }),
    });

    if (!mablRes.ok) {
      const body = await mablRes.text();
      console.error(`mabl API error: ${mablRes.status} — ${body}`);
      return res.status(502).json({ error: `mabl API returned ${mablRes.status}` });
    }

    const run = await mablRes.json();
    runId = run.id;
    console.log(`Triggered mabl run ${runId} for plan ${plan}`);
  } catch (err) {
    console.error('Failed to trigger mabl run:', err.message);
    return res.status(502).json({ error: 'Failed to trigger mabl run' });
  }

  // 2. Fire repository_dispatch so mabl-manual-run.yml starts polling
  try {
    const dispatchRes = await fetch(`${GITHUB_API_BASE}/repos/${GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'mabl-manual-run',
        client_payload: {
          plan_id: plan,
          run_id: runId,
          pr_number: pr,
          plan_name: plan_name || plan,
          staging_url: staging_url,
          commit_sha: commit_sha || 'unknown',
        },
      }),
    });

    if (!dispatchRes.ok) {
      const body = await dispatchRes.text();
      console.error(`GitHub dispatch error: ${dispatchRes.status} — ${body}`);
      // Non-fatal — run was already triggered, just won't update the PR comment
    } else {
      console.log('Fired repository_dispatch: mabl-manual-run');
    }
  } catch (err) {
    console.error('Failed to fire GitHub dispatch:', err.message);
    // Non-fatal
  }

  // 3. Return a simple "triggered" page — user stays on/returns to the PR
  const runUrl = `${MABL_APP_BASE}/workspaces/${MABL_WORKSPACE_ID}/plans/${plan}/runs/${runId}`;
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<!DOCTYPE html>
<html>
  <head>
    <title>mabl Test Triggered</title>
    <style>
      body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f6f8fa; }
      .card { background: white; border-radius: 8px; padding: 32px 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
      h2 { color: #1a7f37; margin-top: 0; }
      p { color: #57606a; margin: 8px 0; }
      a { color: #0969da; font-size: 14px; }
      .close-hint { font-size: 13px; color: #8c959f; margin-top: 16px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>✅ Test Run Triggered</h2>
      <p><strong>${plan_name || plan}</strong></p>
      <p>The PR comment will update with results automatically.</p>
      <p><a href="${runUrl}" target="_blank">View live run in mabl ↗</a></p>
      <p class="close-hint">You can close this tab and return to the PR.</p>
    </div>
  </body>
</html>`);
}
