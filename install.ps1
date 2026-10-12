# Ranite installer for Windows: downloads the self-contained release archive
# (bundled Node.js runtime, no npm needed) and sets it up under ~/.ranite.
#
# Usage (PowerShell 5.1 or 7):
#   irm https://raw.githubusercontent.com/zxsmind/ranite/main/install.ps1 | iex
#   & ./install.ps1 -Version 0.1.0
#   & ./install.ps1 -Binary ./ranite-0.1.0-windows-x64.zip -NoModifyPath
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$Binary = '',
  [switch]$NoModifyPath,
  [string]$InstallDir = (Join-Path $HOME '.ranite'),
  [string]$Repo = $env:RANITE_GITHUB_REPO
)

$ErrorActionPreference = 'Stop'
$App = 'ranite'
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = 'zxsmind/ranite' }
$BinDir = Join-Path $InstallDir 'bin'
$Launcher = Join-Path $BinDir "$App.cmd"

function Extract-WithProgress {
  param([string]$Archive, [string]$Destination, [int]$Step, [int]$Steps)
  Add-Type -AssemblyName System.IO.Compression | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
  # Archives come from our own release builds, so entries are trusted.
  $zip = $null
  try {
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  } catch {
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
    return
  }
  try {
    $entries = @($zip.Entries | Where-Object { $_.Name -ne '' })
    $total = [long]($entries | Measure-Object -Property Length -Sum).Sum
    if ($total -le 0) {
      $zip.Dispose()
      $zip = $null
      Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
      return
    }
    $done = [long]0
    $count = 0
    foreach ($entry in $entries) {
      $dest = Join-Path $Destination $entry.FullName
      $destDir = Split-Path -Parent $dest
      if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
      $done += $entry.Length
      $count++
      if (($count % 25) -eq 0 -or $done -ge $total) {
        $percent = [Math]::Min(100, [int]($done * 100 / $total))
        $have = '{0:N1}' -f ($done / 1MB)
        $want = '{0:N1}' -f ($total / 1MB)
        Write-Progress -Activity 'Installing ranite' -Status "Step ${Step}/${Steps}: Extracting $percent% ($have/$want MB)" -PercentComplete $percent
      }
    }
    Write-Progress -Activity 'Installing ranite' -Completed
  } finally {
    if ($zip -ne $null) { $zip.Dispose() }
  }
}

function Installed-Version {
  if (-not (Test-Path -LiteralPath $Launcher)) { return '' }
  # The script runs with $ErrorActionPreference = 'Stop'; a chatty runtime on
  # stderr must not turn this probe into a failure.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Launcher --version 2>$null
    if ($output -is [array]) { $output = $output -join "`n" }
    return ([string]$output).Trim()
  } catch { return '' } finally { $ErrorActionPreference = $previous }
}

function Download-WithProgress {
  param([string]$Url, [string]$OutFile, [int]$Step, [int]$Steps)
  $total = [long]0
  try {
    $head = Invoke-WebRequest -Method Head -Uri $Url -UseBasicParsing -ErrorAction Stop
    $lengthHeader = @($head.Headers['Content-Length'])[0]
    if ("$lengthHeader" -match '^\d+$') { $total = [long]$lengthHeader }
  } catch { $total = [long]0 }
  if ($total -le 0) {
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    return
  }
  Add-Type -AssemblyName System.Net.Http | Out-Null
  $handler = New-Object Net.Http.HttpClientHandler
  $client = New-Object Net.Http.HttpClient($handler)
  try {
    $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "Download failed (HTTP $([int]$response.StatusCode)): $Url" }
    $contentLength = $response.Content.Headers.ContentLength
    if ($total -le 0 -and $contentLength -gt 0) { $total = [long]$contentLength }
    $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    try {
      $target = [IO.File]::OpenWrite($OutFile)
      try {
        $buffer = New-Object byte[] 81920
        $read = [long]0
        while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $target.Write($buffer, 0, $count)
          $read += $count
          $percent = [Math]::Min(100, [int]($read * 100 / $total))
          $have = '{0:N1}' -f ($read / 1MB)
          $want = '{0:N1}' -f ($total / 1MB)
          Write-Progress -Activity 'Installing ranite' -Status "Step ${Step}/${Steps}: Downloading $percent% ($have/$want MB)" -PercentComplete $percent
        }
        Write-Progress -Activity 'Installing ranite' -Completed
      } finally { $target.Close() }
    } finally { $source.Close() }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

if ([string]::IsNullOrWhiteSpace($Binary)) {
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "Unsupported CPU: $($env:PROCESSOR_ARCHITECTURE)" }
  }
  $target = "windows-$arch"
  if ([string]::IsNullOrWhiteSpace($Version)) {
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $specific = ([string]$latest.tag_name).TrimStart('v')
    if ([string]::IsNullOrWhiteSpace($specific)) { throw 'Could not determine the latest release version.' }
  } else {
    $specific = $Version.TrimStart('v')
    try {
      Invoke-WebRequest -Uri "https://github.com/$Repo/releases/tag/v$specific" -Method Head -UseBasicParsing | Out-Null
    } catch {
      throw "Release v$specific not found. Available releases: https://github.com/$Repo/releases"
    }
  }
  $fileName = "$App-$specific-$target.zip"
  if ([string]::IsNullOrWhiteSpace($Version)) {
    $url = "https://github.com/$Repo/releases/latest/download/$fileName"
  } else {
    $url = "https://github.com/$Repo/releases/download/v$specific/$fileName"
  }
} else {
  if (-not (Test-Path -LiteralPath $Binary)) { throw "Binary archive not found at $Binary" }
  $specific = 'local'
}

$current = Installed-Version
if ($current -ne '' -and $current -eq $specific) {
  Write-Host "ranite $current is already installed at $InstallDir."
  return
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ranite_install_" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ([string]::IsNullOrWhiteSpace($Binary)) {
    Write-Host "Downloading ranite $specific ($target)"
    $archive = Join-Path $tmp $fileName
    Download-WithProgress -Url $url -OutFile $archive -Step 1 -Steps 2
  } else {
    Write-Host "Installing ranite from $Binary"
    $archive = Join-Path $tmp ([IO.Path]::GetFileName($Binary))
    Copy-Item -LiteralPath $Binary -Destination $archive
  }
  $extract = Join-Path $tmp 'extract'
  New-Item -ItemType Directory -Path $extract | Out-Null
  if ([string]::IsNullOrWhiteSpace($Binary)) { Extract-WithProgress -Archive $archive -Destination $extract -Step 2 -Steps 2 }
  else { Extract-WithProgress -Archive $archive -Destination $extract -Step 1 -Steps 1 }
  if (-not (Test-Path -LiteralPath (Join-Path $extract $App))) { throw "Archive does not contain a '$App' directory." }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Copy-Item -Path (Join-Path $extract "$App/*") -Destination $InstallDir -Recurse -Force
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  # Launcher with an absolute runtime path: works from cmd, PowerShell and PATH alike.
  $launcherBody = "@echo off`r`nrem Generated by the ranite installer. Uses the bundled Node.js runtime.`r`n`"$InstallDir\node\bin\node.exe`" `"$InstallDir\app\dist\cli.js`" %*`r`n"
  [IO.File]::WriteAllText($Launcher, $launcherBody, [Text.Encoding]::ASCII)
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$installed = Installed-Version
if ([string]::IsNullOrWhiteSpace($installed)) { throw 'Installation finished but `ranite --version` does not run.' }
Write-Host "Installed ranite $installed to $InstallDir."

if ($NoModifyPath) {
  Write-Host "Skipped PATH setup. Add $BinDir to PATH manually."
  return
}

$existing = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($existing -split ';' -contains $BinDir) {
  Write-Host "PATH already contains $BinDir."
} else {
  [Environment]::SetEnvironmentVariable('Path', "$existing;$BinDir", 'User')
  Write-Host "Added $BinDir to the user PATH. Restart your terminal, then try: ranite --version"
}
