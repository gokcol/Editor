param([string]$Packages = 'release', [string]$Reports = 'release')
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This installer verification helper is for disposable GitHub Actions runners only.' }
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
    # CI-only debugging policy, scoped to these two installed executables.
    # Elevated hosted runners require machine policy (WebView2 150+).
    # https://github.com/MicrosoftEdge/WebView2Feedback/issues/5645
    $port = if ($app -eq '7TXT') { 9222 } else { 9223 }
    $identifier = if ($app -eq '7TXT') { 'com.gokcol.7txt' } else { 'com.yedit.desktop' }
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,$view)
        $arguments = $root.CreateSubKey('Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments')
        $profile = $root.CreateSubKey('Software\Policies\Microsoft\Edge\WebView2\UserDataFolder')
        foreach ($id in @("$app.exe",$app,$identifier,$executable)) {
            $arguments.SetValue($id,"--remote-debugging-port=$port",[Microsoft.Win32.RegistryValueKind]::String)
            $profile.SetValue($id,(Join-Path $env:RUNNER_TEMP "editor-webview-$app"),[Microsoft.Win32.RegistryValueKind]::String)
        }
        $arguments.Close(); $profile.Close(); $root.Close()
    }
}
ConvertTo-Json -InputObject $installed | Set-Content -Encoding utf8 (Join-Path $Reports 'Windows-installation.json')
