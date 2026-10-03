#!/usr/bin/env bash
# Checks that this machine can run the usage-hud Claude Code mod (macOS, also Linux).
# Read-only: runs version and status commands and reads settings files; changes nothing.
# Exit code 0 when every required check passes, 1 otherwise.
#
#   bash scripts/check-prereqs.sh

MIN_CLAUDE="2.1.287"
MIN_NODE=18
failures=0
warnings=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; C=$'\033[36m'; D=$'\033[90m'; B=$'\033[1m'; Z=$'\033[0m'
else
  G=; R=; Y=; C=; D=; B=; Z=
fi

say()  { printf "  %s[%s]%s %-26s %s%s%s\n" "$1" "$2" "$Z" "$3" "$D" "$4" "$Z"; }
pass() { say "$G" PASS "$1" "$2"; }
fail() { failures=$((failures + 1)); say "$R" FAIL "$1" "$2"; }
warn() { warnings=$((warnings + 1)); say "$Y" WARN "$1" "$2"; }
info() { say "$C" INFO "$1" "$2"; }

ver()  { grep -oE '[0-9]+\.[0-9]+\.[0-9]+' <<<"$1" | head -1; }
# ver_ge A B: true when A >= B
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

echo
echo "${B}usage-hud prerequisite check ($(uname -s))${Z}"
echo

# 1. Claude Code CLI
if ! command -v claude >/dev/null 2>&1; then
  fail "Claude Code CLI" "not on PATH. Install: curl -fsSL https://claude.ai/install.sh | bash"
else
  v="$(ver "$(claude --version 2>/dev/null)")"
  if [ -n "$v" ] && ver_ge "$v" "$MIN_CLAUDE"; then pass "Claude Code CLI" "$v at $(command -v claude)"
  elif [ -n "$v" ]; then fail "Claude Code CLI" "$v is older than $MIN_CLAUDE. Run: claude update"
  else fail "Claude Code CLI" "could not read the version"; fi

  n_claude="$(type -a claude 2>/dev/null | wc -l | tr -d ' ')"
  [ "${n_claude:-1}" -gt 1 ] && warn "Other claude on PATH" "$(type -a claude | tail -n +2 | tr '\n' ' ')(shadowed)"

  # 2. Signed in
  if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then pass "Signed in" "claude auth status: loggedIn"
  else fail "Signed in" "run \`claude\` once and use /login (mods turn on after the first signed-in start)"; fi

  # 8. Plugin installed
  plist="$(claude plugin list 2>/dev/null)"
  if grep -A4 'usage-hud@' <<<"$plist" | grep -q 'enabled'; then pass "usage-hud installed" "enabled (claude plugin list)"
  elif grep -q 'usage-hud@' <<<"$plist"; then warn "usage-hud installed" "installed but not enabled: /plugin -> Installed -> enable"
  else info "usage-hud installed" "not yet. See INSTALL.md step 2"; fi
fi

# 3. Node.js
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js" "not on PATH. Install Node $MIN_NODE+ (brew install node)"
else
  nv="$(node --version | sed 's/^v//')"
  if [ "${nv%%.*}" -ge "$MIN_NODE" ]; then pass "Node.js" "v$nv"; else fail "Node.js" "v$nv is older than $MIN_NODE"; fi
fi

# 4. git
if command -v git >/dev/null 2>&1; then pass "git" "$(git --version)"
else fail "git" "not on PATH. Install: xcode-select --install"; fi

# 5. Settings that switch mods off
settings="$HOME/.claude/settings.json"
if [ -f "$settings" ] && command -v node >/dev/null 2>&1; then
  dah="$(node -e 'try{const s=require(process.argv[1]);process.stdout.write(String(s.disableAllHooks===true))}catch{process.stdout.write("err")}' "$settings")"
  ttl="$(node -e 'try{const s=require(process.argv[1]);process.stdout.write(s.promptCacheTtl||"")}catch{}' "$settings")"
  case "$dah" in
    true) fail "disableAllHooks" "true in $settings: mods can't run" ;;
    err)  warn "settings.json" "could not parse $settings" ;;
    *)    pass "disableAllHooks" "not set" ;;
  esac
  info "promptCacheTtl" "${ttl:-not set (subscription default: 1h main / 5m subagents)}"
else
  pass "disableAllHooks" "no user settings file"
fi
if [ -f "$HOME/.claude.json" ] && command -v node >/dev/null 2>&1; then
  flag="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write(String((j.cachedGrowthBookFeatures||{}).tengu_plugin_hooks_modules))}catch{}' "$HOME/.claude.json")"
  [ "$flag" = "false" ] && warn "Mods rollout (cached)" "off: start \`claude\` (2.1.287+, signed in) once to refresh it"
  [ "$flag" = "true" ] && pass "Mods rollout (cached)" "on"
fi

# 6. Terminal color
if [ -n "${NO_COLOR:-}" ]; then warn "NO_COLOR" "is set: Claude Code and the HUD draw without color. Unset it"
elif [ "${COLORTERM:-}" = "truecolor" ] || [ "${COLORTERM:-}" = "24bit" ]; then pass "Terminal colors" "24-bit (${TERM_PROGRAM:-$TERM})"
elif [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ]; then warn "Terminal colors" "Terminal.app has 256 colors: iTerm2, Ghostty, WezTerm or Kitty show the full palette"
else warn "Terminal colors" "COLORTERM is not truecolor: colors will be approximated"; fi

# 7. Claude Desktop (optional)
case "$(uname -s)" in
  Darwin) app="/Applications/Claude.app"; code_dir="$HOME/Library/Application Support/Claude/claude-code" ;;
  *)      app=""; code_dir="${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude-code" ;;
esac
if { [ -n "$app" ] && [ -d "$app" ]; } || [ -d "$code_dir" ]; then
  appv=""
  [ -n "$app" ] && [ -d "$app" ] && appv="$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
  bundled="$(ls "$code_dir" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
  if [ -n "$bundled" ] && ver_ge "$bundled" "$MIN_CLAUDE"; then pass "Claude Desktop" "app ${appv:-installed}, Claude Code $bundled: the HUD loads in the Code tab"
  elif [ -n "$bundled" ]; then warn "Claude Desktop" "app ${appv:-installed} bundles Claude Code $bundled (< $MIN_CLAUDE): update Desktop (Check for Updates)"
  else info "Claude Desktop" "app ${appv:-installed}: open a Code session once so it downloads Claude Code"; fi
else
  info "Claude Desktop" "not installed (optional)"
fi

echo
if [ "$failures" -gt 0 ]; then echo "  ${R}$failures required check(s) failed, $warnings warning(s).${Z}"; exit 1; fi
echo "  ${G}All required checks passed ($warnings warning(s)).${Z}"
exit 0
