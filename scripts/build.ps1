# Build on Windows with PowerShell 5.1+ and .NET Framework 4.8.
# Normal users run the generated Setup.exe; this script is for contributors.
[CmdletBinding()]
param([string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repoRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dist = Join-Path $repoRoot 'dist'
$buildRoot = Join-Path $repoRoot 'build'
$scratch = Join-Path $buildRoot ([Guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $scratch 'payload'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Install .NET Framework 4.8 on Windows x64 first.' }
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
foreach ($path in @('extension\manifest.json', 'extension\package.json')) {
    $actual = (Get-Content -LiteralPath (Join-Path $repoRoot $path) -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if ($actual -ne $version) { throw "Version mismatch: $path" }
}
if (-not (Get-Content -LiteralPath (Join-Path $repoRoot 'host\bridge.mjs') -Raw -Encoding UTF8).Contains("version: '$version'")) { throw 'Native host version mismatch.' }
if (-not (Get-Content -LiteralPath (Join-Path $repoRoot 'installer\InstallerCore.cs') -Raw -Encoding UTF8).Contains('"' + $version + '"')) { throw 'Installer version mismatch.' }
New-Item -ItemType Directory -Path $dist,$payloadRoot -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
function Assert-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Expected) { throw "SHA-256 mismatch: $Path" }
}
function Compile-CSharp([string[]]$CompilerArguments) {
    & $compiler /nologo /optimize+ /target:winexe /platform:x64 /codepage:65001 @CompilerArguments
    if ($LASTEXITCODE -ne 0) { throw 'C# compilation failed.' }
}
function Compress-Tree([string]$Directory, [string]$ZipPath) {
    $prefix = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
    $zip = [IO.Compression.ZipFile]::Open($ZipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $Directory -File -Recurse -Force | Sort-Object FullName) {
            $entryName = $file.FullName.Substring($prefix.Length).Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $zip.Dispose() }
}
try {
    Write-Host 'Preparing verified Node.js runtime...'
    $runtimeTarget = Join-Path $payloadRoot 'runtime'
    New-Item -ItemType Directory -Path $runtimeTarget -Force | Out-Null
    foreach ($item in @(
        @{ Name = 'node.exe'; Url = $lock.executableUrl; Hash = $lock.executableSha256 },
        @{ Name = 'LICENSE.txt'; Url = $lock.licenseUrl; Hash = $lock.licenseSha256 }
    )) {
        $target = Join-Path $runtimeTarget $item.Name
        if ($item.Name -eq 'LICENSE.txt') { Copy-Item -LiteralPath (Join-Path $repoRoot 'third_party\node\LICENSE.txt') -Destination $target }
        elseif ($RuntimeDirectory) { Copy-Item -LiteralPath (Join-Path $RuntimeDirectory $item.Name) -Destination $target }
        else { Invoke-WebRequest -UseBasicParsing -Uri $item.Url -OutFile $target }
        Assert-Hash $target $item.Hash
    }
    $node = Join-Path $runtimeTarget 'node.exe'
    Copy-Item -LiteralPath (Join-Path $repoRoot 'extension') -Destination $payloadRoot -Recurse
    $hostTarget = Join-Path $payloadRoot 'host'
    New-Item -ItemType Directory -Path $hostTarget -Force | Out-Null
    foreach ($file in @('engine.mjs', 'bridge.mjs', 'main.mjs', 'temp-files.mjs')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot "host\$file") -Destination $hostTarget
    }
    foreach ($file in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CHANGELOG.md')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $payloadRoot
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'docs') -Destination $payloadRoot -Recurse
    Write-Host 'Compiling background host...'
    Compile-CSharp @("/out:$hostTarget\EdgeParallelHost.exe", (Join-Path $repoRoot 'host\Launcher.cs'))
    Write-Host 'Running downloader and extension regression tests...'
    $previousTestHost = $env:EDGEPARALLEL_TEST_HOST
    $env:EDGEPARALLEL_TEST_HOST = Join-Path $hostTarget 'EdgeParallelHost.exe'
    Push-Location $repoRoot
    try {
        & $node --test 'host/*.test.mjs' 'tests/*.test.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed.' }
    } finally { Pop-Location; $env:EDGEPARALLEL_TEST_HOST = $previousTestHost }
    & $node (Join-Path $PSScriptRoot 'verify-host.mjs') $hostTarget $version
    if ($LASTEXITCODE -ne 0) { throw 'Compiled native host verification failed.' }
    $payloadZip = Join-Path $scratch 'payload.zip'
    Compress-Tree $payloadRoot $payloadZip
    $setupName = "EdgeParallel-$version-win-x64-setup.exe"
    $setup = Join-Path $scratch $setupName
    Write-Host 'Compiling graphical installer...'
    Compile-CSharp @(
        "/out:$setup", "/resource:$payloadZip,EdgeParallel.Payload.zip",
        "/win32manifest:$repoRoot\installer\app.manifest",
        '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll',
        '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
        (Join-Path $repoRoot 'installer\Setup.cs'),
        (Join-Path $repoRoot 'installer\InstallerCore.cs'),
        (Join-Path $repoRoot 'installer\SelfTests.cs')
    )
    Write-Host 'Checking isolated installation, update, rollback and uninstall...'
    $report = Join-Path $scratch 'installer-self-test.txt'
    $testProcess = Start-Process -FilePath $setup -ArgumentList @('/self-test', ('"' + $report + '"')) -WindowStyle Hidden -PassThru -Wait
    if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report -Encoding UTF8 }
    if ($testProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $report)) { throw 'Installer self-test failed.' }
    Write-Host 'Creating clean GitHub source archive...'
    $sourceStage = Join-Path $scratch 'source'
    $sourceRoot = Join-Path $sourceStage 'EdgeParallel'
    New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
    foreach ($dir in @('extension','host','installer','scripts','tests','docs','third_party','.github')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $dir) -Destination $sourceRoot -Recurse
    }
    foreach ($file in @('README.md','LICENSE','THIRD_PARTY_NOTICES.md','CHANGELOG.md','package.json','.gitignore','.gitattributes')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $sourceRoot
    }
    $forbidden = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force | Where-Object {
        $_.Extension -in @('.exe','.zip','.log','.pfx','.pem','.key') -or $_.Name -in @('com.edgeparallel.bridge.json','self-test-result.txt')
    })
    if ($forbidden.Count) { throw 'Generated binaries, private keys or installation state found in source tree.' }
    $sourceName = "EdgeParallel-$version-source.zip"
    $sourceZip = Join-Path $scratch $sourceName
    Compress-Tree $sourceStage $sourceZip
    Copy-Item -LiteralPath $setup,$sourceZip -Destination $dist -Force
    $hashLines = @($setupName,$sourceName) | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $dist $_) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_ }
    [IO.File]::WriteAllLines((Join-Path $dist 'SHA256SUMS'), $hashLines, (New-Object Text.UTF8Encoding($false)))
    Copy-Item -LiteralPath $report -Destination (Join-Path $dist 'installer-self-test.txt') -Force
    Write-Host "Release ready: $dist"
} finally {
    # Only remove this run's unique staging folder, never a caller-provided path.
    $resolvedScratch = [IO.Path]::GetFullPath($scratch)
    $buildPrefix = [IO.Path]::GetFullPath($buildRoot).TrimEnd('\') + '\'
    if (-not $resolvedScratch.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe build cleanup path.' }
    if (Test-Path -LiteralPath $resolvedScratch) { Remove-Item -LiteralPath $resolvedScratch -Recurse -Force }
}
