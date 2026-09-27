# 给任意一个仓库配一把独立密钥 + SSH 别名（通用、最小权限）。ASCII only for PS 5.1.
# 用法：
#   powershell -File C:\dsh-jingcha\tools\setup-repo-key.ps1 -Repo QTATQ233/dsh-jingcha -Name jingcha
# 它会：① 生成（或复用）C:\dsh-jingcha\.ssh\<Name>-ed25519  ② 往 C:\dsh-jingcha\.ssh\config 追加别名  ③ 打印公钥与后续两步
param(
  [Parameter(Mandatory=$true)][string]$Repo,      # owner/name
  [Parameter(Mandatory=$true)][string]$Name       # 别名与密钥名，例如 jingcha
)
$ErrorActionPreference = "Stop"
$sshDir = "C:\dsh-jingcha\.ssh"
$key = Join-Path $sshDir "$Name-ed25519"
$cfg = Join-Path $sshDir "config"
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
if (-not (Test-Path $key)) {
  $empty = '""'
  & ssh-keygen -t ed25519 -N $empty -C "$Name-deploy" -f $key | Out-Null
  Write-Host ("生成新密钥: " + $key)
} else {
  Write-Host ("复用已有密钥: " + $key)
}
$alias = "github-$Name"
$block = @"

Host $alias
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile C:/dsh-jingcha/.ssh/$Name-ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  ConnectTimeout 15
"@
if (-not (Select-String -Path $cfg -Pattern ("^Host " + $alias + "$") -Quiet)) {
  Add-Content -Path $cfg -Value $block -Encoding ascii
  Write-Host ("已追加别名: " + $alias)
} else {
  Write-Host ("别名已存在: " + $alias)
}
Write-Host ""
Write-Host "接下来两步（都在网页上点）："
Write-Host "  1) 打开 https://github.com/$Repo/settings/keys -> Add deploy key -> Title: $Name -> 粘贴下面的公钥 -> 勾选 Allow write access -> Add key"
Write-Host "  2) 在仓库里改成用这个别名推送："
Write-Host ("     git remote set-url origin git@" + $alias + ":" + $Repo + ".git")
Write-Host ("     git config core.sshCommand ""ssh -F C:/dsh-jingcha/.ssh/config""")
Write-Host ""
Write-Host "公钥（贴这一步用，安全）："
Get-Content ($key + ".pub") -Raw
