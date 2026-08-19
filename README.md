# cliclaw

**Control Claude Code, Codex, Pi & Gemini running on your Mac — from your phone, via Telegram.**

<img width="617" height="448" alt="cliclaw in Telegram: driving a local coding agent from the phone" src="https://github.com/user-attachments/assets/d6204699-11a2-4c8b-a100-4a2527f91c75" />

<p>
  <a href="https://github.com/choiyounggi/cliclaw/actions/workflows/test.yml"><img alt="Test" src="https://github.com/choiyounggi/cliclaw/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@younggichoi/cliclaw"><img alt="npm" src="https://img.shields.io/npm/v/@younggichoi/cliclaw?logo=npm"></a>
  <a href="https://www.npmjs.com/package/@younggichoi/cliclaw"><img alt="downloads" src="https://img.shields.io/npm/dm/@younggichoi/cliclaw?logo=npm&label=downloads"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS-blue">
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%201.x-black?logo=bun">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
</p>

**English** | [한국어](README.ko.md)

Coding agents are great at long-running tasks — until they finish, or get stuck
waiting for a y/n confirmation, while you're away from your desk. cliclaw
removes the tether to your chair: kick off a task before you leave, watch
progress stream into Telegram, approve or deny dangerous commands from your
phone, and send follow-up instructions from wherever you are.

Under the hood it's a single daemon on your Mac that turns a Telegram chat into
a remote control for four local coding CLIs (**Claude Code · Codex · Pi ·
Gemini**), switching between them per chat.

It keeps an independent per-agent session for every chat, and ships a confirm
gate for dangerous commands, response streaming, image-attachment handling, and
auto-detection of corporate TLS interceptors (Zscaler, etc.).

> Install **only the CLIs you want** — missing agents are automatically dropped
> from the active list.

> The chat UX (user messages, errors, `/help`) is currently Korean-first; the
> bot itself works fine either way.

## Quick start (3 minutes)

### 1. Prerequisites

- macOS (Apple Silicon / Intel)
- [Bun](https://bun.sh) 1.x — `curl -fsSL https://bun.sh/install | bash`
- **At least one** of the coding CLIs installed and logged in (the bot merely spawns authenticated child processes)
  - Claude Code: `npm install -g @anthropic-ai/claude-code`
  - Codex: `npm install -g @openai/codex`
  - Pi: `npm install -g @earendil-works/pi-coding-agent`
  - Gemini: `npm install -g @google/gemini-cli`

### 2. Install

```bash
# Bun (recommended)
bun add -g @younggichoi/cliclaw

# or npm
npm install -g @younggichoi/cliclaw
```

> The package publishes under a scoped name (`@younggichoi/cliclaw`), but the
> installed command is simply **`cliclaw`**.

### 3. Interactive setup

```bash
cliclaw init
```

Five steps, guided:

```
Welcome to cliclaw setup.

Step 1/5 — Telegram bot token
  Get one from @BotFather (/newbot) on Telegram.
  Bot token: 1234:ABC...
  ✓ @yourbotname (id=...) verified

Step 2/5 — Detect installed coding agents
  ✓ claude  2.1.139 (Claude Code)         @ ~/.nvm/.../bin/claude
  ✓ codex   1.0.0                          @ /opt/homebrew/bin/codex
  ✓ pi      unknown                        @ /opt/homebrew/bin/pi
  ✓ gemini  0.42.0                         @ ~/.nvm/.../bin/gemini
  Default agent? [claude] (claude/codex/pi/gemini): claude

Step 3/5 — Authorize your Telegram account
  Open Telegram and send any message to @yourbotname now.
  Waiting up to 5 minutes... press Ctrl-C to abort.
  ✓ Received from user_id=123456789
  Authorize this Telegram user? [Y/n] y

Step 4/5 — Corporate TLS interceptor (optional)
  $NODE_EXTRA_CA_CERTS: /path/to/Zscaler.pem
  Apply this CA certificate to the bot's LaunchAgent environment? [Y/n] y

Step 5/5 — Auto-start at login (launchd)
  Install LaunchAgent so the bot starts automatically on login? [Y/n] y
  ✓ Installed ~/Library/LaunchAgents/com.alice.cliclaw.plist
  ✓ Bot started.

All set.
  Logs:  tail -f ~/.cliclaw/logs/bot.log
  Test:  send /status in Telegram.
```

That's it. The bot restarts automatically after screen lock or a reboot.

## CLI commands

| Command | What it does |
|---|---|
| `cliclaw init` | Interactive setup (token, agent detection, telegram-id capture, CA, launchd) |
| `cliclaw start` | Run the bot in the foreground (for testing) |
| `cliclaw install-launchd` | Install the LaunchAgent (auto-applies `launchd.extraEnv` from config.json) |
| `cliclaw uninstall-launchd` | Remove the LaunchAgent |
| `cliclaw upgrade` | Pull the latest npm release and reinstall the LaunchAgent |
| `cliclaw logs [--audit\|--err]` | Tail a log file (default: `bot.log`; `--audit`: `audit.jsonl`; `--err`: `bot.err`) |
| `cliclaw doctor` | Live checks: token, launchd, agents, TLS CA |
| `cliclaw help` | Help |

## Chat commands (in Telegram)

| Command | What it does |
|---|---|
| `/claude` `/codex` `/pi` `/gemini` | Switch this chat's active agent (uninstalled agents are hidden) |
| `/status` | Per-agent session status + any job in progress |
| `/health` | Bot system status (uptime, memory, log sizes, chat/job counts) |
| `/stop` | Cancel this chat's running job (SIGTERM → SIGKILL after 5s) |
| `/reset` | Discard only the current active agent's session |
| `/reset all` | Discard every agent session in this chat |
| `/safety` | Show safety-mode status — toggle with `/safety on` / `/safety off` |
| `/model` | Show/set this chat's per-agent model override — `/model <name>` to set, `/model default` to clear |
| `/plan` | Claude-only plan-mode toggle — `/plan on` spawns Claude with `--permission-mode plan` (propose, don't edit); `/plan off` reverts |
| `//<cmd>` | Native slash-command passthrough — strips one leading `/` and sends `<cmd>` verbatim as the prompt (e.g. `//compact`); whether the underlying CLI honors it in headless mode is up to that CLI |
| `/start` `/help` | Help |
| Any other text / photo | Sent as a prompt to the active agent (photos are downloaded and their path is prepended to the prompt) |

Switching agents keeps the old session intact — come back and continue. Sending
a new prompt to a chat with a running job is rejected (use `/stop` or wait).

## Directory layout

All state is isolated under `~/.cliclaw/`:

```
~/.cliclaw/
├── config.json              # mode 600; token, allowlist, launchd extraEnv
├── safety.json              # persisted /safety on|off state
├── sessions.json            # per-chat active-agent metadata
├── sessions/                # per-chat codex / pi / gemini directories
├── workspace/               # the agents' shared cwd (sandbox)
│   ├── .claude/settings.json # dangerous-command hook + deny rules when safety is ON
│   └── uploads/<chatId>/    # Telegram photo downloads
├── logs/
│   ├── bot.log              # token auto-masking applied
│   ├── bot.err              # launchd stderr
│   └── audit.jsonl          # audit log (decisions, safety state)
└── .sock/                   # confirm-gate IPC
```

The state directory can be moved with the `CLICLAW_HOME` env var:

```bash
CLICLAW_HOME=~/my-bot cliclaw init
```

## Features

### 1. Automatic agent path discovery
No absolute paths in `config.json`. At startup, agents are discovered in three passes:
1. `~/.local/bin`, `~/.claude/local`, `/usr/local/bin`, `/opt/homebrew/bin`
2. `bin/<cmd>` of the newest node under `$NVM_DIR` or `~/.nvm`
3. `command -v <cmd>` in a login shell (PATH with `.zshrc` loaded)

Undetected agents are gracefully skipped. The bot runs fine with any subset of the four.

### 2. Safety mode (`/safety on` · `/safety off`)
**ON (default)**:
- Dangerous Bash commands (`rm -rf`, `git push --force`, DROP, `kubectl delete`, AWS `delete-*`, `sudo`, `curl|sh`, ssh prd-*, …) are re-confirmed via a Telegram inline keyboard `[✅ Allow] [❌ Deny]` — no response means auto-deny.
- Claude's Read tool denies sensitive files: `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**`, `~/.netrc`, `~/.npmrc`, `**/.env*`, `**/*.pem`, `**/id_rsa*`, `**/id_ed25519*`, `./secrets/**`.
- Add your own regexes via `confirmGate.extraPatterns`.

**OFF**: if your environment already has an external guard (`pre-bash-guard`,
EDR, …) and the bot's confirm prompts feel redundant, turn it off with one line
in Telegram. Deny rules are disabled together. Every IPC request is still
recorded in `logs/audit.jsonl` as `decision: allow, reason: safety_off`.

The state persists in `$CLICLAW_HOME/safety.json` across restarts.

### 3. Response streaming (Claude)
Consumes `text_delta` from `--include-partial-messages` and live-updates via
`editMessageText`, debounced at 1.5s. Past 3800 chars it rolls over to a new message.

### 4. Image attachments
Telegram photos/image documents are downloaded to
`workspace/uploads/<chatId>/<msgId>.<ext>` and the path is prepended to the prompt.

### 5. Headless permission policy
- **Claude**: runs with `--permission-mode bypassPermissions` — dangerous Bash is caught by the confirm gate, and sensitive files by safety-mode deny rules.
- **Codex**: `sandbox=workspace-write` by default. Never use `danger-full-access`.
- **Pi**: default mode.
- **Gemini**: `approvalMode=auto_edit` by default (edits auto-approved, destructive commands prompt). More autonomous `yolo` or more conservative `default`/`plan` available.

### 6. Corporate TLS interceptor auto-detection
Where Zscaler / Forticlient / Cisco Umbrella intercepts HTTPS, Node cannot
trust Telegram's certificate and the bot cannot run. Step 4 of `cliclaw init`
auto-detects `$NODE_EXTRA_CA_CERTS` or `launchctl getenv NODE_EXTRA_CA_CERTS`,
asks you, and persists it into `launchd.extraEnv` in `config.json`. Every later
`install-launchd` bakes it into the plist automatically.

### 7. Secret masking in logs
Everything written to `logs/bot.log` / `bot.err` is pre-redacted:
- Telegram bot tokens (`\d{8,}:[A-Za-z0-9_-]{30,}`)
- npm tokens (`npm_…`)
- GitHub PATs (`gh[pousr]_…`)
- exact matches of the live `config.token`

Defends against Time Machine backups, EDR, and shoulder surfing alike.

### 8. Korean UI
All user-facing messages, errors, and `/help` are in Korean (English copy PRs welcome).

## launchd details

Answering "Yes" at step 5 of `cliclaw init`:
1. Creates `~/Library/LaunchAgents/com.<username>.cliclaw.plist` (corporate CA baked in)
2. Loads and starts it immediately via `launchctl bootstrap gui/$UID <plist>`
3. Auto-restarts on login / boot / crash from then on
4. stdout → `~/.cliclaw/logs/bot.log`, stderr → `bot.err`

Manual management:
```bash
# stop (auto-restarts on next login)
launchctl kill SIGTERM gui/$UID/com.<username>.cliclaw

# fully disable (no auto-restart either)
cliclaw uninstall-launchd

# re-enable (auto-applies launchd.extraEnv from config.json)
cliclaw install-launchd
```

## Security

- **The bot token = a remote shell into every installed agent.** If it leaks, `/revoke` at BotFather immediately.
- An empty `allowedUserIds` rejects all messages (fail-closed).
- Keep `config.json` at mode `600` (init sets it automatically).
- Never set `confirmGate.enabled: false` or switch the codex sandbox to `danger-full-access`.
- Opting Gemini's `approvalMode` into `yolo` auto-approves every tool — use it with full understanding.
- When in doubt, `/safety on` re-activates the deny rules instantly.

## Manual setup (without init)

To install without the `cliclaw init` flow:

```bash
git clone https://github.com/choiyounggi/cliclaw.git
cd cliclaw
bun install
mkdir -p ~/.cliclaw
cp config.example.json ~/.cliclaw/config.json
chmod 600 ~/.cliclaw/config.json
# fill token and allowedUserIds in config.json, then
bun run bot.ts
```

## Tests

```bash
bun run test
```

## Known limits

- Dangerous patterns are regex-based — 100% classification is impossible; you own the policy.
- No body-text streaming for Codex / Pi / Gemini (no structured events, or not integrated).
- Gemini's dangerous commands rely solely on its own `approvalMode` (bash-confirm IPC not integrated).
- The hook holds the IPC while waiting for the user's decision.
- No voice/file attachments (photos only).
- Concurrent messages in the same chat are rejected (`/stop` or wait).
- macOS only.

## Changelog

Per-version changes live on [GitHub Releases](https://github.com/choiyounggi/cliclaw/releases).

## Release automation (maintainer)

Publishing a new version:

```bash
# 1) bump the version (auto-creates commit + tag)
npm version patch          # or minor / major

# 2) push commit + tag
git push --follow-tags
```

Then in the GitHub web UI: "Draft a new release" → pick the tag → Publish
release. `.github/workflows/publish.yml` runs automatically through
`npm publish --access public`. The workflow first verifies the release tag
matches the `package.json` version and fails without publishing on a mismatch.

**One-time prerequisite**: repo Settings → Secrets and variables → Actions →
register **NPM_TOKEN** with an npm token capable of 2FA bypass.

1. <https://www.npmjs.com/settings/younggichoi/tokens/new>
2. Issue a Granular Access Token or a Classic **Automation** token (with 2FA bypass)
3. Add the `npm_…` token as the GitHub Actions secret `NPM_TOKEN`

**Hardening option**: switch to npm Trusted Publishing (OIDC) and no token is needed at all.
1. At <https://www.npmjs.com/package/@younggichoi/cliclaw/access>, add Trusted Publisher → GitHub Actions (workflow filename: `publish.yml`)
2. In `.github/workflows/publish.yml`, add `permissions: id-token: write`, remove `NODE_AUTH_TOKEN`, add the `--provenance` flag
3. Delete the old NPM_TOKEN secret

## Contributing & security

- Code contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Dev flow & directory structure: [DEVELOPMENT.md](DEVELOPMENT.md)
- Security policy, threat model, vulnerability reports: [SECURITY.md](SECURITY.md)

## License

MIT. See `LICENSE`.
