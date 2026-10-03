# Installing usage-hud

usage-hud is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview): a plugin whose code runs inside Claude Code and draws in the band above the prompt. One install covers both places it runs:

- **Claude Code CLI** in a terminal (Windows, macOS, Linux)
- **Claude Desktop**, in the **Code** tab (Windows, macOS). Desktop's regular chat tab doesn't load mods.

Both read the same user-level plugin settings in `~/.claude`, so installing once from either one makes the HUD available in both.

## Contents

1. [Requirements](#1-requirements)
2. [Check your machine](#2-check-your-machine)
3. [Install on Windows](#3-install-on-windows)
4. [Install on macOS](#4-install-on-macos)
5. [Verify](#5-verify)
6. [Configure](#6-configure)
7. [Update and uninstall](#7-update-and-uninstall)
8. [Troubleshooting](#8-troubleshooting)

## 1. Requirements

| Requirement | Why | Check |
| :- | :- | :- |
| **Claude Code 2.1.287 or later** | Mods load from this version on | `claude --version` |
| **Signed in** to Claude Code | The first signed-in start turns mods on for your account | `claude auth status` |
| **Node.js 18 or later** on `PATH` | Reads transcripts for the cross-session history (the live boxes work without it) | `node --version` |
| **git** | `/plugin marketplace add` clones this repository | `git --version` |
| **Claude Desktop that bundles Claude Code 2.1.287+** (Desktop only) | Desktop runs its own copy of Claude Code, updated only with the Desktop app | the check script reports it |
| A **24-bit color terminal** (recommended) | The matte palette and gradients | Windows Terminal, VS Code, iTerm2, Ghostty, WezTerm, Kitty |

## 2. Check your machine

The repository ships read-only check scripts that test every requirement above and tell you how to fix what's missing. They change nothing.

**Windows (PowerShell):**

```powershell
git clone https://github.com/chandan84/cache-time-pending-usage-limit-mod
cd cache-time-pending-usage-limit-mod
powershell -ExecutionPolicy Bypass -File scripts\check-prereqs.ps1
```

**macOS (Terminal):**

```bash
git clone https://github.com/chandan84/cache-time-pending-usage-limit-mod
cd cache-time-pending-usage-limit-mod
bash scripts/check-prereqs.sh
```

Each line reads `PASS`, `FAIL`, `WARN`, or `INFO`. The script exits with status `0` when every required check passes and `1` otherwise, so it also works in automation. Fix every `FAIL` before you install. `WARN` lines are worth reading: they cover color support, a stale Desktop build, and a shadowed `claude` on `PATH`.

Example (Windows):

```
  [PASS] Claude Code CLI           2.1.288 at C:\Users\you\.local\bin\claude.exe
  [PASS] Signed in                 claude auth status: loggedIn
  [PASS] Node.js                   v22.11.0
  [PASS] git                       git version 2.49.0.windows.1
  [PASS] disableAllHooks           not set
  [PASS] Mods rollout (cached)     on
  [PASS] Terminal colors           Windows Terminal (24-bit color)
  [WARN] Claude Desktop            app 2.7032.0.0 bundles Claude Code 2.1.280 (< 2.1.287): update Desktop
```

## 3. Install on Windows

### 3.1 Prerequisites

1. **Claude Code CLI.** Install or update the native build (don't use npm; the native installer keeps itself updated):

   ```powershell
   irm https://claude.ai/install.ps1 | iex
   claude update
   claude --version
   ```

   If `claude --version` prints something older than 2.1.287, an old npm copy may be shadowing the native one. Remove it with `npm uninstall -g @anthropic-ai/claude-code`.

2. **Sign in once.** Run `claude`, type `/login`, finish the browser sign-in, then `/exit`.
3. **Node.js** (`winget install OpenJS.NodeJS.LTS`) and **git** (`winget install Git.Git`), if the check script flagged them. Open a new terminal afterwards so `PATH` picks them up.
4. **Windows Terminal** (`winget install Microsoft.WindowsTerminal`) for full color. The legacy console host draws the HUD without its colors.

### 3.2 Install the mod (Claude Code CLI)

Start `claude` in Windows Terminal and run:

```
/plugin marketplace add chandan84/cache-time-pending-usage-limit-mod
/plugin install usage-hud@usage-hud-mods
/reload-plugins
```

Or from PowerShell, without opening a session:

```powershell
claude plugin marketplace add chandan84/cache-time-pending-usage-limit-mod
claude plugin install usage-hud@usage-hud-mods
```

The plugin installs at user scope, so it loads in every project. The band appears above the prompt the next time a session starts, or immediately after `/reload-plugins`.

### 3.3 Claude Desktop (Code tab)

1. **Update Desktop.** Desktop runs its own Claude Code from `%APPDATA%\Claude\claude-code\<version>\`. `npm` and `claude update` don't change that copy; only a Desktop update does. Use **Check for Updates** in the Claude app menu, install, then quit Desktop completely (including the system-tray icon) and reopen it.
2. **Confirm the bundled version** with the check script: the `Claude Desktop` line must read `PASS`. If it still reports a version below 2.1.287 after updating, no Desktop build with mod support has shipped yet. The mod stays installed and appears once one does.
3. **Install** the mod, if you didn't already in 3.2: open the **Code** tab, start a session, and run the three `/plugin` commands from 3.2 in its prompt. A CLI install counts too, since both read `~/.claude`.
4. **Start a new Code session.** The three cards appear above the chat input, drawn with SVG charts. If a Desktop build doesn't draw the band, the mod opens the same view as a pane after a few seconds.

## 4. Install on macOS

### 4.1 Prerequisites

1. **Claude Code CLI** (native build):

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   claude update
   claude --version
   ```

   With Homebrew: `brew install --cask claude-code`, then `brew upgrade --cask claude-code` to update.

2. **Sign in once.** Run `claude`, type `/login`, finish the browser sign-in, then `/exit`.
3. **Node.js** (`brew install node`) and **git** (`xcode-select --install`), if the check script flagged them.
4. **A 24-bit color terminal.** iTerm2, Ghostty, WezTerm, Kitty and the VS Code terminal all qualify. Apple's Terminal.app has 256 colors, so the palette is approximated there.

### 4.2 Install the mod (Claude Code CLI)

```
/plugin marketplace add chandan84/cache-time-pending-usage-limit-mod
/plugin install usage-hud@usage-hud-mods
/reload-plugins
```

Or from your shell:

```bash
claude plugin marketplace add chandan84/cache-time-pending-usage-limit-mod
claude plugin install usage-hud@usage-hud-mods
```

### 4.3 Claude Desktop (Code tab)

1. **Update Desktop:** **Claude → Check for Updates…**, install, then quit with **⌘Q** and reopen. Desktop's Claude Code lives in `~/Library/Application Support/Claude/claude-code/<version>/` and only changes with the app.
2. **Confirm** with `bash scripts/check-prereqs.sh`: the `Claude Desktop` line must read `PASS`.
3. **Install** from a Code-tab session with the `/plugin` commands in 4.2, unless you already installed from the CLI.
4. **Start a new Code session** to see the HUD.

## 5. Verify

1. In a new session, the band above the prompt shows three cards: **TODAY · ALL SESSIONS**, **CONTEXT WINDOW**, and **PROMPT CACHE**.
2. Send any prompt. When the answer arrives, the context meter fills, the cache card turns **● WARM** with a countdown, and **LAST TURN** shows that turn's tokens and cost.
3. Click **▲ Breakdown**, or run `/usage-hud`, to open the daily chart and per-session list: a pane on Desktop, above the cards in a terminal. Use **◄ Prev / Next ►** to move between days. It always starts closed.
4. `/plugin` lists `usage-hud` under **Installed**, and in a terminal session the line under its tabs reads `1 mod active · usage-hud`.
5. For a check that draws nothing, run this from a shell. It prints today's totals:

   ```bash
   claude -p "/usage-hud report"
   ```

   (In Git Bash, prefix it with `MSYS_NO_PATHCONV=1` so the shell doesn't turn `/usage-hud` into a file path.)

## 6. Configure

```
/plugin configure usage-hud@usage-hud-mods
```

| Option | Default | Meaning |
| :- | :- | :- |
| `context_soft_limit` | `240000` | Where the context meter turns from teal to hatched gray, marked by the amber **►** |
| `history_days` | `30` | Days in the daily chart |

From a shell: `echo '{"context_soft_limit":"200000","history_days":"30"}' | claude plugin configure usage-hud@usage-hud-mods --values-stdin` (values are strings). Restart the session to apply.

The cache card reads the TTL the API actually used. To get a 1-hour cache for the main conversation and subagents, set this in `~/.claude/settings.json`:

```json
{ "promptCacheTtl": "1h", "subagentPromptCacheTtl": "1h" }
```

## 7. Update and uninstall

```bash
claude plugin marketplace update usage-hud-mods
claude plugin update usage-hud@usage-hud-mods
```

Then run `/reload-plugins` in open sessions. To remove it:

```bash
claude plugin uninstall usage-hud@usage-hud-mods
claude plugin marketplace remove usage-hud-mods
```

The scanner cache lives in `~/.claude/usage-hud/`; delete that folder to remove it too.

## 8. Troubleshooting

| Symptom | Cause | Fix |
| :- | :- | :- |
| No band, and `/usage-hud` is an unknown command | Claude Code older than 2.1.287, or mods still off | `claude update`; start `claude` signed in once; rerun the check script |
| `hooks modules are turned off ... rollout switch was saved off` | An older Claude Code (often Desktop's bundled copy) cached the mods flag as off in `~/.claude.json` | Start the 2.1.287+ CLI once while signed in; it refreshes the flag. It can flip back while an older Desktop build runs, until Desktop updates |
| HUD works in the CLI but not in Desktop | Desktop bundles an older Claude Code | Update Desktop ([3.3](#33-claude-desktop-code-tab), [4.3](#43-claude-desktop-code-tab)) |
| Everything is white, including Claude's own colors | `NO_COLOR` is set in the environment | Remove it (`Remove-Item env:NO_COLOR` / `unset NO_COLOR`) and make sure your profile doesn't set it |
| Colors look washed out or banded | Terminal without 24-bit color (legacy Windows console, Terminal.app) | Use Windows Terminal, iTerm2, Ghostty, WezTerm or Kitty |
| Today card says **History needs Node.js on PATH** | `node` isn't reachable from Claude Code | Install Node 18+ and restart the session |
| Breakdown says **Not enough room** | The terminal is too short for the chart | Make the window taller, or run `/usage-hud pane` |
| Totals look low | Only Claude Code sessions have local transcripts; Desktop chat and claude.ai don't | Expected |
| Mod shows nothing at all in a Desktop WSL session | Plugins aren't available in WSL sessions | Use a local Windows session |

Mods log to Claude Code's debug log. Run `claude --debug` and look for lines that start with `usage-hud`.
