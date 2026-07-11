# ChatGPT App Submission Checklist

## Prerequisites (verified)

- [x] Production MCP endpoint live: `POST https://hol.org/api/guard/mcp` → 401 without Bearer
- [x] OAuth metadata: `GET https://hol.org/api/guard/oauth` → 200 with correct scopes, PKCE S256, `resource_parameter_supported: true`
- [x] `.well-known/oauth-protected-resource` → 200 (FIXED via registry-broker PR #159 + k8s ingress patch, no Cloudflare Worker deploy needed)
- [x] hol-guard v2.0.1037 published to PyPI with MCP server and pagination fix
- [x] Plugin `.mcp.json` merged in hol-guard-plugin PR #13
- [x] All 14 PRs merged across 4 repos (hol-guard #1404, #1431, #1433; portal #3942, #3950, #3963, #3964, #3971; plugin #13, #14, #15; registry-broker #159, #160, #161), 0 unresolved review threads
- [x] Guard-test: 20/20 steps pass with teardown
- [x] Local MCP: 3 tools (search, fetch, get_guard_status), all read-only
- [x] `chatgpt-app-submission.json` schema-compliant (3 tools with annotations + justifications, 5 positive + 3 negative test cases)
- [x] Privacy policy URL: `https://hol.org/points/legal/privacy` → 200
- [x] Terms URL: `https://hol.org/points/legal/terms` → 200
- [x] App icon: `assets/icon.png` exists (non-zero size)
- [x] Logo: `assets/logo.svg` exists
- [x] Screenshot: `assets/screenshot.svg` exists
- [x] No widget/resource registered in v1
- [x] No checkout, subscription, upsell, approval, policy mutation, sync, delete, or admin tool exists
- [x] Tool annotations: all readOnlyHint=true, destructiveHint=false, openWorldHint=false (PR #3971 fixed live server)
- [x] WWW-Authenticate 401 header includes resource_metadata + scope (PR #3964)
- [x] `.well-known/oauth-authorization-server` → 200 (RFC 8414, PR #160 + #161)
- [x] Sanitization verified: no UUIDs, paths, or secrets in tool output
- [x] Fetch output ≤ 32 KiB, search results ≤ 20
- [x] 20/20 production verification checks pass
- [x] 42/42 local MCP contract + security tests pass
## Human Actions Required

### Step 1: Create ChatGPT App

1. Go to ChatGPT developer settings (https://chatgpt.com/developers)
2. Create a new app
3. Configure:
   - **Name**: HOL Guard
   - **MCP endpoint URL**: `https://hol.org/api/guard/mcp`
   - **OAuth authorization server**: `https://hol.org/api/guard/oauth`
   - **Scopes**: `guard:workspace.read`, `guard:receipt.read`
   - **Callback URI**: (set to the ChatGPT-provided callback URL)
4. Record the real `plugin_asdk_app...` app ID

Note: `.well-known/oauth-protected-resource` is already live at `https://hol.org/.well-known/oauth-protected-resource` → 200. No Cloudflare Worker deploy needed.

### Step 2: Add `.app.json`

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

### Step 3: Upload `chatgpt-app-submission.json`

Upload `chatgpt-app-submission.json` to the ChatGPT Apps submission form. The file contains:
- App info (display_name, subtitle, category: DEVELOPER_TOOLS)
- MCP server config (endpoint, OAuth, scopes, PKCE)
- 3 tool definitions with annotations + justifications
- 5 positive test cases
- 3 negative test cases (auth, isolation, sanitization)
- Reviewer instructions (data access, security model, privacy)

### Step 4: Verify in ChatGPT Developer Mode

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

### Step 5: Submit

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
