# usage-hud: a Claude Code mod

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that draws a three-box HUD in the band directly above the prompt. It works in the Claude Code CLI and in the Code tab of Claude Desktop.

```
┌ Today · all sessions  ▲ Breakdown ┐┌ Context 251K / 1.00M · 25% ──────────┐┌ Cache 1h ● warm  52:10 left ────────────┐
│ $6.72  13.3M tok                  ││ ███████►██░░░░░░░░░░░░░░░░░░░░░░░    ││ start 09:42 · last 10:48 · ends 11:48  │
│ ·····▂▁▃█  14d · all time $7.65   ││ 749K left · 11K past 240K            ││ Last turn 937K tok · $0.571 · 6 req    │
└───────────────────────────────────┘└──────────────────────────────────────┘└────────────────────────────────────────┘
```

| Box | What it shows |
| :- | :- |
| **Usage** (left) | Tokens and API-equivalent cost **today across every local session**, a 14-day sparkline, and the all-time total. **▲ Breakdown** expands a daily chart (cost or tokens, 30 days) above the band, with **per-session distribution** for the selected day (◄ ► to page through days, subagent spend called out). |
| **Context** (middle) | The current conversation's context use against the model's window. The bar is **green up to a 240K soft limit** (marked by a **►** arrow); anything past it is shaded **gray** as "not optimal". Shows tokens left and distance to/past the soft limit. |
| **Cache** (right) | Prompt-cache TTL in use (1h or 5m, as the API actually wrote it), when the current **warm streak started**, the last cache hit, **time remaining** before the cache goes cold (live countdown, amber when close, red when expired), and the **last turn's tokens and cost** (subagents included). |

In Desktop the meter and the daily chart are drawn as SVG (hover the bars for exact numbers); in the terminal they're drawn with block characters.

## Install

Requires Claude Code **v2.1.287 or later** (mods are on by default from that version) and **Node.js** on `PATH` (used to read transcripts for cross-session history; the live boxes work without it).

In a Claude Code session (CLI or Desktop's Code tab):

```
/plugin marketplace add chandan84/cache-time-pending-usage-limit-mod
/plugin install usage-hud@usage-hud-mods
/reload-plugins
```

To try it for one session without installing:

```bash
git clone https://github.com/chandan84/cache-time-pending-usage-limit-mod
claude --plugin-dir ./cache-time-pending-usage-limit-mod/plugins/usage-hud
```

### Options

`/plugin configure usage-hud@usage-hud-mods`:

| Option | Default | Meaning |
| :- | :- | :- |
| `context_soft_limit` | `240000` | Where the context bar turns from green to gray |
| `history_days` | `30` | Days in the breakdown chart |

### Commands

| Command | What it does |
| :- | :- |
| `/usage-hud` | Toggle the daily/per-session breakdown above the band |
| `/usage-hud pane` | Open the breakdown in a pane (useful in narrow terminals) |
| `/usage-hud report` | Print a text summary (works where nothing is drawn, e.g. `claude -p`) |
| `/usage-hud refresh` | Re-read history now |

Outside Claude Code: `node plugins/usage-hud/scripts/scan.mjs --report` prints the daily and per-session table.

## How it works

- **Live session figures** come from the [`turn.step`](https://code.claude.com/docs/en/plugins/mods/events#follow-a-turn) event: each model request's usage updates the context bar, the cache timer, and the running turn's cost immediately. `$.session.usage()` supplies the model's context window.
- **Cross-session history** comes from Claude Code's transcripts in `~/.claude/projects/**/*.jsonl`, which both the CLI and Desktop's Code tab write (subagent transcripts included). A hooks module has no file APIs of its own and `$.fs.read` stops at 4 MiB, so the mod runs `scripts/scan.mjs` through `$.process.run`. The scanner tails each file from its last offset and caches parsed records in `~/.claude/usage-hud/scan-cache.json`, so a refresh costs milliseconds. It runs at session start, 1.5 s after each turn, and every 30 s (other sessions' activity).
- **Dedup**: Claude Code writes one API response as several transcript lines (one per content block), each repeating the usage. Records are keyed on message id + request id and the final line wins.
- **Cost** is the API list price equivalent ([`lib/pricing.js`](plugins/usage-hud/lib/pricing.js)): cache writes at 1.25× input (5m) or 2× input (1h), cache reads at the model's cache-read rate, fast mode at 2×. On a subscription you are not billed per token; the figure shows the value of what you used.
- **Cache timing**: the TTL is read from the API's own `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` split in the transcript, falling back to `promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL`. Each request resets the timer; a gap longer than the TTL starts a new warm streak.

What it reaches: it reads transcripts under `~/.claude/projects`, writes its cache under `~/.claude/usage-hud/`, runs `node`, and stores two UI preferences in `$.store`. It makes no network requests and doesn't touch prompts or tool calls. Check with `claude plugin validate ./plugins/usage-hud`.

Not covered: Claude Desktop **chat** conversations (non-Code tab) and claude.ai usage have no local transcripts.

## Develop

```bash
claude plugin validate ./plugins/usage-hud        # static check of hooks and calls
cd plugins/usage-hud && claude plugin test         # engine tests (render, turn.step, commands)
node --test plugins/usage-hud/tests/node/lib.test.mjs   # engine-free tests (ledger, pricing, view)
```

Tested live in the Claude Code 2.1.288 CLI on Windows 10 (engine tests, `claude plugin validate`, and an interactive session). In the legacy Windows console (conhost) 24-bit colors fall back to plain text; Windows Terminal shows them.

## License

MIT
