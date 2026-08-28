<#
.SYNOPSIS
  Remove the campaign Windows services.

.DESCRIPTION
  Stops both services and removes them. The worker is stopped gracefully first
  so it hands back any leases it holds; otherwise those jobs wait for the lease
  to expire before another worker can pick them up.

  Nothing in the database is touched.
#>
[CmdletBinding()]
param(
  [string]$NssmPath = 'C:\tools\nssm.exe',
  [string]$ServicePrefix = 'Campaign'
)

$ErrorActionPreference = 'Stop'

foreach ($name in @("$ServicePrefix-Worker", "$ServicePrefix-Web")) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $service) {
    Write-Host "  $name is not installed." -ForegroundColor Yellow
    continue
  }

  Write-Host "  stopping $name (waiting for a graceful shutdown)..." -ForegroundColor Cyan
  & $NssmPath stop $name confirm | Out-Null
  Start-Sleep -Seconds 3

  & $NssmPath remove $name confirm | Out-Null
  Write-Host "  removed $name" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Services removed. Campaign data is untouched.' -ForegroundColor Cyan
