<#
.SYNOPSIS
  Checks that this machine can run the usage-hud Claude Code mod (Windows).

.DESCRIPTION
  Read-only: it runs version and status commands and reads settings files, and changes nothing.
  Exit code 0 when every required check passes, 1 otherwise.

  powershell -ExecutionPolicy Bypass -File scripts\check-prereqs.ps1
#>

$ErrorActionPreference = 'Continue'
$MinClaude = [version]'2.1.287'
$MinNode = 18
$failures = 0
$warnings = 0

function Say($status, $name, $detail) {
  $color = @{ PASS = 'Green'; FAIL = 'Red'; WARN = 'Yellow'; INFO = 'Cyan' }[$status]
  Write-Host ('  [{0}] ' -f $status) -ForegroundColor $color -NoNewline
  Write-Host ('{0,-26}' -f $name) -NoNewline
  Write-Host $detail -ForegroundColor DarkGray
}
function Fail($n, $d) { $script:failures++; Say 'FAIL' $n $d }
function Warn($n, $d) { $script:warnings++; Say 'WARN' $n $d }
function Pass($n, $d) { Say 'PASS' $n $d }
function Info($n, $d) { Say 'INFO' $n $d }
function Ver($s) { if ($s -match '(\d+\.\d+\.\d+)') { [version]$Matches[1] } else { $null } }

Write-Host ''
Write-Host 'usage-hud prerequisite check (Windows)' -ForegroundColor White
Write-Host ''

# 1. Claude Code CLI
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  Fail 'Claude Code CLI' 'not on PATH. Install: irm https://claude.ai/install.ps1 | iex'
} else {
  $v = Ver ((& claude --version 2>$null) -join ' ')
  if ($v -and $v -ge $MinClaude) { Pass 'Claude Code CLI' "$v at $($claude.Source)" }
  elseif ($v) { Fail 'Claude Code CLI' "$v is older than $MinClaude. Run: claude update" }
  else { Fail 'Claude Code CLI' 'could not read the version' }

  $others = @(Get-Command claude -All -ErrorAction SilentlyContinue | Select-Object -Skip 1)
  if ($others.Count) { Warn 'Other claude on PATH' (($others | ForEach-Object Source) -join '; ') + ' (shadowed; consider removing)' }

  # 2. Signed in
  $auth = (& claude auth status 2>$null) -join "`n"
  if ($auth -match '"loggedIn":\s*true') { Pass 'Signed in' 'claude auth status: loggedIn' }
  else { Fail 'Signed in' 'run `claude` once and use /login (mods turn on after the first signed-in start)' }

  # 8. Plugin installed
  $list = (& claude plugin list 2>$null) -join "`n"
  if ($list -match 'usage-hud@[\w-]+[\s\S]*?Status:\s*\S*\s*enabled') { Pass 'usage-hud installed' 'enabled (claude plugin list)' }
  elseif ($list -match 'usage-hud@') { Warn 'usage-hud installed' 'installed but not enabled: /plugin -> Installed -> enable' }
  else { Info 'usage-hud installed' 'not yet. See INSTALL.md step 2' }
}

# 3. Node.js (reads transcripts for cross-session history)
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js' "not on PATH. Install Node $MinNode+ (winget install OpenJS.NodeJS.LTS)" }
else {
  $nv = (& node --version) -replace '^v', ''
  if ([int]($nv.Split('.')[0]) -ge $MinNode) { Pass 'Node.js' "v$nv" } else { Fail 'Node.js' "v$nv is older than $MinNode" }
}

# 4. git (to add the marketplace from GitHub)
if (Get-Command git -ErrorAction SilentlyContinue) { Pass 'git' ((& git --version) -join '') }
else { Fail 'git' 'not on PATH. Install Git for Windows (winget install Git.Git)' }

# 5. Settings that switch mods off
$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
if (Test-Path $settingsPath) {
  try {
    $s = Get-Content $settingsPath -Raw | ConvertFrom-Json
    if ($s.disableAllHooks -eq $true) { Fail 'disableAllHooks' "true in ${settingsPath}: mods can't run" } else { Pass 'disableAllHooks' 'not set' }
    if ($s.promptCacheTtl) { Info 'promptCacheTtl' $s.promptCacheTtl } else { Info 'promptCacheTtl' 'not set (subscription default: 1h main / 5m subagents)' }
  } catch { Warn 'settings.json' "could not parse $settingsPath" }
} else { Pass 'disableAllHooks' 'no user settings file' }

$cfg = Join-Path $env:USERPROFILE '.claude.json'
if (Test-Path $cfg) {
  try {
    $flag = (Get-Content $cfg -Raw | ConvertFrom-Json).cachedGrowthBookFeatures.tengu_plugin_hooks_modules
    if ($flag -eq $false) { Warn 'Mods rollout (cached)' 'off: start `claude` (2.1.287+, signed in) once to refresh it' }
    elseif ($flag -eq $true) { Pass 'Mods rollout (cached)' 'on' }
  } catch { }
}

# 6. Terminal color
if ($env:NO_COLOR) { Warn 'NO_COLOR' 'is set: Claude Code and the HUD draw without color. Remove it' }
elseif ($env:WT_SESSION) { Pass 'Terminal colors' 'Windows Terminal (24-bit color)' }
elseif ($env:TERM_PROGRAM -eq 'vscode') { Pass 'Terminal colors' 'VS Code terminal (24-bit color)' }
else { Warn 'Terminal colors' 'legacy console: use Windows Terminal for the full-color HUD' }

# 7. Claude Desktop (optional)
$desktopCode = Join-Path $env:APPDATA 'Claude\claude-code'
$desktopPkg = Get-AppxPackage -Name 'Claude*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($desktopPkg -or (Test-Path $desktopCode)) {
  $app = if ($desktopPkg) { $desktopPkg.Version } else { 'installed' }
  $bundled = Get-ChildItem $desktopCode -Directory -ErrorAction SilentlyContinue | ForEach-Object { Ver $_.Name } | Where-Object { $_ } | Sort-Object -Descending | Select-Object -First 1
  if ($bundled -and $bundled -ge $MinClaude) { Pass 'Claude Desktop' "app $app, Claude Code ${bundled}: the HUD loads in the Code tab" }
  elseif ($bundled) { Warn 'Claude Desktop' "app $app bundles Claude Code $bundled (< $MinClaude): update Desktop (Check for Updates) for the HUD in the Code tab" }
  else { Info 'Claude Desktop' "app ${app}: open a Code session once so it downloads Claude Code" }
} else { Info 'Claude Desktop' 'not installed (optional)' }

Write-Host ''
if ($failures) { Write-Host "  $failures required check(s) failed, $warnings warning(s)." -ForegroundColor Red; exit 1 }
Write-Host "  All required checks passed ($warnings warning(s))." -ForegroundColor Green
exit 0
