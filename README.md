# provider-agy

An **OpenAI-compatible** local provider that uses the backend of the **Antigravity CLI (`agy`)** and the account already signed in there. It works with **omp (Oh My Pi)** and any client that speaks OpenAI Chat Completions.

The provider translates requests to the same Cloud Code protocol used by `agy`. It does not invent an "alternative client" fingerprint: the HTTP envelope, headers, and labels mirror `agy` 1.5.9.

> Unofficial project, not affiliated with Google. Use at your own risk.

## Highlights

- **No server to start by hand.** The included omp extension launches the provider on the first session and keeps it running in the background.
- **Multi-account vault.** Import every account you sign in to with `agy`; the current keyring token is never lost.
- **Automatic failover per model.** If Gemini runs out of quota, another account takes over. Claude quota is tracked separately.
- **Returns to the previous account.** Once an exhausted account reaches its reset time, it goes back to the front of the queue.
- **Visible status.** Account switches, recoveries, a periodic account banner, and a red global block notice appear in the omp UI.
- **Hard stop on bans.** A ban, suspension, or terms violation blocks every account and stops all attempts until you manually unlock it.

## Requirements

- **Windows** with `agy` installed and signed in. Verify with:
  ```bash
  agy -p "ok"
  ```
- **Node.js 18+** (tested with Node 24).
- **omp 18.x** (optional; another OpenAI-compatible client also works).
- An OAuth client for token refresh. See [OAuth client](#oauth-client).

No `npm install` is required: the project has no external dependencies.

## Quick start

```bash
git clone https://github.com/dilneiss/omp-agy-provider-proxy.git
cd omp-agy-provider-proxy
```

### 1. Install the omp extension

```bash
npm run install:omp
```

The installer copies the extension to `~/.omp/agent/extensions/provider-agy.ts` and records this project path in `~/.provider-agy/config.json`. Restart omp after installing.

On the next session the extension starts the provider automatically. You do **not** need to run `npm start` or keep a terminal open.

### 2. Register the provider in omp

Add this block to `~/.omp/agent/models.yml` (adjust it to the format of your omp version):

```yaml
agy:
  baseUrl: http://127.0.0.1:8788/v1
  api: openai-completions
  auth: none
  models:
    - gemini-3.8-flash-high
    - gemini-3.8-flash-medium
    - gemini-3.8-flash-low
    - claude-sonnet-4-6
    - claude-opus-4-6-thinking
    - gpt-oss-120b-medium
```

Then check the model list:

```bash
omp models agy
```

Use it directly:

```bash
omp --model agy/gemini-3.8-flash-high
```

Or make it the default model:

```bash
omp config set modelRoles '{"default":"agy/gemini-3.8-flash-high"}'
```

### 3. Import your first account

```bash
npm run accounts -- add
npm run accounts -- list
npm run accounts -- quota
```

The first `omp` session starts the provider; no separate server command is needed.

## How it works

1. Reads the OAuth token from the same Windows keyring entry used by `agy` (`gemini:antigravity`).
2. Stores a copy of each account in a local vault at `~/.provider-agy/accounts.json`, outside the repository.
3. Refreshes expired tokens with the OAuth client configured locally.
4. Sends requests to Cloud Code with the same user agent, envelope, labels, and per-model generation config as `agy`.
5. Translates messages and tools between OpenAI and the Gemini/Claude format, preserving:
   - `functionCall.id` and `functionResponse.id` (required by Claude);
   - `thoughtSignature` (required by Gemini 3 on tool-call turns), persisted in `~/.provider-agy/state.json`;
   - SSE streaming, tool calls, `reasoning_content`, and usage.

If an old tool call has no stored signature, the provider drops that call/result pair instead of returning a 400 from Gemini.

## Models

| ID | Name | Context | Max output |
|---|---|---|---|
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | 1M | 64K |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) | 1M | 64K |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) | 1M | 64K |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | 250K | 64K |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | 250K | 64K |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | 128K | 32K |

## Accounts and automatic failover

The `agy` keyring holds one account at a time. The provider vault keeps all imported accounts, so you can switch accounts in `agy` without losing earlier tokens.

### Add another account

```bash
# 1. Save the account currently signed in
npm run accounts -- add

# 2. Sign in to the other account in agy
#    Use /login in the TUI or: agy acp --login

# 3. Import the new account
npm run accounts -- add

# 4. Inspect both accounts
npm run accounts -- list
npm run accounts -- quota
```

Importing the same account again updates its token instead of creating a duplicate.

### Commands

| Command | Effect |
|---|---|
| `npm run accounts -- list` | List accounts, project, and quota; `*` marks the active account. |
| `npm run accounts -- add [label]` | Import the account currently signed in to `agy`. |
| `npm run accounts -- use <email-or-index>` | Make `agy` use that account (writes the keyring). |
| `npm run accounts -- remove <email-or-index>` | Remove it from the vault without touching the keyring. |
| `npm run accounts -- quota` | Fetch live quota for every account and model. |
| `npm run accounts -- unblock` | Clear a ban/suspension block. |
| `npm run accounts -- login` | Show the add-account walkthrough. |
| `npm run quota` | Read-only quota diagnostic for the whole vault. |

Example:

```text
Vault accounts (2):
* 1. account-a@example.com
     project: aicode-consumers
     requests: 42
     quota: flash-high=84% sonnet-4-6=0%
  2. account-b@example.com
     project: aicode-consumers
     quota: flash-high=100% sonnet-4-6=97%

* = active provider account
```

The quota view is a per-account report with visual bars, remaining percentage, reset time, and a count of available models:

```text
provider-agy quotas
2 accounts · updated 11/16 00:40

● 1. account-a@example.com  ACTIVE · 3/6 models available
   project aicode-consumers
   ────────────────────────────────────────────────────────────────────────────────────
   MODEL                           QUOTA             LEFT  RESET
   Gemini 3.8 Flash · High         █████████████░░░    84%  11/16 04:20 (in 3h 41min)
   Claude Sonnet 4.6               ░░░░░░░░░░░░░░░░     0%  11/16 03:52 (in 3h 13min)

● healthy  ● attention  ● exhausted  ○ no data
The provider uses the active account first and switches automatically when a quota runs out.
```

### Routing rules

- Accounts whose reset time has passed are tried first. Otherwise the active account is tried first and stays active after a success (sticky).
- A quota `429` (`QUOTA_EXHAUSTED`, `quotaResetTimeStamp`, or "individual quota") marks the account exhausted for that model until the reset time and moves to the next account.
- Failover is per model: exhausted Claude quota does not block Gemini, and vice versa.
- A successful response clears the exhausted marker and makes that account active.
- A generic `429` without quota details (for example, a large Gemini input) does not switch accounts.
- A `401` refreshes the token and retries once. If it still fails, the account is marked invalid and the next one is tried.
- `5xx` gets one retry per account before moving on.
- If every account is out of quota, the response is `429` with the next reset time. If no account is usable, it is `503`.

Check status at any time:

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/accounts
```

## Ban, suspension, and global block

The provider checks Cloud Code errors in both HTTP responses and SSE events. If the message indicates a ban, suspension, disabled account, terms violation, or abuse, it:

- stops the request immediately and does **not** try another account;
- stores the block in `~/.provider-agy/accounts.json`, so it survives provider restarts;
- emits a `blocked` event and shows a red notice in the omp UI;
- returns `403` for every new request without calling Google.

Example notice:

```text
🚨 ACCOUNT BLOCK · ALL ATTEMPTS STOPPED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Account   account-a@example.com
🛑 Reason    Your account has been suspended for violating the Terms of Service
🕒 Since     11/16 12:21
⚠️ Action    no accounts will be tried
🔓 Fix       resolve it with Google, then run:
   npm run accounts -- unblock
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

After resolving the issue:

```bash
npm run accounts -- unblock
npm run accounts -- list
```

Quota errors, large-input `429`s, and model safety blocks do **not** trigger the global block.

## omp notices

The extension polls `/v1/accounts/events` every two seconds.

When an account is switched:

```text
🔄 ACCOUNT SWITCH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 Model     claude-sonnet-4-6
📌 Reason    quota exhausted
⬅️ From      account-a@example.com
   🔴 0% remaining  ░░░░░░░░░░ · reset 11/16 03:52 (in 3h 13min)
➡️ To        account-b@example.com
   🟢 85% remaining  █████████░ · reset 11/16 04:20 (in 3h 41min)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

When the previous account is recovered:

```text
✅ ACCOUNT RECOVERED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 Active    account-a@example.com
🤖 Model     claude-sonnet-4-6
🎯 Quota     🟢 100% remaining  ██████████
⏳ Reset     11/16 05:20 (in 4h 41min)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Every **10 successful requests**, the provider refreshes quota and emits a status event with a token summary for that window. The window includes input, output, total, average per request, the input/output share, and how much of the model context the last prompt used:

```text
📊 PROVIDER-AGY · ACCOUNT PULSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Account   account-a@example.com
🤖 Model     gemini-3.8-flash-high
🎯 Quota     🟢 84% remaining  ████████░░
⏳ Reset     11/16 04:20 (in 3h 41min)
📨 Requests  10 this window · 42 on account
🧠 Tokens    392,600 total this window
   📥 Input 382,400 (97.4%) · 📤 Output 10,200 (2.6%)
   📈 Average 39,260/request
   🧮 Last prompt 38,000 · 3.6% of 1.0M context
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The total includes thinking tokens when the backend reports them, so input plus output may not add up to 100%; the remaining share is shown as `Thinking`. The window resets after each status event. The request counter and event cursor reset when the provider restarts.

Change the interval with `AGY_STATUS_EVERY`. Notices are shown only in interactive omp sessions, not in `-p` or RPC mode.

The same event history is available to any client:

```bash
curl 'http://127.0.0.1:8788/v1/accounts/events?since=0'
# since=-1 returns only the current cursor
curl 'http://127.0.0.1:8788/v1/accounts/events?since=-1'
```

## Limits and context trimming

Context window, input limit, and quota are different limits:

| Limit | Value |
|---|---|
| Gemini 3.8 Flash context | 1,048,576 tokens |
| Claude Sonnet/Opus 4.6 context | 250,000 tokens |
| GPT-OSS 120B context | 131,072 tokens |
| Max output: Gemini / Claude / GPT-OSS | 65,536 / 64,000 / 32,768 |
| Cloud Code input per request | ~40k tokens (above that: 429) |
| Quota | Per account and model, with `remainingFraction` and `resetTime` |

The ~40k limit is a practical route/plan ceiling, not the model context window. A full omp prompt with many skills and MCP entries can exceed it.

To fit the route, the provider applies a conservative input budget (`AGY_MAX_INPUT_TOKENS`, default **38,000**):

- removes whole old turns without splitting `functionCall`/`functionResponse`;
- if needed, truncates the **tail** of the system prompt (skills/MCP catalog) while preserving the main instructions at the beginning;
- logs the adjustment and continues.

If you do not need every skill or MCP server, this also keeps prompts smaller:

```bash
omp --model agy/claude-sonnet-4-6 --no-skills --no-rules --no-context-files --no-extensions
```

Check live quota without consuming generation quota:

```bash
npm run accounts -- quota
npm run quota
```

## OAuth client

Token refresh uses the same OAuth client embedded in the `agy` binary. These credentials are **not distributed in this repository**.

**Option A: local file (recommended)**

Create `~/.provider-agy/oauth.json`:

```json
{
  "clientId": "<id>.apps.googleusercontent.com",
  "clientSecret": "GOCSPX-<secret>"
}
```

**Option B: environment variables**

```bash
AGY_OAUTH_CLIENT_ID='<id>.apps.googleusercontent.com'
AGY_OAUTH_CLIENT_SECRET='GOCSPX-<secret>'
```

Both values are embedded in the `agy` executable installed on your machine. Find the binary with `where agy` and extract the `*.apps.googleusercontent.com` and `GOCSPX-...` strings with the tool of your choice (`strings`, a hex editor, and so on). The `oauth.json` file lives outside the repository and is ignored by Git.

Without these credentials, the provider still works with the current access token until it expires. After that, refresh fails with a message explaining what to configure.

## Gemini account authentication

`agy` owns authentication; the provider only imports the token already stored in the keyring.

### First account

```bash
agy
# inside the TUI:
#   /login
# choose the Google account with Antigravity/Gemini Code Assist access

# alternative without the TUI:
agy acp --login

# verify
agy -p "ok"

# import into the provider vault
npm run accounts -- add
npm run accounts -- list
npm run quota
```

### Add another account without losing the first

```bash
npm run accounts -- add
agy
# inside the TUI: /login and choose the other Google account

agy -p "ok"
npm run accounts -- add
npm run accounts -- list
npm run quota
```

Make `agy` use a specific vault account:

```bash
npm run accounts -- use account@example.com
# or use the index from the list:
npm run accounts -- use 2
agy -p "ok"
```

### Expired or revoked token

```bash
agy acp --login
npm run accounts -- add
npm run accounts -- list
```

Quota is **per account and per model**. The provider switches accounts automatically and returns to the previous account once its reset time passes.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `AGY_PROVIDER_HOST` | `127.0.0.1` | Local server address |
| `AGY_PROVIDER_PORT` | `8788` | Local server port |
| `AGY_PROVIDER_URL` | `http://127.0.0.1:8788` | URL used by the omp extension |
| `AGY_STATUS_EVERY` | `10` | Successful responses between token/status banners |
| `AGY_PROVIDER_DIR` | from `~/.provider-agy/config.json` | Project directory the extension should start |
| `AGY_NODE` | `node` | Node executable used by the extension |
| `AGY_MAX_INPUT_TOKENS` | `38000` | Input token budget per request |
| `AGY_TRIM` | `1` | `0` disables context trimming (may hit 429) |
| `AGY_PROJECT` | `aicode-consumers` | Project sent to Cloud Code |
| `AGY_STATE_DIR` | `~/.provider-agy` | Vault, `oauth.json`, and tool-call signatures |
| `AGY_ACCESS_TOKEN` | - | Use a fixed token and ignore keyring/vault |
| `AGY_KEYRING_TARGET` | `gemini:antigravity` | Credential Manager entry used by `agy` |
| `AGY_OAUTH_CLIENT_ID` | - | OAuth client for refresh (or use `oauth.json`) |
| `AGY_OAUTH_CLIENT_SECRET` | - | OAuth secret for refresh (or use `oauth.json`) |
| `AGY_CLOUD_CODE_HOST` | `daily-cloudcode-pa.googleapis.com` | Cloud Code host |
| `AGY_DEBUG_FC` | - | `1` logs received `functionCall` parts |

## Security

- `accounts.json`, `state.json`, `oauth.json`, tokens, and logs stay outside the repository and are listed in `.gitignore`.
- The vault stores access tokens, refresh tokens, email identifiers, project, and quota for each account.
- On Windows, the vault receives an ACL restricted to your user (`icacls`).
- `npm run accounts -- use` is the only operation that changes the `agy` keyring. Normal provider use does not modify it.
- Never commit the vault, OAuth client, or logs.

## Quick verification

```bash
# agy credential
agy -p "ok"

# provider status
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models
curl http://127.0.0.1:8788/v1/accounts

# non-streaming request
curl -s -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"Reply only OK"}],"stream":false}'

# streaming request
curl -N -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"Reply only OK"}],"stream":true}'
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `CredRead failed` / keyring not found | `agy` is not signed in on this machine | Run `agy -p "ok"` and sign in |
| `agy OAuth client is not configured` | Refresh credentials are missing | Create `~/.provider-agy/oauth.json` or set `AGY_OAUTH_CLIENT_ID`/`AGY_OAUTH_CLIENT_SECRET` |
| `invalid_grant` on one account | Refresh token revoked or expired | Sign in again with `agy` and run `npm run accounts -- add` |
| `429 QUOTA_EXHAUSTED` | Model quota is exhausted | Wait for `resetTime` or add another account |
| Generic `429` on a large prompt | Per-request input limit (~40k tokens) | Lower `AGY_MAX_INPUT_TOKENS`, remove skills/MCP, or reduce context |
| Red global block notice | Google rejected an account for a ban/suspension | Resolve it with Google and run `npm run accounts -- unblock` |
| `403 SECURITY BLOCK` on every request | Global block is stored in the vault | Run `npm run accounts -- list`, then `unblock` after resolving it |
| `no account available` | Empty vault or all accounts invalid | Run `npm run accounts -- list` and `npm run accounts -- add` |
| Port 8788 already in use | Another provider or process is running | Stop it or set `AGY_PROVIDER_PORT=8790` |
| Provider does not start in omp | Extension missing or stale project path | Run `npm run install:omp` and restart omp |
| Switch notices do not appear | `-p`/RPC session or extension not loaded | Use the TUI and check `/extensions` in omp |
| Terminal windows flashing on each request | Old version running `icacls` on every save | Use the current version; subprocesses are hidden and `icacls` runs at most once per file |

Stop an old process on the port (Windows):

```bash
netstat -ano | findstr :8788
taskkill /PID <pid> /F
```

## Project layout

```text
server.js                     HTTP server, OpenAI <-> Cloud Code translation, streaming, tools
lib/accounts.js               multi-account vault, OAuth refresh, quota, selection, fallback
tools/accounts.js             account CLI (list/add/use/remove/quota/login/unblock)
tools/quota.js                read-only quota diagnostic for the vault
tools/install-omp.js          installs the auto-start omp extension
tools/keyring.ps1             Windows Credential Manager read/write
omp-extension/provider-agy.ts omp extension: auto-start and account notices
start.cmd                     manual server launcher for Windows
omp-agy.cmd                   legacy launcher that starts the server and opens omp
```

## Set up with an omp agent

Paste this prompt into an omp session, preferably from this project directory:

```text
Set up provider-agy on this machine and make omp ready to use it.

Context: this is the provider-agy repository (clone
https://github.com/dilneiss/omp-agy-provider-proxy.git if needed). The provider
is OpenAI-compatible at http://127.0.0.1:8788/v1 and is started automatically
by an omp extension. Do not ask me to run a separate server.

Do this in order:

1. Verify that agy is installed and signed in with `agy -p "ok"`. If it fails,
   stop and ask me to authenticate with `agy acp --login`.
2. Check whether ~/.provider-agy/oauth.json exists or AGY_OAUTH_CLIENT_ID and
   AGY_OAUTH_CLIENT_SECRET are set. If missing, ask me for the OAuth client
   values embedded in agy. Do not invent values, print secrets, or commit them.
3. Run `npm run install:omp` to install the auto-start extension.
4. Ensure ~/.omp/agent/models.yml has an `agy` provider with:
   baseUrl: http://127.0.0.1:8788/v1
   api: openai-completions
   auth: none
   and the models gemini-3.8-flash-high/medium/low, claude-sonnet-4-6,
   claude-opus-4-6-thinking, and gpt-oss-120b-medium. Back up the file first.
5. Run `npm run accounts -- add`, then `npm run accounts -- list` and
   `npm run accounts -- quota`.
6. Open a new omp session and confirm that the provider starts automatically.
7. Run `omp models agy` and confirm that all six models appear.
8. Test a completion with the model gemini-3.8-flash-high.
9. Do not commit accounts.json, oauth.json, state.json, tokens, or logs. Do not
   expose real emails, tokens, or quotas in your response.

Summarize imported accounts, quota by model, auto-start status, and the
generation test result.
```

## Disclaimer

- The repository contains no account tokens. The vault lives in your home directory and must never be committed.
- The OAuth client is the same one embedded in the distributed `agy` binary, but it is **not distributed here**: configure it in `~/.provider-agy/oauth.json` or through environment variables.
- Using Antigravity credentials outside the official client may violate the service terms. Replicating the `agy` fingerprint does not guarantee that an account will never be blocked.
- The ~40k input limit and the Cloud Code protocol are backend details and may change without notice.
