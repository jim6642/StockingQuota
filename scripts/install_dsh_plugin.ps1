param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$pluginName = "dsh-stocking-quota-bridge"
$srcDir = Join-Path $PSScriptRoot "..\dsh-plugin\$pluginName"
$dshHome = Join-Path $env:USERPROFILE ".dsh"
$dstDir = Join-Path $dshHome "plugins\$pluginName"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $dshHome)) {
  Write-Error "未检测到 DeepSeek Harness 用户目录: $dshHome"
  exit 1
}

function Write-JsonNoBom($path, $obj) {
  $json = ($obj | ConvertTo-Json -Depth 10) + "`n"
  # CRITICAL: PowerShell 5.1 Set-Content -Encoding UTF8 writes a UTF-8 BOM that crashes Node JSON.parse!
  [System.IO.File]::WriteAllText($path, $json, $utf8NoBom)
}

function Update-DshProfile($profileName, $remove) {
  $profDir = Join-Path $dshHome "profiles\$profileName"
  $pkgPath = Join-Path $profDir "package.json"
  if (-not (Test-Path $pkgPath)) { return }

  $raw = [System.IO.File]::ReadAllText($pkgPath, $utf8NoBom).TrimStart([char]0xFEFF)
  $pkg = $raw | ConvertFrom-Json
  if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }

  $linkVal = "link:" + ($dstDir -replace "\\", "/")
  $bundles = @()
  if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
    $bundles = @($pkg.dsh.profile.bundles)
  }

  if ($remove) {
    $pkg.dependencies.PSObject.Properties.Remove($pluginName)
    $bundles = @($bundles | Where-Object { $_ -ne $pluginName })
    $nmLink = Join-Path $profDir "node_modules\$pluginName"
    if (Test-Path $nmLink) {
      if ((Get-Item $nmLink -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($nmLink, $false) }
      else { Remove-Item $nmLink -Recurse -Force }
    }
  } else {
    $pkg.dependencies | Add-Member -Force -NotePropertyName $pluginName -NotePropertyValue $linkVal
    if ($bundles -notcontains $pluginName) {
      $bundles += $pluginName
    }
    $nmDir = Join-Path $profDir "node_modules"
    if (Test-Path $nmDir) {
      $nmLink = Join-Path $nmDir $pluginName
      if (Test-Path $nmLink) {
        if ((Get-Item $nmLink -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($nmLink, $false) }
        else { Remove-Item $nmLink -Recurse -Force }
      }
      New-Item -ItemType Junction -Path $nmLink -Target $dstDir | Out-Null
    }
  }

  $pkg.dsh.profile.bundles = $bundles
  Write-JsonNoBom $pkgPath $pkg
  Write-Output "Updated DSH profile '$profileName' (remove=$remove, UTF-8 no BOM)"
}

if ($Uninstall) {
  Update-DshProfile "desktop" $true
  Update-DshProfile "web" $true
  if (Test-Path $dstDir) { Remove-Item $dstDir -Recurse -Force }
  Write-Output "Uninstalled $pluginName cleanly. Restart DeepSeek Harness to take effect."
  exit 0
}

New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
Copy-Item -Path (Join-Path $srcDir "*") -Destination $dstDir -Recurse -Force

# Write resolved StockingQuota.exe path into cordis.patch.yml (UTF-8 no BOM) for DSH auto-launch
$resolvedExe = (Resolve-Path (Join-Path $PSScriptRoot "..\release\win-unpacked\StockingQuota.exe") -ErrorAction SilentlyContinue)
if ($resolvedExe) {
  $exeForward = $resolvedExe.Path -replace "\\", "/"
  $patchPath = Join-Path $dstDir "cordis.patch.yml"
  $patchText = "- insert:`n    - id: dsh-stocking-quota-bridge`n      name: dsh-stocking-quota-bridge`n      config:`n        targetUrl: 'http://127.0.0.1:17821/dsh/context'`n        autoLaunch: true`n        stockingQuotaExe: '$exeForward'`n"
  [System.IO.File]::WriteAllText($patchPath, $patchText, $utf8NoBom)
}

Update-DshProfile "desktop" $false
Update-DshProfile "web" $false
Write-Output "Installed $pluginName -> $dstDir (UTF-8 no BOM, autoLaunch enabled)"
Write-Output "Restart DeepSeek Harness so the contextPressure bridge plugin activates!"
