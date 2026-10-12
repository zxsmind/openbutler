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

# One cumulative bar across download, extract, and install, drawn by hand so it
# matches the shell installer and does not depend on the host's own progress UI.
$script:BarActive = -not [Console]::IsOutputRedirected
$script:Orange = ''
$script:Reset = ''
if ($script:BarActive) {
  $esc = [char]27
  # Windows Terminal and MSYS/Git Bash already interpret ANSI; a legacy console needs it enabled.
  $vt = ($env:OS -ne 'Windows_NT') -or [bool]$env:WT_SESSION -or [bool]$env:TERM
  if (-not $vt) {
    try {
      if (-not ('Ranite.ConsoleVt' -as [type])) {
        Add-Type -Namespace Ranite -Name ConsoleVt -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@ -ErrorAction Stop
      }
      $handle = [Ranite.ConsoleVt]::GetStdHandle(-11)
      [uint32]$mode = 0
      if ([Ranite.ConsoleVt]::GetConsoleMode($handle, [ref]$mode)) {
        [void][Ranite.ConsoleVt]::SetConsoleMode($handle, $mode -bor 4)
        $vt = $true
      }
    } catch { $vt = $false }
  }
  if ($vt -and [string]::IsNullOrEmpty($env:NO_COLOR)) {
    $script:Orange = "${esc}[38;5;214m"
    $script:Reset = "${esc}[0m"
  }
}

function Show-Bar {
  param([long]$Done, [long]$Total, [string]$Label)
  if (-not $script:BarActive) { return }
  $width = 50
  if ($Total -le 0) {
    $bar = [string]::new('-', $width)
    $line = '[' + $bar + '] ' + $Label.PadRight(11)
  } else {
    $percent = [Math]::Min(100, [int]($Done * 100 / $Total))
    $filled = [int]($percent * $width / 100)
    $bar = [string]::new('=', $filled) + [string]::new('-', $width - $filled)
    $line = '[' + $bar + '] ' + ('{0,3}' -f $percent) + '% ' + $Label.PadRight(11)
  }
  Write-Host ("`r" + $script:Orange + $line + $script:Reset) -NoNewline
}

function Get-RemoteMeta {
  param([string]$Url)
  try {
    $text = (Invoke-WebRequest -Uri "$Url.meta" -UseBasicParsing -ErrorAction Stop).Content
    $data = ConvertFrom-StringData (($text -join "`n") -replace "`r", '')
    $archiveBytes = [long]0
    $payloadBytes = [long]0
    if ("$($data['archive_bytes'])" -match '^\d+$') { $archiveBytes = [long]$data['archive_bytes'] }
    if ("$($data['payload_bytes'])" -match '^\d+$') { $payloadBytes = [long]$data['payload_bytes'] }
    if ($archiveBytes -le 0 -or $payloadBytes -le 0) { return $null }
    return @{ D = $archiveBytes; U = $payloadBytes }
  } catch { return $null }
}

function Extract-WithProgress {
  param([string]$Archive, [string]$Destination, [long]$Total, [long]$Base)
  Add-Type -AssemblyName System.IO.Compression | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
  $zip = $null
  try {
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  } catch {
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
    return
  }
  try {
    $entries = @($zip.Entries | Where-Object { $_.Name -ne '' })
    $sum = [long]($entries | Measure-Object -Property Length -Sum).Sum
    if ($sum -le 0) {
      $zip.Dispose()
      $zip = $null
      Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
      return
    }
    $denominator = $Total
    $offset = $Base
    if ($denominator -le 0) { $denominator = $sum; $offset = [long]0 }
    $done = [long]0
    $lastPercent = -1
    foreach ($entry in $entries) {
      $dest = Join-Path $Destination $entry.FullName
      $destDir = Split-Path -Parent $dest
      if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
      $done += $entry.Length
      $percent = [Math]::Min(100, [int](($offset + $done) * 100 / $denominator))
      if ($percent -ne $lastPercent) {
        Show-Bar ($offset + $done) $denominator 'Extracting'
        $lastPercent = $percent
      }
    }
    Show-Bar ($offset + $done) $denominator 'Extracting'
  } finally {
    if ($zip -ne $null) { $zip.Dispose() }
  }
}

function Installed-Version {
  if (-not (Test-Path -LiteralPath $Launcher)) { return '' }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Launcher --version 2>$null
    if ($output -is [array]) { $output = $output -join "`n" }
    return ([string]$output).Trim()
  } catch { return '' } finally { $ErrorActionPreference = $previous }
}

function Download-WithProgress {
  param([string]$Url, [string]$OutFile, [long]$Total, [long]$Base)
  if ($Total -le 0) {
    try {
      $head = Invoke-WebRequest -Method Head -Uri $Url -UseBasicParsing -ErrorAction Stop
      $lengthHeader = @($head.Headers['Content-Length'])[0]
      if ("$lengthHeader" -match '^\d+$') { $Total = [long]$lengthHeader }
    } catch { $Total = [long]0 }
  }
  if ($Total -le 0) {
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
    if ($Total -le 0 -and $contentLength -gt 0) { $Total = [long]$contentLength }
    $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    try {
      $target = [IO.File]::OpenWrite($OutFile)
      try {
        $buffer = New-Object byte[] 81920
        $read = [long]0
        $lastPercent = -1
        while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $target.Write($buffer, 0, $count)
          $read += $count
          $percent = [Math]::Min(100, [int](($Base + $read) * 100 / $Total))
          if ($percent -ne $lastPercent) {
            Show-Bar ($Base + $read) $Total 'Downloading'
            $lastPercent = $percent
          }
        }
        Show-Bar ($Base + $read) $Total 'Downloading'
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
  if ($script:BarActive) { try { [Console]::CursorVisible = $false } catch {} }
  if ([string]::IsNullOrWhiteSpace($Binary)) {
    Write-Host "Downloading ranite $specific ($target)"
    $archive = Join-Path $tmp $fileName
    $meta = Get-RemoteMeta $url
    if ($meta -ne $null) {
      $BarTotal = $meta.D + $meta.U + $meta.U
      Download-WithProgress -Url $url -OutFile $archive -Total $BarTotal -Base 0
      $baseD = (Get-Item -LiteralPath $archive).Length
    } else {
      Download-WithProgress -Url $url -OutFile $archive -Total 0 -Base 0
      $baseD = (Get-Item -LiteralPath $archive).Length
      $BarTotal = [long]0
    }
  } else {
    Write-Host "Installing ranite from $Binary"
    $archive = Join-Path $tmp ([IO.Path]::GetFileName($Binary))
    Copy-Item -LiteralPath $Binary -Destination $archive
    $BarTotal = [long]0
  }
  $extract = Join-Path $tmp 'extract'
  New-Item -ItemType Directory -Path $extract | Out-Null
  if ($BarTotal -gt 0) { Extract-WithProgress -Archive $archive -Destination $extract -Total $BarTotal -Base $baseD }
  else { Extract-WithProgress -Archive $archive -Destination $extract -Total 0 -Base 0 }
  if (-not (Test-Path -LiteralPath (Join-Path $extract $App))) { throw "Archive does not contain a '$App' directory." }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  if ($BarTotal -gt 0) {
    $treeRoot = Join-Path $extract $App
    $baseDU = $baseD + [long](Get-ChildItem -LiteralPath $treeRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum
    $copied = [long]0
    foreach ($child in Get-ChildItem -LiteralPath $treeRoot) {
      $item = Get-Item -LiteralPath $child.FullName
      if ($item -is [IO.DirectoryInfo]) {
        $childSize = [long](Get-ChildItem -LiteralPath $item.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
      } else {
        $childSize = [long]$item.Length
      }
      Copy-Item -LiteralPath $item.FullName -Destination $InstallDir -Recurse -Force
      $copied += $childSize
      Show-Bar ($baseDU + $copied) $BarTotal 'Installing'
    }
  } else {
    Copy-Item -Path (Join-Path $extract "$App/*") -Destination $InstallDir -Recurse -Force
  }
  if ($BarTotal -gt 0) { Show-Bar $BarTotal $BarTotal 'Done' }
  if ($script:BarActive) { Write-Host '' }
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $launcherBody = "@echo off`r`nrem Generated by the ranite installer. Uses the bundled Node.js runtime.`r`n`"$InstallDir\node\bin\node.exe`" `"$InstallDir\app\dist\cli.js`" %*`r`n"
  [IO.File]::WriteAllText($Launcher, $launcherBody, [Text.Encoding]::ASCII)
} finally {
  if ($script:BarActive) { try { [Console]::CursorVisible = $true } catch {} }
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
$parts = @($existing -split ';' | Where-Object { $_ -and $_ -ne $BinDir })
[Environment]::SetEnvironmentVariable('Path', (@($BinDir) + $parts) -join ';', 'User')
Write-Host "Added $BinDir to the user PATH. Restart your terminal, then try: ranite --version"
