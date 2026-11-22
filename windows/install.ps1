# Build fwd.exe with the compiler that ships with Windows, then run it in the
# interactive session at every logon. Run from an elevated shell as the user
# who owns the desktop.
$ErrorActionPreference = 'Stop'
$root = 'C:\dev\fw'
$fx = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'

# The daemon runs with the user's full rights. Only SYSTEM and Administrators
# may touch its folder, so a process of the same user without elevation (or
# another user) cannot read the token, swap fwd.exe or read screenshots.
# Administrators also own it, so the user cannot reopen the ACL as owner.
New-Item -ItemType Directory -Force -Path $root | Out-Null
# The grant goes on the folder only; everything inside is reset to inherit it.
# (OI)(CI) on a file is not valid and would leave the file with an empty ACL.
icacls $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /C /Q | Out-Null
icacls $root /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
icacls "$root\*" /reset /T /C /Q 2>&1 | Out-Null

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
Register-ScheduledTask -TaskName fw -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName fw
Start-Sleep -Seconds 2
if (-not (Get-Process fwd -ErrorAction SilentlyContinue)) { throw 'fwd did not start; is this user logged in at the console?' }
'fwd is running'
