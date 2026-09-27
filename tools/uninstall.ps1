<#
.SYNOPSIS
  Remove "jingcha" (@local/dsh-jingcha), or any -PackageName, from a DSH profile.

.DESCRIPTION
  ASCII-only on purpose (see install.ps1 header). Chinese notes: ../README.md.

.PARAMETER Profile
  Profile name (default: web).

.PARAMETER ProfileDir
  Explicit profile directory (tests).

.PARAMETER PackageDir
  Plugin directory (default: the parent of this script).

.PARAMETER Restore
  Restore profile package.json from the newest .backup copy (cleanest rollback).

.PARAMETER DryRun
  Print the intended changes without touching anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\dsh-jingcha\tools\uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$ProfileDir,
  [string]$PackageDir,
  [string]$PackageName,
  [switch]$Restore,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$nl = [char]10

function Read-Text($path) {
  $text = [System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false)))
  return $text.TrimStart([char]0xFEFF)
}
function Write-Text($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}
function Info($msg) { Write-Host "[uninstall] $msg" }

if (-not $PackageDir) { $PackageDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
if (-not $PackageName) {
  $manifest = (Read-Text (Join-Path $PackageDir 'package.json')) | ConvertFrom-Json
  $PackageName = $manifest.name
}
$packageName = $PackageName

if (-not $ProfileDir) {
  $dshHome = $env:DSH_HOME
  if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
  $ProfileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
}
$profileJsonPath = Join-Path $ProfileDir 'package.json'
Info "profile: $ProfileDir | plugin: $packageName"

# 1) remove the junction
# junction 位置由包名推出：'@local/dsh-jingcha' -> <profile>\node_modules\@local\dsh-jingcha
$slash = $packageName.IndexOf('/')
$scope = if ($packageName.StartsWith('@') -and $slash -gt 0) { $packageName.Substring(0, $slash) } else { $null }
$leaf = if ($slash -gt 0) { $packageName.Substring($slash + 1) } else { $packageName }
$modulesDir = Join-Path $ProfileDir 'node_modules'
$scopeDir = if ($scope) { Join-Path $modulesDir $scope } else { $modulesDir }
$linkPath = Join-Path $scopeDir $leaf
$existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    if ($DryRun) { Info "[dry-run] would delete link $linkPath" }
    else { Remove-Item -LiteralPath $linkPath -Force -Recurse; Info "deleted link: $linkPath" }
  } else {
    Info "$linkPath is not a link; skipped (check manually)"
  }
} else {
  Info 'no link found; skipped'
}

# 2) edit profile package.json
if (Test-Path $profileJsonPath) {
  $profileJson = (Read-Text $profileJsonPath) | ConvertFrom-Json
  if ($Restore) {
    $profileTag = ($ProfileDir -replace '[:\\/]', '_')
    $latest = Get-ChildItem (Join-Path $PackageDir '.backup') -Filter "profile-$profileTag-package-*.json" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) {
      if ($DryRun) { Info "[dry-run] would restore from $($latest.FullName)" }
      else { Copy-Item $latest.FullName $profileJsonPath -Force; Info "restored backup: $($latest.FullName)" }
      $profileJson = $null
    } else {
      Info 'no backup available; removing entries one by one instead'
    }
  }
  if ($profileJson) {
    $changed = @()
    if (($profileJson.PSObject.Properties.Name -contains 'dependencies') -and
        ($profileJson.dependencies.PSObject.Properties.Name -contains $packageName)) {
      $profileJson.dependencies.PSObject.Properties.Remove($packageName)
      $changed += "dependencies -= $packageName"
    }
    if ($profileJson.PSObject.Properties.Name -contains 'dsh') {
      $bundles = @($profileJson.dsh.profile.bundles)
      if ($bundles -contains $packageName) {
        $profileJson.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $packageName })
        $changed += "dsh.profile.bundles -= $packageName"
      }
    }
    if ($changed.Count -eq 0) {
      Info 'profile package.json did not declare it'
    } elseif ($DryRun) {
      foreach ($c in $changed) { Info "[dry-run] $c" }
    } else {
      $json = $profileJson | ConvertTo-Json -Depth 12
      Write-Text $profileJsonPath ($json + $nl)
      $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
      if ($nodeCmd) {
        & node -e "const fs=require('fs');const p=process.argv[1];fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p,'utf8')),null,2)+'\n')" $profileJsonPath
      }
      foreach ($c in $changed) { Info "changed: $c" }
    }
  }
}

Write-Host ''
Info 'Removed. Takes effect at the next dsh start; data stays in $env:DSH_HOME\data\dsh-jingcha\.'
