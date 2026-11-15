# Install a signed disposable COPY under separate test identities. Never upload
# the signed copy/private key or modify the real-identity unsigned Store artifact.
param([string]$PackageDirectory = 'release/store/test', [string]$Reports = 'release/store/reports')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI only.' }
New-Item -ItemType Directory -Force $Reports | Out-Null
$sdk = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin" -Directory | Where-Object {
    $_.Name -match '^10\.0\.\d+\.\d+$' -and (Test-Path (Join-Path $_.FullName 'x64/signtool.exe'))
} | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$signtool = Join-Path $sdk.FullName 'x64/signtool.exe'
$work = Join-Path $env:TEMP ('editor-msix-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
$cert = $null; $installed = @(); $mapping = @(); $original = @{}; $sentinels = @()
try {
    if (!(Get-AppxPackage -Name Microsoft.VCLibs.140.00.UWPDesktop)) {
        Invoke-WebRequest 'https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx' -OutFile (Join-Path $work 'VCLibs.appx')
        & $signtool verify /pa (Join-Path $work 'VCLibs.appx')
        if ($LASTEXITCODE -ne 0) { throw 'Microsoft runtime framework signature invalid.' }
        Add-AppxPackage -Path (Join-Path $work 'VCLibs.appx')
    }
    $cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=Editor Packaging Test' -KeyUsage DigitalSignature `
        -CertStoreLocation 'Cert:\CurrentUser\My' -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(1) `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')
    Export-Certificate -Cert $cert -FilePath (Join-Path $work 'test.cer') | Out-Null
    Import-Certificate -FilePath (Join-Path $work 'test.cer') -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
    foreach ($app in @('7TXT','Yedit')) {
        $bundle = if ($app -eq '7TXT') { 'com.gokcol.7txt' } else { 'com.yedit.desktop' }
        $shared = Join-Path $env:APPDATA $bundle
        New-Item -ItemType Directory -Force $shared | Out-Null
        $sentinel = Join-Path $shared ('.msix-preserve-' + [guid]::NewGuid().ToString('N'))
        $token = [guid]::NewGuid().ToString('N'); Set-Content $sentinel $token -Encoding ascii
        $sentinels += @{ path=$sentinel; token=$token }
        $package = @(Get-ChildItem $PackageDirectory -Filter "$app-*-TEST-ONLY-x64.msix")
        if ($package.Count -ne 1) { throw 'Expected one test package per app.' }
        $package = $package[0]; $info = Get-Content ($package.FullName + '.json') -Raw -Encoding utf8 | ConvertFrom-Json
        if ($info.identityMode -ne 'TEST-ONLY' -or $info.name -ne "Editor.$app.PackagingTest") { throw 'Refusing to install a real Store identity.' }
        if (Get-AppxPackage -Name $info.name) { throw 'Test identity already installed.' }
        $original[$package.FullName] = (Get-FileHash $package.FullName).Hash
        $copy = Join-Path $work "$app.msix"; Copy-Item $package.FullName $copy
        & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint /s My $copy
        if ($LASTEXITCODE -ne 0) { throw 'Disposable signing failed.' }
        & $signtool verify /pa $copy
        if ($LASTEXITCODE -ne 0) { throw 'Disposable signature invalid.' }
        Add-AppxPackage -Path $copy
        $registered = Get-AppxPackage -Name $info.name
        if (!$registered -or $registered.Version -ne $info.version) { throw 'MSIX installation/version verification failed.' }
        $installed += $registered
        $bundle = if ($app -eq '7TXT') { 'com.gokcol.7txt' } else { 'com.yedit.desktop' }
        $checkpoint = Join-Path $env:LOCALAPPDATA "Packages/$($registered.PackageFamilyName)/LocalCache/Roaming/$bundle/recovery/6d61696e.json"
        $mapping += @{ app=$app; executable=(Join-Path $registered.InstallLocation "$app.exe"); version=$info.version
            activation="$($registered.PackageFamilyName)!$($info.applicationId)"; checkpoint=$checkpoint
            # Windows can pass writes through when an unpackaged AppData
            # directory already exists. Verify the actual durable checkpoint in
            # either documented location, and preserve the pre-existing sentinel.
            checkpointFallback=(Join-Path $shared 'recovery/6d61696e.json'); installerExitCode=0 }
    }
    ConvertTo-Json -InputObject $mapping | Set-Content (Join-Path $Reports 'Windows-installation.json') -Encoding utf8
    & node scripts/windows-smoke.mjs "$env:RUNNER_TEMP/editor-smoke/node_modules/playwright/index.mjs" unused $Reports
    if ($LASTEXITCODE -ne 0) { throw 'Native packaged-app checks failed.' }
    $wackResults = @()
    $appcert = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/App Certification Kit/appcert.exe'
    foreach ($app in @('7TXT','Yedit')) {
        $report = Join-Path ([IO.Path]::GetFullPath($Reports)) "$app-WACK.xml"
        $status = 'not-available-on-runner'; $exitCode = $null
        if (Test-Path $appcert) {
            & $appcert reset | Out-Null
            $copy = Join-Path $work "$app.msix"
            $process = Start-Process -FilePath $appcert -ArgumentList @('test','-apptype','windowsstoreapp','-appxpackagepath',"`"$copy`"",'-reportoutputpath',"`"$report`"") -PassThru
            if ($process.WaitForExit(180000)) { $exitCode=$process.ExitCode; $status=if ($exitCode -eq 0) { 'completed' } else { 'requires-report-review' } }
            else { Stop-Process -Id $process.Id -Force; $status='timeout-requires-Windows-11-review' }
        }
        $overall = $null; $findings = @()
        if (Test-Path $report) {
            [xml]$xmlReport = Get-Content $report -Raw
            $overall = $xmlReport.REPORT.OVERALL_RESULT
            foreach ($test in $xmlReport.SelectNodes('//TEST')) {
                $testResult = $test.SelectSingleNode('RESULT').InnerText
                if ($testResult -ne 'PASS') {
                    $findings += @{ test=$test.NAME; result=$testResult; optional=$test.OPTIONAL
                        messages=@($test.SelectNodes('MESSAGES/MESSAGE') | ForEach-Object { $_.TEXT }) }
                }
            }
            if ($overall -ne 'PASS' -or $findings.Count -gt 0) { $status='requires-report-review' }
        }
        $wackResults += @{ app=$app; status=$status; exitCode=$exitCode; overallResult=$overall; findings=$findings
            testIdentity=$true; sameReleasedPayload=$true }
    }
    ConvertTo-Json -InputObject $wackResults -Depth 8 | Set-Content (Join-Path $Reports 'WACK-status.json') -Encoding utf8
    foreach ($entry in $installed) {
        Get-Process -Name 7TXT,Yedit -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($entry.InstallLocation) } | Stop-Process -Force
        Remove-AppxPackage -Package $entry.PackageFullName
        if (Get-AppxPackage -Name $entry.Name) { throw 'Test package uninstall failed.' }
    }
    $installed = @()
    foreach ($path in $original.Keys) { if ((Get-FileHash $path).Hash -ne $original[$path]) { throw 'Unsigned artifact changed.' } }
    foreach ($entry in $sentinels) { if ((Get-Content $entry.path -Raw).Trim() -ne $entry.token) { throw 'Existing direct-edition app data changed.' } }
    @{ installation=$true; nativeEditingAndRecovery=$true; uninstall=$true; unsignedArtifactsUnchanged=$true; existingDataPreserved=$true } |
        ConvertTo-Json | Set-Content (Join-Path $Reports 'MSIX-validation.json') -Encoding utf8
} finally {
    foreach ($entry in $installed) { Remove-AppxPackage -Package $entry.PackageFullName -ErrorAction SilentlyContinue }
    if ($cert) {
        Remove-Item "Cert:\LocalMachine\TrustedPeople\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
        Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -ErrorAction SilentlyContinue
    }
    foreach ($entry in $sentinels) { Remove-Item $entry.path -Force -ErrorAction SilentlyContinue }
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
