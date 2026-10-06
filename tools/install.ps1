<#
.SYNOPSIS
  Install "jingcha" (package @local/dsh-jingcha; repo dir C:\dsh-jingcha) into a DSH profile.

.DESCRIPTION
  (Chinese notes: see ../README.md).
  This script is deliberately ASCII-only: Windows PowerShell 5.1 reads a BOM-less
  script as ANSI, and non-ASCII text then breaks parsing.

  Steps (backup first, fully reversible):
    1) back up <profile>\package.json into <plugin>\.backup\;
    2) add dependency "link:<plugin dir>" and the bundle entry to the profile manifest;
    3) create <profile>\node_modules\@local\dsh-jingcha as a junction to the plugin dir.

  Why a junction: profile module resolution looks at the installation first, then the
  profile directory, and treats node_modules links pointing outside the profile as extra
  resolution roots (linkedProfileRoots). This matches what the official
    dsh plugin --profile <name> add link:<dir>
  produces, without running pnpm.

  Caveat: a later pnpm run in this profile may rebuild node_modules and drop the manual
  junction; use the official command above if that happens.

.PARAMETER Profile
  Profile name (default: web).

.PARAMETER ProfileDir
  Explicit profile directory (used for dry runs / tests; skips the $DSH_HOME lookup).

.PARAMETER PackageDir
  Plugin directory (default: the parent of this script).

.PARAMETER DryRun
  Print the intended changes without touching anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\dsh-jingcha\tools\install.ps1
#>
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$ProfileDir,
  [string]$PackageDir,
  [string]$PackageName,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$nl = [char]10

# Always read/write files as UTF-8 without BOM: Windows PowerShell 5.1 defaults to ANSI.
function Read-Text($path) {
  $text = [System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false)))
  return $text.TrimStart([char]0xFEFF)
}
function Write-Text($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}
function Info($msg) { Write-Host "[install] $msg" }
function Fail($msg) { Write-Host "[install] FAILED: $msg" -ForegroundColor Red; exit 1 }

# -- 0. locate plugin dir and profile dir ------------------------------------
if (-not $PackageDir) { $PackageDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$manifestPath = Join-Path $PackageDir 'package.json'
if (-not (Test-Path $manifestPath)) { Fail "not found: $manifestPath" }
if (-not $PackageName) {
  $manifest = (Read-Text $manifestPath) | ConvertFrom-Json
  $PackageName = $manifest.name
}
$packageName = $PackageName
if (-not $packageName) { Fail 'package.json has no name' }
Info "plugin: $packageName  @  $PackageDir"

if (-not $ProfileDir) {
  $dshHome = $env:DSH_HOME
  if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
  $ProfileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
}
if (-not (Test-Path $ProfileDir)) { Fail "profile directory not found: $ProfileDir" }
Info "profile: $ProfileDir"

$profileJsonPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $profileJsonPath)) { Fail "not found: $profileJsonPath" }
$profileJson = (Read-Text $profileJsonPath) | ConvertFrom-Json

# link: dependencies use forward slashes (works on both platforms)
$linkTarget = $PackageDir -replace '\\', '/'

# -- 1. backup --------------------------------------------------------------
$backupDir = Join-Path $PackageDir '.backup'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# Backup name carries a tag derived from the profile directory, so -Restore can only ever
# pick up backups that belong to the SAME profile (never a dry-run/fake-profile backup).
$profileTag = ($ProfileDir -replace '[:\\/]', '_')
$backupPath = Join-Path $backupDir "profile-$profileTag-package-$stamp.json"
# Keep the backup directory from growing without bound: when this profile already has
# more than 10 backups, delete the oldest ones (the newest 10 are kept).
if (Test-Path $backupDir) {
  $oldBackups = @(Get-ChildItem -LiteralPath $backupDir -Filter "profile-$profileTag-package-*.json" -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending)
  if ($oldBackups.Count -gt 10) {
    $victims = @($oldBackups | Select-Object -Skip 10)
    if ($DryRun) {
      Info ("[dry-run] would prune " + $victims.Count + " old backup(s), keeping the newest 10")
    } else {
      foreach ($v in $victims) { Remove-Item -LiteralPath $v.FullName -Force -ErrorAction SilentlyContinue }
      Info ("pruned " + $victims.Count + " old backup(s), keeping the newest 10")
    }
  }
}
if ($DryRun) {
  Info "[dry-run] would back up to $backupPath"
} else {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item $profileJsonPath $backupPath -Force
  Info "backed up: $backupPath"
}

# -- 2. edit profile package.json -------------------------------------------
$changed = @()

if ($profileJson.PSObject.Properties.Name -notcontains 'dependencies') {
  $profileJson | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{})
}
if ($profileJson.dependencies.PSObject.Properties.Name -notcontains $packageName) {
  $profileJson.dependencies | Add-Member -MemberType NoteProperty -Name $packageName -Value ("link:" + $linkTarget)
  $changed += "dependencies += $packageName = link:$linkTarget"
}

if ($profileJson.PSObject.Properties.Name -notcontains 'dsh') {
  $profileJson | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } })
}
if ($profileJson.dsh.PSObject.Properties.Name -notcontains 'profile') {
  $profileJson.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{ bundles = @() })
}
$bundles = @($profileJson.dsh.profile.bundles)
if ($bundles -notcontains $packageName) {
  $bundles += $packageName
  $profileJson.dsh.profile.bundles = $bundles
  $changed += "dsh.profile.bundles += $packageName"
}

if ($changed.Count -eq 0) {
  Info 'profile package.json already declares it; nothing to change'
} elseif ($DryRun) {
  foreach ($c in $changed) { Info "[dry-run] $c" }
} else {
  $json = $profileJson | ConvertTo-Json -Depth 12
  Write-Text $profileJsonPath ($json + $nl)
  # PowerShell 5.1 ConvertTo-Json formats oddly; reformat with node when available (key order kept).
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    & node -e "const fs=require('fs');const p=process.argv[1];fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p,'utf8')),null,2)+'\n')" $profileJsonPath
  }
  foreach ($c in $changed) { Info "changed: $c" }
}

# -- 3. create the junction -------------------------------------------------
# Junction path is derived from the package name: '@local/dsh-jingcha' -> <profile>\node_modules\@local\dsh-jingcha
$slash = $packageName.IndexOf('/')
$scope = if ($packageName.StartsWith('@') -and $slash -gt 0) { $packageName.Substring(0, $slash) } else { $null }
$leaf = if ($slash -gt 0) { $packageName.Substring($slash + 1) } else { $packageName }
$modulesDir = Join-Path $ProfileDir 'node_modules'
$scopeDir = if ($scope) { Join-Path $modulesDir $scope } else { $modulesDir }
$linkPath = Join-Path $scopeDir $leaf
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $scopeDir | Out-Null }

$existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    if ($DryRun) { Info "[dry-run] would replace existing link $linkPath" }
    else {
      # Remove the link itself only (never recurse into the target): cmd rmdir drops a
      # junction/reparse point and leaves the linked directory untouched.
      & cmd.exe /c rmdir /q "$linkPath"
      if (Test-Path -LiteralPath $linkPath) { Fail "failed to remove old link: $linkPath" }
      Info "removed old link: $linkPath"
    }
  } else {
    Fail "$linkPath exists and is NOT a link (real file/directory); resolve it manually first"
  }
}
if ($DryRun) {
  Info "[dry-run] would create junction: $linkPath -> $PackageDir"
} else {
  New-Item -ItemType Junction -Path $linkPath -Target $PackageDir | Out-Null
  Info "junction created: $linkPath -> $PackageDir"
}

# -- 4. self-verification ---------------------------------------------------
if (-not $DryRun) {
  $check = (Read-Text $profileJsonPath) | ConvertFrom-Json
  $dep = $check.dependencies.$packageName
  $inBundles = @($check.dsh.profile.bundles) -contains $packageName
  $linkOk = Test-Path (Join-Path $linkPath 'package.json')
  Info "verified: dependencies[$packageName] = $dep | bundles contains it = $inBundles | junction resolves = $linkOk"
  if (-not $linkOk) { Fail 'junction created but package.json is not resolvable through it' }
}

Write-Host ''
Info 'Done. A new bundle is mounted at the next DSH start:'
Write-Host '  1) close the current dsh window, then restart dsh (launcher .bat in C:\dsh-jingcha, or: dsh web)'
Write-Host '  2) after the restart, look at:'
Write-Host '       $env:DSH_HOME\data\dsh-jingcha\status.json   = live snapshot (verdict / in-flight calls / lag)'
Write-Host '       $env:DSH_HOME\data\dsh-jingcha\events.jsonl  = event stream (one line per tool call)'
Write-Host '  3) in a session, call the jingcha_status tool for a Chinese health report'
Write-Host ('  4) uninstall: tools\uninstall.ps1  (or: dsh plugin --profile web remove ' + $packageName + ')')
