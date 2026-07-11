# ChatGPT App Submission Checklist

## Prerequisites (verified)

- [x] Production MCP endpoint live: `POST https://hol.org/api/guard/mcp` → 401 without Bearer
- [x] OAuth metadata: `GET https://hol.org/api/guard/oauth` → 200 with correct scopes
- [x] `.well-known/oauth-protected-resource` fix committed to Cloudflare Worker (needs `wrangler deploy`)
- [x] hol-guard v2.0.1037 published to PyPI with MCP server and pagination fix
- [x] Plugin `.mcp.json` merged in hol-guard-plugin PR #13
- [x] All 7 PRs merged, 0 unresolved review threads
- [x] Guard-test: 19/19 steps pass
- [x] Local MCP: 3 tools (search, fetch, get_guard_status), all read-only
- [x] `chatgpt-app-submission.json` generated (3 tools, 6 test cases, 12 negative tests)
- [x] Privacy policy URL: `https://hol.org/points/legal/privacy` → 200
- [x] Terms URL: `https://hol.org/points/legal/terms` → 200
- [x] App icon: `assets/icon.png` exists (non-zero size)
- [x] Logo: `assets/logo.svg` exists
- [x] Screenshot: `assets/screenshot.svg` exists
- [x] No widget/resource registered in v1
- [x] No checkout, subscription, upsell, approval, policy mutation, sync, delete, or admin tool exists
- [x] Tool annotations: all readOnlyHint=true, destructiveHint=false, openWorldHint=false
- [x] Sanitization verified: no UUIDs, paths, or secrets in tool output
- [x] Fetch output ≤ 32 KiB, search results ≤ 20

## Human Actions Required

### Step 1: Deploy Cloudflare Worker

```bash
cd ~/CascadeProjects/hashgraph-online/cloudflare-workers/hol-registry-proxy
npx wrangler deploy
```

Verify: `curl https://hol.org/.well-known/oauth-protected-resource` returns JSON with `resource`, `authorization_servers`, `scopes_supported`.

Note: MCP clients can use `https://hol.org/api/guard/oauth` directly in the meantime.

### Step 2: Create ChatGPT App

1. Go to ChatGPT developer settings (https://chatgpt.com/developers)
2. Create a new app
3. Configure:
   - **Name**: HOL Guard
   - **MCP endpoint URL**: `https://hol.org/api/guard/mcp`
   - **OAuth authorization server**: `https://hol.org/api/guard/oauth`
   - **Scopes**: `guard:workspace.read`, `guard:receipt.read`
   - **Callback URI**: (set to the ChatGPT-provided callback URL)
4. Record the real `plugin_asdk_app...` app ID

### Step 3: Add `.app.json`

Create `hol-guard-plugin/.app.json` with the real app ID:

```json
{
  "app_id": "plugin_asdk_APP_ID_FROM_CHATGPT"
}
```

Add to `.codex-plugin/plugin.json`:
```json
"apps": "./.app.json"
```

### Step 4: Upload `chatgpt-app-submission.json`

Upload `chatgpt-app-submission.json` to the ChatGPT Apps submission form. The file contains:
- App info (name, developer, URLs, icon, descriptions)
- MCP server config (endpoint, OAuth, scopes, PKCE)
- 3 tool definitions with annotation justifications
- 6 positive test cases
- 12 negative test cases (auth, isolation, sanitization)
- Reviewer instructions (data access, security model, privacy)

### Step 5: Verify in ChatGPT Developer Mode

Test the following flows:
- [ ] OAuth authorize flow succeeds
- [ ] OAuth cancel works (user denies consent)
- [ ] OAuth refresh token works
- [ ] OAuth revoke works
- [ ] Reauthorize after revocation
- [ ] Scope display shows only `guard:workspace.read` and `guard:receipt.read`
- [ ] `search` tool returns results
- [ ] `fetch` tool returns a receipt by opaque ID
- [ ] `get_guard_status` returns contract version and freshness
- [ ] Empty results when no data exists
- [ ] Stale data indicator when data is outdated
- [ ] Result links open signed-in HOL Guard pages

### Step 6: Submit

- [ ] Run platform pre-submission checks
- [ ] Resolve every real issue
- [ ] Submit only after all PRD release gates pass
- [ ] Record submission ID, submitted version, date, and any reviewer follow-up

## Evidence to Collect

- Submission ID
- Submitted version
- Date of submission
- Any reviewer follow-up notes
- Screenshots of developer mode verification (synthetic data only)
