# usage-hud: a Claude Code mod

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that puts a three-card HUD in the band directly above the prompt, in the **Claude Code CLI** and in the **Code tab of Claude Desktop**.

![usage-hud in Claude Desktop: the three cards above the prompt, and the expanded daily and per-session breakdown](docs/preview-desktop.png)

| Card | What it shows |
| :- | :- |
| **Today · all sessions** | Tokens and API-equivalent cost **today across every local session**, a 14-day trend, and the all-time total. **▲ Breakdown** opens a 30-day chart (cost or tokens) above the cards, with the **per-session split** for the selected day. **◄ ►** moves between days, subagent spend shows in violet, and this session in coral. |
| **Context window** | This conversation's context against the model's window. The meter is **teal up to a 240K soft limit**, marked with an amber **►**; anything past it is **hatched gray** as "not optimal". Shows tokens free and the distance to or past the soft limit. |
| **Prompt cache** | The TTL the API actually wrote (1h or 5m), when the current **warm streak started**, the last cache hit, a **countdown** to expiry from the last request (whole minutes, then m:ss in the last two; teal → amber → coral, with a ring gauge in Desktop), and the **last turn's tokens and cost**, subagents included. |

Desktop draws each card as one rounded SVG image (gradient columns, an area sparkline, a ring gauge, a gradient context meter) with its own typography, and redraws only when a figure changes, so nothing flickers. The terminal draws the same cards with solid color-filled cells and half-cell edges on a matte card surface, in 24-bit color. In a terminal too short for the breakdown, **▲ Breakdown** and `/usage-hud` open it as a pane.

## Install

**Full instructions for Windows and macOS, CLI and Desktop: [INSTALL.md](INSTALL.md).**

Quick version, for Claude Code 2.1.287+ with Node.js 18+ and git:

```
/plugin marketplace add chandan84/cache-time-pending-usage-limit-mod
/plugin install usage-hud@usage-hud-mods
/reload-plugins
```

Check a machine first with `scripts/check-prereqs.ps1` (Windows) or `scripts/check-prereqs.sh` (macOS).

## Commands

| Command | What it does |
| :- | :- |
| `/usage-hud` | Toggle the daily/per-session breakdown above the cards |
| `/usage-hud pane` | Open the breakdown in a pane |
| `/usage-hud report` | Print a text summary (works where nothing is drawn, such as `claude -p`) |
| `/usage-hud refresh` | Re-read history now |

Options (`/plugin configure usage-hud@usage-hud-mods`): `context_soft_limit` (default `240000`) and `history_days` (default `30`).

## How it works

- **Live figures** come from the [`turn.step`](https://code.claude.com/docs/en/plugins/mods/events#follow-a-turn) event: each model request updates the context meter, the cache timer, and the running turn's cost. `$.session.usage()` supplies the context window size.
- **Cross-session history** comes from Claude Code's transcripts in `~/.claude/projects/**/*.jsonl`, which the CLI and Desktop's Code tab both write (subagents included). A hooks module has no file APIs of its own and `$.fs.read` stops at 4 MiB, so the mod runs [`scripts/scan.mjs`](plugins/usage-hud/scripts/scan.mjs) through `$.process.run`. The scanner tails each file from its last offset and caches parsed records in `~/.claude/usage-hud/`, so a refresh takes milliseconds. It runs at session start, after each turn, and every 30 seconds.
- **Dedup**: one API response is written as several transcript lines, each repeating its usage. Records are keyed on message id + request id, and the final line wins.
- **Cost** is the API list-price equivalent ([`lib/pricing.js`](plugins/usage-hud/lib/pricing.js)): cache writes at 1.25× input (5m) or 2× input (1h), cache reads at the model's cache-read rate, fast mode at 2×. On a subscription you aren't billed per token; the figure is the value of what you used.
- **Cache timing**: the TTL comes from the API's own `ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` split, falling back to `promptCacheTtl`. Each request resets the timer, and a gap longer than the TTL starts a new warm streak.

**What it reaches:** it reads transcripts under `~/.claude/projects`, writes its cache under `~/.claude/usage-hud/`, runs `node`, and keeps two UI preferences in `$.store`. It makes no network requests and doesn't touch prompts or tool calls. Run `claude plugin validate ./plugins/usage-hud` to list its hooks and calls.

**Not covered:** Claude Desktop's chat tab and claude.ai keep no local transcripts.

## Develop

```bash
claude plugin validate ./plugins/usage-hud              # hooks and mods API calls
cd plugins/usage-hud && claude plugin test               # engine tests
node --test plugins/usage-hud/tests/node/lib.test.mjs    # engine-free tests
node tools/preview.mjs                                   # Desktop look as HTML, with your data
claude --plugin-dir ./plugins/usage-hud                  # live session, hot reload
```

Repository conventions for agents are in [AGENTS.md](AGENTS.md). Tested with Claude Code 2.1.288 on Windows 10 in Windows Terminal and the legacy console. The Desktop rendering is checked with the engine's Desktop surface tests and `tools/preview.mjs`, pending a Desktop build that bundles Claude Code 2.1.287+.

## License

MIT
