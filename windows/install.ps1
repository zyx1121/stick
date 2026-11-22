# Build fwd.exe with the compiler that ships with Windows, then run it in the
# interactive session at every logon. Run from an elevated shell as the user
# who owns the desktop.
$ErrorActionPreference = 'Stop'
$root = 'C:\dev\fw'
$fx = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'

# Only SYSTEM and Administrators may touch the folder (see lock.ps1).
& (Join-Path $PSScriptRoot 'lock.ps1')

Stop-ScheduledTask -TaskName fw -ErrorAction SilentlyContinue
Get-Process fwd -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

& "$fx\csc.exe" /nologo /optimize /target:winexe /out:"$root\fwd.exe" `
    /lib:"$fx\WPF" /r:UIAutomationClient.dll /r:UIAutomationTypes.dll /r:WindowsBase.dll `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll "$root\src\fwd.cs"
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

# A new token on every install: a token file that already exists may have been planted.
$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[IO.File]::WriteAllText("$root\token", (($bytes | ForEach-Object { $_.ToString('x2') }) -join ''))

$action = New-ScheduledTaskAction -Execute "$root\fwd.exe"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
# Lock again: fwd.exe and the token are new files.
& (Join-Path $PSScriptRoot 'lock.ps1')

Register-ScheduledTask -TaskName fw -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName fw
Start-Sleep -Seconds 2
if (-not (Get-Process fwd -ErrorAction SilentlyContinue)) { throw 'fwd did not start; is this user logged in at the console?' }
'fwd is running'
