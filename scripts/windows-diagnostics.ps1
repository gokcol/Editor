param([string]$App, [string]$Reports)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force $Reports | Out-Null
Get-Process -Name 7TXT,Yedit,msedgewebview2 -ErrorAction SilentlyContinue |
    Select-Object Id,ProcessName,MainWindowTitle,Responding | ConvertTo-Json
Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('7TXT.exe','Yedit.exe','msedgewebview2.exe') } |
    Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 4
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in @(9222,9223) } | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json
try {
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
    $bitmap.Save((Join-Path $Reports "$App-Windows-desktop.png"))
    $graphics.Dispose()
    $bitmap.Dispose()
} catch { Write-Output "Screenshot unavailable: $_" }
