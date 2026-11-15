param([string]$Packages = 'release', [string]$Reports = 'release')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Reports | Out-Null
$installed = @()
foreach ($app in @('7TXT', 'Yedit')) {
    $setups = @(Get-ChildItem -Path $Packages -Filter "${app}_*_x64-setup.exe")
    if ($setups.Count -ne 1) { throw "Expected one $app installer" }
    $process = Start-Process -FilePath $setups[0].FullName -ArgumentList '/S' -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "$app installer failed: $($process.ExitCode)" }
    $entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
        Get-ItemProperty | Where-Object { $_.DisplayName -eq $app } | Select-Object -First 1
    if (!$entry.InstallLocation) { throw "$app installation was not registered" }
    $executable = Join-Path $entry.InstallLocation.Trim('"') "$app.exe"
    if (!(Test-Path $executable)) { throw "$app installed executable is missing" }
    $installed += @{ app = $app; executable = $executable; version = $entry.DisplayVersion; installerExitCode = $process.ExitCode }
}
ConvertTo-Json -InputObject $installed | Set-Content -Encoding utf8 (Join-Path $Reports 'Windows-installation.json')
