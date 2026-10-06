# roundtrip-test.ps1 - round-trip test for install.ps1 / uninstall.ps1 against a
# throwaway fake profile, plus a backup-pruning check. ASCII only.
# It never touches the real web profile.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\roundtrip-test.ps1
[CmdletBinding()]
param(
  [string]$FakeProfile = 'C:\dsh-jingcha\.tmp\fake-profile-jingcha',
  [string]$ScratchPkg  = 'C:\dsh-jingcha\.tmp\fake-plugin-jingcha'
)
$ErrorActionPreference = 'Stop'
$here      = $PSScriptRoot
$install   = Join-Path $here 'install.ps1'
$uninstall = Join-Path $here 'uninstall.ps1'
$ps        = Join-Path $PSHOME 'powershell.exe'
$script:fail = 0
function Check([string]$name, $ok) {
  if ($ok) { Write-Host ('PASS: ' + $name) } else { Write-Host ('FAIL: ' + $name); $script:fail++ }
}
function RunPs([string]$script, [string[]]$psArgs) {
  # Swallow the child's stdout/stderr so it cannot pollute this function's return value.
  $out = @(& $ps -NoProfile -ExecutionPolicy Bypass -File $script @psArgs 2>&1 | ForEach-Object { [string]$_ })
  $exit = [int]$LASTEXITCODE
  if ($exit -ne 0) {
    Write-Host ('---- child exit ' + $exit + ' ----')
    $out | ForEach-Object { Write-Host ('    ' + $_) }
  }
  return $exit
}
function WriteProfileJson([string]$path, [string]$name) {
  $json = '{' + [char]10 + '  "name": "' + $name + '",' + [char]10 + '  "private": true' + [char]10 + '}' + [char]10
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$link        = Join-Path (Join-Path $FakeProfile 'node_modules') '@local\dsh-jingcha'
$profileJson = Join-Path $FakeProfile 'package.json'

# ---- part 1: install -> uninstall round trip on a throwaway profile ----
if (Test-Path $FakeProfile) { Remove-Item -LiteralPath $FakeProfile -Recurse -Force }
New-Item -ItemType Directory -Force -Path $FakeProfile | Out-Null
WriteProfileJson $profileJson 'fake-profile'

$code = RunPs $install @('-ProfileDir', $FakeProfile, '-DryRun')
Check 'install -DryRun exits 0' ($code -eq 0)
Check 'dry-run created no junction' (-not (Test-Path $link))

$code = RunPs $install @('-ProfileDir', $FakeProfile)
Check 'install exits 0' ($code -eq 0)
Check 'junction created' (Test-Path $link)
Check 'junction resolves package.json' (Test-Path (Join-Path $link 'package.json'))
$pj = Get-Content $profileJson -Raw | ConvertFrom-Json
Check 'dependency added' ($pj.dependencies.'@local/dsh-jingcha' -like 'link:*')
Check 'bundle added' (@($pj.dsh.profile.bundles) -contains '@local/dsh-jingcha')

$code = RunPs $uninstall @('-ProfileDir', $FakeProfile)
Check 'uninstall exits 0' ($code -eq 0)
Check 'junction removed' (-not (Test-Path $link))
Check 'linked target untouched' (Test-Path 'C:\dsh-jingcha\package.json')
$pj2 = Get-Content $profileJson -Raw | ConvertFrom-Json
Check 'dependency removed' ($null -eq $pj2.dependencies.'@local/dsh-jingcha')
Check 'bundle removed' (@($pj2.dsh.profile.bundles) -notcontains '@local/dsh-jingcha')

# ---- part 2: backup pruning (more than 10 -> keep the newest 10) ----
if (Test-Path $ScratchPkg) { Remove-Item -LiteralPath $ScratchPkg -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ScratchPkg | Out-Null
WriteProfileJson (Join-Path $ScratchPkg 'package.json') '@local/dsh-jingcha'
$scratchBackup = Join-Path $ScratchPkg '.backup'
New-Item -ItemType Directory -Force -Path $scratchBackup | Out-Null
$tag = ($FakeProfile -replace '[:\\/]', '_')
for ($i = 1; $i -le 12; $i++) {
  $seed = Join-Path $scratchBackup ('profile-' + $tag + '-package-seed' + ('{0:D2}' -f $i) + '-20200101000000.json')
  [System.IO.File]::WriteAllText($seed, '{}', (New-Object System.Text.UTF8Encoding($false)))
  (Get-Item -LiteralPath $seed).LastWriteTime = (Get-Date '2020-01-01').AddMinutes($i)
}
if (Test-Path $FakeProfile) { Remove-Item -LiteralPath $FakeProfile -Recurse -Force }
New-Item -ItemType Directory -Force -Path $FakeProfile | Out-Null
WriteProfileJson $profileJson 'fake-profile'
$code = RunPs $install @('-ProfileDir', $FakeProfile, '-PackageDir', $ScratchPkg)
Check 'scratch install exits 0' ($code -eq 0)
$count = @(Get-ChildItem -LiteralPath $scratchBackup -Filter ('profile-' + $tag + '-package-*.json') -File).Count
Check ('backup count pruned (got ' + $count + ', expect <= 11)') ($count -le 11)
$code = RunPs $uninstall @('-ProfileDir', $FakeProfile, '-PackageDir', $ScratchPkg)
Check 'scratch uninstall exits 0' ($code -eq 0)
Check 'scratch junction removed' (-not (Test-Path $link))

Write-Host ('FAILURES=' + $script:fail)
exit $script:fail
