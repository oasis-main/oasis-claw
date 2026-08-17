<#
.SYNOPSIS
  Bootstraps a fresh Windows VDI with the CLI dev tools the oasis-claw fleet
  needs: Claude Code and GitHub CLI, plus optional Git for Windows. Also
  reports (diagnostic only, installs nothing) whether this machine is ready
  for a Podman/WSL2 container runtime, and separates what a local admin can
  self-serve from what only the VDI host's own administrator can fix.

.DESCRIPTION
  Self-locating and cwd-independent: every path this script touches is
  either a fixed absolute path (-Root) or derived from $PSScriptRoot, never
  from the caller's current directory. Running it from C:\, from a mapped
  network drive, or double-clicked from Explorer all behave identically.

  Safe to re-run. Every install step checks for an existing, working install
  first and skips it — this is meant to be run again later to pick up newly
  available tools (e.g. after IT opens a firewall exception), not just once.

  Does not touch credentials. `claude` login and `gh auth login` are both
  interactive, browser-involved steps left for the operator to run by hand
  after this script finishes — this script only gets the binaries in place.

  The Podman/WSL2 readiness section never installs or enables anything —
  enabling Windows features needs a reboot, and nested virtualization can
  only be turned on by whoever administers the VDI host, never from inside
  this guest. It only reports which pile each blocker falls into.

.PARAMETER Root
  Persistent root directory for oasis-claw tooling on this machine. Defaults
  to C:\oasis-x. Logs and a placeholder workspace directory are created
  under here; this script itself is expected to already be sitting in
  <Root>\scripts (see the companion setup commands), but does not require
  that -- it locates itself via $PSScriptRoot regardless of where it runs
  from.

.PARAMETER WorkspaceName
  Name of the placeholder workspace directory created under -Root, for
  whatever gets transferred to this machine next (a bot's own source drop,
  future install scripts, etc.) -- this script has no opinion on which bot
  or project that is. Defaults to "workspace"; pass the actual name at
  invocation time, e.g. -WorkspaceName my-bot.

.PARAMETER CheckOnly
  Run every diagnostic check (PowerShell version, execution policy, winget
  presence, network reachability, existing installs) and print a report.
  Installs nothing. Use this first on an unfamiliar machine, the same way
  you'd run a "doctor" command before "install" on the Linux/macOS side of
  this repo.

.PARAMETER SkipGitForWindows
  Skip installing Git for Windows. Claude Code's own docs recommend it so
  Claude Code can use the Bash tool on native Windows; without it, Claude
  Code falls back to PowerShell as its shell tool, which still works but
  behaves differently for anything scripted. Default is to install it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\bootstrap-dev-tools.ps1 -CheckOnly
  powershell -ExecutionPolicy Bypass -File .\bootstrap-dev-tools.ps1
#>

[CmdletBinding()]
param(
    [string]$Root = "C:\oasis-x",
    [string]$WorkspaceName = "workspace",
    [switch]$CheckOnly,
    [switch]$SkipGitForWindows
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Self-location. Do not use Get-Location / relative paths anywhere below --
# $PSScriptRoot is where THIS FILE lives, independent of the caller's cwd.
# ---------------------------------------------------------------------------
$ScriptRoot = $PSScriptRoot
if ([string]::IsNullOrEmpty($ScriptRoot)) {
    # Falls back to the invoked file's own directory if $PSScriptRoot is
    # empty (can happen when a script is dot-sourced or pasted directly
    # into a terminal rather than run as a .ps1 file). Not expected in
    # normal use here, but fail loud with a clear reason rather than
    # silently resolving against whatever the cwd happens to be.
    if ($MyInvocation.MyCommand.Path) {
        $ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    } else {
        throw "Cannot determine this script's own directory. Save it to a .ps1 file and run it directly (not pasted into a terminal) so path resolution stays cwd-independent."
    }
}

$LogDir = Join-Path $Root "logs"
$WorkspaceDir = Join-Path $Root $WorkspaceName
$WorkspaceIncoming = Join-Path $WorkspaceDir "incoming"
$Timestamp = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
$LogFile = Join-Path $LogDir "bootstrap-dev-tools-$Timestamp.log"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $line = "[{0}] {1}" -f $Level, $Message
    Write-Host $line
    if (Test-Path $LogDir) {
        Add-Content -Path $LogFile -Value $line
    }
}

function Test-CommandVersion {
    # Returns the version string if the command exists and runs cleanly,
    # otherwise $null. Never throws -- absence of a tool is a normal,
    # expected state on a fresh machine, not a script error.
    param([string]$Command, [string]$VersionArg = "--version")
    $cmd = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    try {
        $out = & $Command $VersionArg 2>&1 | Select-Object -First 1
        return "$out"
    } catch {
        return $null
    }
}

function Test-HttpsReachable {
    # A real HTTPS GET through whatever proxy/firewall is in front of this
    # box, not just a TCP port probe -- corporate proxies frequently accept
    # the TCP handshake and then reset or MITM-fail the TLS layer, which
    # Test-NetConnection alone would not catch.
    #
    # Deliberately GET, not HEAD, and deliberately the EXACT URL this script
    # goes on to actually use -- not a bare domain root. Verified against the
    # real endpoints: claude.ai's root path (/) returns 403 to a HEAD
    # request (WAF behavior), while the real install endpoint,
    # https://claude.ai/install.ps1, returns 200/302 cleanly to both GET and
    # HEAD. Probing the root would have reported a false "blocked" here even
    # though the actual install command works fine -- probe what you're
    # really going to use, not a proxy for it.
    #
    # Any HTTP response (even a 4xx/5xx from the server itself) means the
    # network path is open; only a connection-level failure (DNS, TCP
    # refused/reset, TLS failure, timeout) means actually blocked.
    #
    # Checks the exception's Response property dynamically (via
    # PSObject.Properties) rather than catching a specific exception type:
    # Windows PowerShell 5.1 (.NET Framework, the built-in default on
    # Windows 10) throws System.Net.WebException on an HTTP error status,
    # while PowerShell 7+ (.NET Core) throws
    # Microsoft.PowerShell.Commands.HttpResponseException instead -- both
    # happen to expose a Response property, so duck-typing works on either
    # engine without needing to know in advance which one is running this
    # script.
    param([string]$Uri)
    try {
        Invoke-WebRequest -Uri $Uri -TimeoutSec 8 -UseBasicParsing | Out-Null
        return $true
    } catch {
        $hasResponse = $_.Exception.PSObject.Properties.Name -contains "Response" -and $_.Exception.Response
        return [bool]$hasResponse
    }
}

function Update-SessionPath {
    # A newly-installed tool's directory may already be on the machine-wide
    # or user PATH (winget and the native Claude Code installer both update
    # the registry), but THIS process's in-memory $env:Path was captured at
    # shell start and won't see it without re-reading the registry. Without
    # this, the verification step right after an install would wrongly
    # report the tool as still missing until the operator opens a new
    # terminal.
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

# ---------------------------------------------------------------------------
# Doctor: report before touching anything. Run this section every time,
# even in install mode -- CheckOnly just stops before the install section.
# ---------------------------------------------------------------------------

Write-Log "=== bootstrap-dev-tools: diagnostics ==="
Write-Log "script location : $ScriptRoot"
Write-Log "root            : $Root"
Write-Log "PowerShell      : $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
Write-Log "OS              : $([System.Environment]::OSVersion.VersionString)"

$execPolicy = Get-ExecutionPolicy
Write-Log "execution policy: $execPolicy"
if ($execPolicy -eq "Restricted" -or $execPolicy -eq "AllSigned") {
    Write-Log "This process is already running (you invoked it with -ExecutionPolicy Bypass or similar), but the machine-wide default policy above may block OTHER unsigned scripts later. That is a policy decision for whoever administers this VDI, not something this script changes." "WARN"
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Log "elevated        : $isAdmin"

$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
Write-Log "winget present  : $hasWinget"

Write-Log "--- network reachability (real HTTPS GET to the exact URLs used below, not domain roots or a port probe) ---"
$reach = [ordered]@{
    "claude.ai/install.ps1 (Claude Code native installer)" = "https://claude.ai/install.ps1"
    "github.com (GitHub CLI manual-download fallback)"      = "https://github.com/cli/cli/releases/latest"
}
$reachResults = @{}
foreach ($name in $reach.Keys) {
    $ok = Test-HttpsReachable -Uri $reach[$name]
    $reachResults[$name] = $ok
    Write-Log "  $name : $(if ($ok) {'reachable'} else {'BLOCKED or unreachable'})"
}

Write-Log "--- existing installs ---"
$claudeVersion = Test-CommandVersion -Command "claude"
$ghVersion = Test-CommandVersion -Command "gh"
$gitVersion = Test-CommandVersion -Command "git"
$podmanVersion = Test-CommandVersion -Command "podman"
Write-Log "  claude : $(if ($claudeVersion) { $claudeVersion } else { 'not found' })"
Write-Log "  gh     : $(if ($ghVersion) { $ghVersion } else { 'not found' })"
Write-Log "  git    : $(if ($gitVersion) { $gitVersion } else { 'not found (optional)' })"
Write-Log "  podman : $(if ($podmanVersion) { $podmanVersion } else { 'not found' })"

# ---------------------------------------------------------------------------
# Podman/WSL2 readiness -- DIAGNOSTIC ONLY. This section never installs or
# enables anything; it exists to sort what's blocking Podman into two piles:
# what this machine's own user can self-serve (if elevated) versus what only
# whoever administers this VDI's underlying hypervisor can fix. Wrapped in
# its own try/catch so a problem here (unexpected Windows build, a cmdlet
# missing on a locked-down image) reports a warning instead of stopping the
# Claude Code / GitHub CLI / Git install above, which is already verified
# working independent of any of this.
#
# Two different failure classes, and only one of them is fixable from
# inside this script or even by a local admin on this machine:
#
#   1. Guest-level (this Windows install): the WSL and Virtual Machine
#      Platform optional features, and the Windows edition (Podman's own
#      docs call for Pro/Enterprise/Education). A local administrator CAN
#      self-serve these, unless a corporate Group Policy blocks Windows
#      feature changes even for admins -- which itself would need IT.
#   2. Host-level (the hypervisor this VDI runs on, Hyper-V/VMware/other):
#      whether the VM is exposed the CPU's virtualization extensions at
#      all ("nested virtualization"). NOTHING inside this guest -- not
#      local admin, not this script, not a reboot -- can turn this on.
#      Only whoever administers the VDI host itself can (e.g., on Hyper-V:
#      Set-VMProcessor -VMName <name> -ExposeVirtualizationExtensions $true,
#      run ON THE HOST). This is almost always the real approval-needed
#      item on a VDI, since the guest OS has no way to grant itself this.
# ---------------------------------------------------------------------------

Write-Log "--- Podman / WSL2 readiness (diagnostic only -- nothing enabled or installed by this section) ---"
try {
    $ci = Get-ComputerInfo -Property WindowsProductName, OsBuildNumber, HyperVisorPresent, HyperVRequirementVMMonitorModeExtensions, HyperVRequirementVirtualizationFirmwareEnabled, HyperVRequirementSecondLevelAddressTranslation, HyperVRequirementDataExecutionPreventionAvailable -ErrorAction Stop

    Write-Log "  Windows edition : $($ci.WindowsProductName)"
    Write-Log "  Windows build   : $($ci.OsBuildNumber)"
    $editionOk = $ci.WindowsProductName -match "Pro|Enterprise|Education"
    $buildOk = $false
    if ($ci.OsBuildNumber) { $buildOk = [int]$ci.OsBuildNumber -ge 19041 }
    Write-Log "  build >= 19041 (full WSL2 support): $buildOk"

    Write-Log "  --- host-level: nested virtualization (cannot be fixed from inside this guest) ---"
    Write-Log "  hypervisor already present          : $($ci.HyperVisorPresent)"
    Write-Log "  VM Monitor Mode Extensions           : $($ci.HyperVRequirementVMMonitorModeExtensions)"
    Write-Log "  Virtualization Enabled In Firmware   : $($ci.HyperVRequirementVirtualizationFirmwareEnabled)"
    Write-Log "  Second Level Address Translation     : $($ci.HyperVRequirementSecondLevelAddressTranslation)"
    Write-Log "  Data Execution Prevention Available  : $($ci.HyperVRequirementDataExecutionPreventionAvailable)"
    $nestedVirtOk = [bool]$ci.HyperVRequirementVirtualizationFirmwareEnabled -and [bool]$ci.HyperVRequirementVMMonitorModeExtensions

    Write-Log "  --- guest-level: Windows optional features (local admin can self-serve, unless Group Policy blocks it) ---"
    $wslState = $null
    $vmpState = $null
    try {
        $wslState = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -ErrorAction Stop).State
        $vmpState = (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -ErrorAction Stop).State
        Write-Log "  Windows Subsystem for Linux feature : $wslState"
        Write-Log "  Virtual Machine Platform feature     : $vmpState"
    } catch {
        Write-Log "  Could not query optional feature state ($($_.Exception.Message)). This check itself usually needs an elevated session -- re-run as Administrator for a real reading." "WARN"
    }

    $wslCmd = Get-Command wsl -ErrorAction SilentlyContinue
    Write-Log "  wsl.exe present : $([bool]$wslCmd)"

    Write-Log "  --- verdict ---"
    $hostBlockers = @()
    if (-not $nestedVirtOk) { $hostBlockers += "nested virtualization is not exposed to this VDI guest" }
    $guestBlockers = @()
    if (-not $editionOk) { $guestBlockers += "Windows edition ($($ci.WindowsProductName)) -- Podman's own docs call for Pro/Enterprise/Education" }
    if ($wslState -and $wslState -ne "Enabled") { $guestBlockers += "Windows Subsystem for Linux feature is $wslState, not Enabled" }
    if ($vmpState -and $vmpState -ne "Enabled") { $guestBlockers += "Virtual Machine Platform feature is $vmpState, not Enabled" }

    if ($hostBlockers.Count -eq 0 -and $guestBlockers.Count -eq 0) {
        Write-Log "  Nothing blocking here. If this session is elevated, WSL2 + Podman should be self-serviceable without IT."
    } else {
        if ($hostBlockers.Count -gt 0) {
            Write-Log "  NEEDS THE VDI HOST ADMIN (ask for this specifically): $($hostBlockers -join '; ')" "WARN"
        }
        if ($guestBlockers.Count -gt 0) {
            Write-Log "  Possibly self-serviceable by a local Windows admin on THIS machine (try first, only escalate if a Group Policy blocks it): $($guestBlockers -join '; ')" "WARN"
        }
    }
} catch {
    Write-Log "Could not run the Podman/WSL2 readiness check ($($_.Exception.Message)). This does not affect the Claude Code / GitHub CLI / Git checks above or below." "WARN"
}

if ($CheckOnly) {
    Write-Log "=== -CheckOnly: stopping here. Nothing was installed or changed. ==="
    return
}

# ---------------------------------------------------------------------------
# Create the persistent directory layout. Idempotent -- -Force on
# New-Item is a no-op if the directory already exists, it does not error
# or recreate it.
# ---------------------------------------------------------------------------

Write-Log "=== creating directory layout under $Root ==="
foreach ($dir in @($Root, $LogDir, $WorkspaceDir, $WorkspaceIncoming)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-Log "  ok: $dir"
}
# Re-open the log now that LogDir definitely exists, so nothing above this
# point after directory creation silently fails to persist.
Add-Content -Path $LogFile -Value "(directories created above this line were logged to console only, log file created after)"

# ---------------------------------------------------------------------------
# GitHub CLI
# ---------------------------------------------------------------------------

Write-Log "=== GitHub CLI ==="
if ($ghVersion) {
    Write-Log "already installed ($ghVersion) -- skipping"
} elseif (-not $hasWinget) {
    Write-Log "winget is not available on this machine. Install GitHub CLI manually: download the MSI from https://github.com/cli/cli/releases/latest (look for the *_windows_amd64.msi asset), run it, then re-run this script to verify." "WARN"
} elseif (-not $reachResults["github.com (GitHub CLI manual-download fallback)"]) {
    Write-Log "github.com is not reachable from this machine, so winget's GitHub.cli package (which pulls the MSI from GitHub releases) will likely fail too. If winget's own package source is separately reachable, try the winget command below anyway; otherwise download the MSI on a machine that DOES have GitHub access and transfer it here manually, the same way the Linux VDI image tarballs are transferred." "WARN"
    Write-Log "  winget install -e --id GitHub.cli --silent --accept-package-agreements --accept-source-agreements"
} else {
    Write-Log "installing via winget..."
    winget install -e --id GitHub.cli --silent --accept-package-agreements --accept-source-agreements
    Update-SessionPath
    $ghVersion = Test-CommandVersion -Command "gh"
    if ($ghVersion) {
        Write-Log "installed: $ghVersion"
    } else {
        Write-Log "winget reported success but 'gh' is still not on PATH in this session. Open a NEW terminal and run 'gh --version' to confirm -- winget updates the registry, not this process's in-memory PATH." "WARN"
    }
}

# ---------------------------------------------------------------------------
# Claude Code -- native installer is Anthropic's own recommended path
# (self-updating), winget is the documented fallback.
# ---------------------------------------------------------------------------

Write-Log "=== Claude Code ==="
if ($claudeVersion) {
    Write-Log "already installed ($claudeVersion) -- skipping"
} elseif ($reachResults["claude.ai/install.ps1 (Claude Code native installer)"]) {
    Write-Log "installing via the native installer (irm https://claude.ai/install.ps1 | iex)..."
    Invoke-Expression (Invoke-RestMethod -Uri "https://claude.ai/install.ps1")
    Update-SessionPath
    $claudeVersion = Test-CommandVersion -Command "claude"
    if ($claudeVersion) {
        Write-Log "installed: $claudeVersion"
    } else {
        Write-Log "installer ran but 'claude' is still not on PATH in this session. Common cause: the installer places the binary under `$HOME\.local\bin`, which may need adding to PATH by hand (System Properties -> Environment Variables -> User PATH). Open a NEW terminal and run 'claude --version' to check first." "WARN"
    }
} elseif ($hasWinget) {
    Write-Log "claude.ai is not reachable, falling back to winget..."
    winget install -e --id Anthropic.ClaudeCode --silent --accept-package-agreements --accept-source-agreements
    Update-SessionPath
    $claudeVersion = Test-CommandVersion -Command "claude"
    if ($claudeVersion) {
        Write-Log "installed: $claudeVersion (note: winget installs do NOT auto-update -- run 'winget upgrade Anthropic.ClaudeCode' periodically)"
    } else {
        Write-Log "winget reported success but 'claude' is still not on PATH in this session. Open a NEW terminal and run 'claude --version' to confirm." "WARN"
    }
} else {
    Write-Log "Neither claude.ai nor winget is reachable/available from this machine. Install manually on a machine that has internet access and transfer the resulting install, or ask IT for a firewall exception for claude.ai / winget's package sources, then re-run this script." "WARN"
}

# ---------------------------------------------------------------------------
# Git for Windows (optional) -- Claude Code's own docs recommend this so it
# can use the Bash tool; without it, Claude Code uses PowerShell as its
# shell tool instead, which still works.
# ---------------------------------------------------------------------------

if ($SkipGitForWindows) {
    Write-Log "=== Git for Windows: skipped (-SkipGitForWindows) ==="
} else {
    Write-Log "=== Git for Windows ==="
    if ($gitVersion) {
        Write-Log "already installed ($gitVersion) -- skipping"
    } elseif (-not $hasWinget) {
        Write-Log "winget is not available. Install manually from https://git-scm.com/downloads/win, or pass -SkipGitForWindows to silence this." "WARN"
    } else {
        Write-Log "installing via winget..."
        winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
        Update-SessionPath
        $gitVersion = Test-CommandVersion -Command "git"
        if ($gitVersion) {
            Write-Log "installed: $gitVersion"
        } else {
            Write-Log "winget reported success but 'git' is still not on PATH in this session. Open a NEW terminal to confirm." "WARN"
        }
    }
}

# ---------------------------------------------------------------------------
# Final report
# ---------------------------------------------------------------------------

Write-Log "=== summary ==="
Write-Log "  claude : $(if ($claudeVersion) { $claudeVersion } else { 'NOT INSTALLED -- see warnings above' })"
Write-Log "  gh     : $(if ($ghVersion) { $ghVersion } else { 'NOT INSTALLED -- see warnings above' })"
Write-Log "  git    : $(if ($gitVersion) { $gitVersion } elseif ($SkipGitForWindows) { 'skipped' } else { 'NOT INSTALLED -- see warnings above' })"
Write-Log "  podman : $(if ($podmanVersion) { $podmanVersion } else { 'not installed -- this script does not install it; see the Podman/WSL2 readiness report above for what needs IT first' })"
Write-Log "log written to: $LogFile"
Write-Log "Next steps, run by hand (this script never touches credentials):"
Write-Log "  claude          # first run prompts an interactive login"
Write-Log "  gh auth login   # interactive GitHub authentication"
Write-Log "Workspace placeholder created at $WorkspaceDir for whatever gets transferred here next."
