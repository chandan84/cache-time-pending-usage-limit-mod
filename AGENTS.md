# AGENTS.md

Guidance for AI coding agents (Claude Code, and any tool that reads `AGENTS.md`) working in this repository.

## What this is

A plugin marketplace (`.claude-plugin/marketplace.json`, name `usage-hud-mods`) holding one Claude Code **mod**, `usage-hud`, in `plugins/usage-hud/`. The mod draws three cards above the prompt (cross-session usage and cost, context window, prompt-cache countdown) and a daily/per-session breakdown. See `README.md` for what it shows.

## Installing it for a user

**Follow [INSTALL.md](INSTALL.md).** It covers Windows and macOS, the Claude Code CLI and the Claude Desktop Code tab, configuration, updates, and troubleshooting. Always start with the read-only prerequisite check and fix every `FAIL` it reports:

- Windows: `powershell -ExecutionPolicy Bypass -File scripts\check-prereqs.ps1`
- macOS / Linux: `bash scripts/check-prereqs.sh`

Things an agent can't do for the user, and should hand back to them:

- **Sign in** (`/login` opens a browser).
- **Update Claude Desktop**: the app's own **Check for Updates**. Desktop bundles its own Claude Code; `npm` and `claude update` don't change it.

Never flip `cachedGrowthBookFeatures.tengu_plugin_hooks_modules` in `~/.claude.json` by hand. It's Anthropic's remote switch; a signed-in start of Claude Code 2.1.287+ refreshes it.

## Layout

| Path | What it is |
| :- | :- |
| `plugins/usage-hud/.claude-plugin/plugin.json` | Manifest, including `userConfig` (`context_soft_limit`, `history_days`) |
| `plugins/usage-hud/hooks/hooks.json` | Points at the hooks module |
| `plugins/usage-hud/hooks/register.js` | Hooks module: events, live state, commands, rendering entry points. The only file that calls the mods API (`$`) |
| `plugins/usage-hud/lib/view.js` | Pure element-tree builders for the band and pane: matte palette `P`, terminal cell painting, Desktop SVGs |
| `plugins/usage-hud/lib/ledger.js` | Pure transcript parser and aggregator (dedup, per-day/per-session sums, cache TTL and warm streaks) |
| `plugins/usage-hud/lib/pricing.js` | Model prices, context windows, usage normalization |
| `plugins/usage-hud/scripts/scan.mjs` | Node scanner the mod runs through `$.process.run`; incremental, cached in `~/.claude/usage-hud/` |
| `plugins/usage-hud/tests/` | `*.test.ts` engine tests (`claude plugin test`) and `node/` engine-free tests |
| `scripts/check-prereqs.{ps1,sh}` | Prerequisite checks for users |
| `tools/preview.mjs` | Renders the Desktop look to HTML with live data, for reviewing visuals |

## Working on the mod

```bash
claude plugin validate ./plugins/usage-hud            # static analysis: hooks and mods API calls
cd plugins/usage-hud && claude plugin test             # engine tests
node --test plugins/usage-hud/tests/node/lib.test.mjs  # engine-free tests
node tools/preview.mjs                                 # writes preview.html (Desktop look)
claude --plugin-dir ./plugins/usage-hud                # live session with hot reload
```

Run all three test and validation commands before committing. Rules that keep the mod loadable (from Claude Code's static analysis):

- Only `hooks/register.js` touches `$`. Write every call in full (`$.ui.invalidate(...)`). Never alias or destructure `$` or a namespace, and only pass `$` to top-level functions in the same file.
- `lib/` modules stay pure ES modules with no Node APIs, because the hooks module imports them.
- Event names in `on(...)` are string literals.
- Element props must be ones the element accepts; strip `undefined` (see `clean()` in `view.js`).
- The band must fit `e.props.maxRows`, so the three cards never scroll away. A test enforces this.
- Visual changes: keep the matte palette in `P`, use background-colored cells (not line art) in the terminal and SVG on Desktop, and check both `surface: 'terminal'` and `'desktop'`.

Bump `version` in `plugins/usage-hud/.claude-plugin/plugin.json` for every release. Installed copies are cached by version, so users won't get changes otherwise.
