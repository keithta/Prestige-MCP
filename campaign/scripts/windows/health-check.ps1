<#
.SYNOPSIS
  Check that the campaign system is healthy.

.DESCRIPTION
  Reports on the services, the worker's queue view, and anything needing
  attention. Safe to run at any time; it changes nothing.

  Exit code 0 = healthy, 1 = degraded, 2 = unhealthy. Suitable for a scheduled
  task that emails you when it returns non-zero.
#>
[CmdletBinding()]
param(
  [int]$WorkerPort = 3001,
  [int]$WebPort = 3000,
  [string]$ServicePrefix = 'Campaign'
)

$exit = 0
function Warn { param($m) Write-Host "  WARN  $m" -ForegroundColor Yellow; if ($script:exit -lt 1) { $script:exit = 1 } }
function Fail { param($m) Write-Host "  FAIL  $m" -ForegroundColor Red;    $script:exit = 2 }
function Ok   { param($m) Write-Host "  ok    $m" -ForegroundColor Green }

Write-Host 'Services' -ForegroundColor Cyan
foreach ($name in @("$ServicePrefix-Worker", "$ServicePrefix-Web")) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $service)                   { Fail "$name is not installed" }
  elseif ($service.Status -ne 'Running') { Fail "$name is $($service.Status)" }
  else                                 { Ok "$name is running" }
}

Write-Host ''
Write-Host 'Worker' -ForegroundColor Cyan
try {
  $health = Invoke-RestMethod -Uri "http://localhost:$WorkerPort/health" -TimeoutSec 10
  Ok "responding (status: $($health.status))"

  $q = $health.queue
  Write-Host "        queued=$($q.queued) ready=$($q.ready_now) in flight=$($q.in_flight)"
  Write-Host "        sent last hour=$($q.sent_last_hour) last 24h=$($q.sent_last_24h)"

  # These are the three that mean somebody needs to look.
  if ($q.emergency_stop)             { Warn 'EMERGENCY STOP is engaged. Nothing will send.' }
  if (-not $q.global_send_enabled)   { Warn 'Global sending is switched off.' }
  if ($q.needs_reconciliation -gt 0) { Warn "$($q.needs_reconciliation) send(s) have an unknown outcome awaiting reconciliation." }
  if ($q.expired_leases -gt 0)       { Warn "$($q.expired_leases) expired lease(s). A worker may have died." }
  if ($q.open_critical_alerts -gt 0) { Warn "$($q.open_critical_alerts) open critical alert(s). Check the console." }

  if (-not $q.production_mode) {
    Write-Host '        production mode is OFF (test allowlist only)' -ForegroundColor DarkGray
  }
}
catch {
  Fail "the worker did not respond on port $WorkerPort : $($_.Exception.Message)"
}

Write-Host ''
Write-Host 'Console' -ForegroundColor Cyan
try {
  $response = Invoke-WebRequest -Uri "http://localhost:$WebPort/login" -TimeoutSec 10 -UseBasicParsing
  if ($response.StatusCode -eq 200) { Ok "responding on port $WebPort" }
  else { Warn "returned HTTP $($response.StatusCode)" }
}
catch {
  Fail "the console did not respond on port $WebPort : $($_.Exception.Message)"
}

Write-Host ''
switch ($exit) {
  0 { Write-Host 'Healthy.' -ForegroundColor Green }
  1 { Write-Host 'Degraded - the system is safe, but something needs attention.' -ForegroundColor Yellow }
  2 { Write-Host 'Unhealthy - sending is not working.' -ForegroundColor Red }
}
exit $exit
