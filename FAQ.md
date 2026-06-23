# CodexBridge FAQ

## Which ChatGPT account should I use?

Use ChatGPT Plus or Pro with Apps / Developer Mode access.

Current testing shows free and Go accounts do not expose the app flow needed for CodexBridge.

CodexBridge does not unlock Developer Mode, unlock models, bypass account limits, or provide account access. It connects to the ChatGPT app surface your account already has.

Account access and model tool support are separate. A Plus or Pro account can have Apps / Developer Mode, while a specific model surface may still be unable to call connectors or MCP tools directly. Use the Pro context fallback for those sessions.

## What is the recommended install path?

Install globally once:

```bash
npm install -g @naplesblue/codexbridge
```

Do not install the unscoped `codexbridge` package. That npm name belongs to a different CLI, so the scoped package is the canonical install path for this project.

Then run setup from the repo you want ChatGPT to work on:

```bash
codexbridge setup
```

After setup, daily startup from that same repo is:

```bash
codexbridge start
```

`npx -y -p @naplesblue/codexbridge codexbridge start` still works as a no-install fallback, but the global install is easier for normal users.

## What do I enable in ChatGPT?

Open ChatGPT and go to:

```text
Settings
-> Apps
-> Advanced settings
-> Developer mode: on
-> Enforce CSP in developer mode: on
-> Create app
```

In Create App:

```text
Name: CodexBridge
Description: Local workspace bridge for ChatGPT coding
Connection: Server URL
Server URL: paste the URL copied by CodexBridge
Authentication: No Authentication / None
```

The copied Server URL already includes the private CodexBridge token.

## Should CSP stay enabled?

Yes. Keep Enforce CSP in developer mode enabled.

CodexBridge widgets are built for the CSP-enabled path. They do not need unrestricted network access, external fonts, remote scripts, iframes, or third-party images.

## Does CodexBridge bypass rate limits?

No.

CodexBridge does not bypass, avoid, increase, pool, resell, or modify ChatGPT, Codex, OpenAI, or third-party model limits. Every request still runs through the user's own ChatGPT session and whatever limits that account has.

The useful part is that Codex and ChatGPT are different product surfaces. If one workflow is unavailable and another product surface you already have access to is still available, CodexBridge lets you work against the same local repo without changing either product's limits.

## Can CodexBridge use GPT-5.5?

Only if your ChatGPT account already exposes that exact model, or a similar stronger model, in the ChatGPT web product surface you are using, and that model surface can call Developer Mode apps.

Some stronger planning-model surfaces may not be able to call the CodexBridge connector directly. CodexBridge does not provide, proxy, resell, or unlock models. It gives compatible ChatGPT sessions local repo tools.

For models that cannot call tools, generate a repo context bundle instead:

```bash
codexbridge pro-bundle --root /path/to/repo --copy
```

## What can ChatGPT see through CodexBridge?

ChatGPT can see explicit workspace context exposed by tools:

- `AGENTS.md`
- `.ai-bridge` plans and status files
- git status
- git diff
- selected source files
- file tree and search results

It cannot read hidden Codex runtime memory or anything outside the allowed workspace unless you explicitly allow that root.

## What can ChatGPT edit?

In normal coding mode, ChatGPT can write and exact-edit files inside the configured workspace.

Safety defaults block common sensitive paths:

- `.env`
- private keys
- `.git`
- `node_modules`
- generated build/cache folders
- symlink escapes
- paths outside the workspace

Use handoff mode if you want ChatGPT to write a plan only and let Codex execute locally.

## Can CodexBridge bind bash to a specific session id?

CodexBridge cannot attach to, read, or execute inside a specific Codex app conversation or terminal session.

The MCP `bash` tool runs from the CodexBridge server process you started for the configured workspace. MCP session ids are HTTP transport state between ChatGPT and CodexBridge; they are not Codex conversation ids.

What CodexBridge can do is require a matching local bash session label before it runs shell commands:

```bash
codexbridge start --bash-session main --require-bash-session
```

Then `bash` calls must include `session_id: "main"`. This helps avoid accidental shell execution in the wrong CodexBridge terminal, but it is not remote control of an existing Codex app chat.

CodexBridge can list local Codex session ids and titles when you explicitly opt in:

```bash
codexbridge start --tool-mode full --codex-sessions metadata
```

This reads local Codex JSONL history under `~/.codex/sessions` and `~/.codex/archived_sessions` and returns metadata plus `codex resume <session-id>` commands. Use `--codex-sessions read` only if you also want bounded transcript reads. It does not attach to a live Codex app conversation.

If you do not want ChatGPT to trigger shell commands while you work in Codex, start CodexBridge with bash disabled:

```bash
codexbridge start --no-bash
```

If you only want ChatGPT to plan and leave execution to Codex or another local agent:

```bash
codexbridge start --mode handoff --no-bash
```

## Which tunnel should I choose?

Use this rule:

```text
Fast demo:              Cloudflare quick tunnel
Recommended stable URL: ngrok free dev domain
Custom domain:          Cloudflare named tunnel
No public tunnel:       local-only mode, only for clients that can reach localhost
```

Cloudflare quick tunnel URLs change on restart. If you put a quick-mode URL into ChatGPT, you must edit the ChatGPT app Server URL every time you restart the tunnel.

For most users, the better path is a free ngrok dev domain. Create a free ngrok account, find your assigned dev domain under Universal Gateway -> Domains, and save that hostname during `codexbridge setup`.

If you own a domain, use Cloudflare named tunnels and route DNS to a hostname like `codexbridge.example.com`.

Official references:

- ngrok dev domains: https://ngrok.com/docs/universal-gateway/domains
- Cloudflare Tunnel routing: https://developers.cloudflare.com/tunnel/routing/
- Cloudflare Tunnel DNS records: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/

## Can I use the same ChatGPT app URL every day?

Yes, if you use a stable hostname.

Recommended simple path:

```bash
codexbridge setup
# choose ngrok
# enter your ngrok free dev domain
```

After that:

```bash
codexbridge start
```

The same hostname and CodexBridge token are reused for that workspace.

## What if I run CodexBridge in two repos at once?

Use different local ports and different tunnel hostnames.

Example:

```text
repo A: port 8787, hostname A
repo B: port 8788, hostname B
```

Run `codexbridge setup` in each repo and save a profile per workspace.

## Why use naplesblue.github.io/codexbridge?

GitHub Pages gives `owner.github.io` only to the GitHub user or organization named `owner`.

For this fork, the clean project Pages URL is:

```text
https://naplesblue.github.io/codexbridge/
```

## Is CodexBridge production safe?

CodexBridge is a local developer bridge, not an OS sandbox.

Use it with repos you trust. Keep token auth enabled for public tunnels. Keep safe bash on unless you know why you need full bash. Read [SECURITY.md](SECURITY.md) before exposing it through a public tunnel.

## Where are saved settings stored?

Workspace profiles are saved under:

```text
~/.codexbridge/profiles/
```

Use:

```bash
codexbridge settings
codexbridge settings list
codexbridge settings delete --yes
```

Saved tokens are redacted when profiles are displayed.
