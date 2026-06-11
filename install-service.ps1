# install-service.ps1 — make the RushPoint Autopilot survive reboots.
# Registers a per-user logon Scheduled Task that launches the watchdog (which keeps the supervisor
# alive forever). Also starts it now. Re-run safely (idempotent). Requires no admin rights.
#
#   Install + start:   powershell -ExecutionPolicy Bypass -File autopilot\install-service.ps1
#   Remove (reboot survival only; use `supervisor.mjs stop` to halt the running loop):
#                      powershell -ExecutionPolicy Bypass -File autopilot\install-service.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName  = 'RushPointAutopilot'
$Root      = Split-Path -Parent $PSScriptRoot          # the worktree root
$Watchdog  = Join-Path $PSScriptRoot 'watchdog.mjs'
$NodeExe   = (Get-Command node).Source

if ($Remove) {
  schtasks /delete /tn $TaskName /f 2>$null | Out-Null
  Write-Host "Removed logon task '$TaskName'. (The running loop keeps going until: node autopilot/supervisor.mjs stop)"
  return
}

if (-not (Test-Path $Watchdog)) { throw "watchdog.mjs not found at $Watchdog" }

# Logon trigger → run the watchdog. /rl LIMITED = no admin. Working dir is irrelevant (watchdog uses
# absolute paths) but we point the action's start-in at the repo for clarity.
$action = "`"$NodeExe`" `"$Watchdog`""
schtasks /create /tn $TaskName /tr $action /sc onlogon /rl LIMITED /f | Out-Null
Write-Host "Registered logon task '$TaskName' → it will relaunch the watchdog after every reboot/login."

# Start it now (detached), unless the user has a standing STOP.
$stop = Join-Path $PSScriptRoot 'state\STOP'
if (Test-Path $stop) { Remove-Item $stop -Force; Write-Host "Cleared standing STOP flag." }
$existing = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'watchdog.mjs' }
if ($existing) {
  Write-Host "Watchdog already running (pid $($existing.ProcessId))."
} else {
  Start-Process -FilePath $NodeExe -ArgumentList "`"$Watchdog`"" -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
  Write-Host "Watchdog started now (detached). The autopilot is running continuously."
}
Write-Host ""
Write-Host "Controls:"
Write-Host "  Stop      : node autopilot/supervisor.mjs stop"
Write-Host "  Resume    : node autopilot/supervisor.mjs start"
Write-Host "  Add task  : node autopilot/supervisor.mjs add `"<what you want>`""
Write-Host "  Status    : node autopilot/supervisor.mjs status"
