$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $projectRoot 'release\win-unpacked'
$targetExe = Join-Path $outputDir 'Project-Ze.exe'
$wrapperSource = Join-Path $PSScriptRoot 'start-wrapper.cs'
$wrapperExe = Join-Path $outputDir 'start.exe'

if (-not (Test-Path -LiteralPath $targetExe)) {
  throw "Cannot build start.exe wrapper because Project-Ze.exe was not found: $targetExe"
}

$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)

$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
  throw 'Cannot build start.exe wrapper because csc.exe was not found.'
}

& $csc /nologo /target:winexe /platform:x64 "/out:$wrapperExe" /reference:System.Windows.Forms.dll "$wrapperSource"
if ($LASTEXITCODE -ne 0) {
  throw "csc.exe failed with exit code $LASTEXITCODE"
}

Write-Host "Created Windows launcher: $wrapperExe"
