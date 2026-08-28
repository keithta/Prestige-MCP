<#
.SYNOPSIS
  Install the campaign worker and console as Windows services.

.DESCRIPTION
  Uses NSSM (the Non-Sucking Service Manager) to run both Node processes as
  auto-starting services with restart-on-failure and log rotation.

  Only ONE worker instance may run. The worker itself enforces this with a
  PostgreSQL advisory lock, so a second install fails loudly at startup rather
  than quietly doubling throughput -- but do not install it twice anyway.

.EXAMPLE
  .\install-service.ps1 -InstallPath C:\campaign -NssmPath C:\tools\nssm.exe
#>
[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\campaign',
  [string]$NssmPath    = 'C:\tools\nssm.exe',
  [string]$NodePath    = (Get-Command node -ErrorAction SilentlyContinue).Source,
  [string]$LogPath     = 'C:\ProgramData\CampaignApp\logs',
  [string]$ServicePrefix = 'Campaign',
  [int]$WebPort = 3000,
  [int]$WorkerPort = 3001
)

$ErrorActionPreference = 'Stop'

function Assert-Administrator {
  $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell session (Run as Administrator).'
  }
}

Assert-Administrator

if (-not $NodePath)            { throw 'Node.js was not found on PATH. Install Node 20 or newer.' }
if (-not (Test-Path $NssmPath)) { throw "NSSM was not found at $NssmPath. Download it from https://nssm.cc/download." }
if (-not (Test-Path $InstallPath)) { throw "The application was not found at $InstallPath." }

$campaignRoot = Join-Path $InstallPath 'campaign'
if (-not (Test-Path $campaignRoot)) { throw "Expected the application at $campaignRoot." }

$envFile = Join-Path $campaignRoot '.env'
if (-not (Test-Path $envFile)) {
  throw "No .env at $envFile. Copy .env.example and fill it in first (docs/ENVIRONMENT.md)."
}

# Refuse to install a service that cannot possibly start.
Write-Host 'Checking the configuration...' -ForegroundColor Cyan
Push-Location $campaignRoot
try {
  & $NodePath (Join-Path $campaignRoot 'node_modules\tsx\dist\cli.mjs') 'scripts\verify-env.ts' 'all'
  if ($LASTEXITCODE -ne 0) { throw 'Configuration is incomplete. Fix the values above and run this again.' }
} finally { Pop-Location }

New-Item -ItemType Directory -Force -Path $LogPath | Out-Null

function Install-CampaignService {
  param(
    [string]$Name,
    [string]$Script,
    [string]$WorkingDirectory,
    [string]$Description,
    [hashtable]$ExtraEnvironment = @{}
  )

  $existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "  $Name already exists; stopping and reconfiguring." -ForegroundColor Yellow
    & $NssmPath stop $Name confirm | Out-Null
    Start-Sleep -Seconds 2
    & $NssmPath remove $Name confirm | Out-Null
    Start-Sleep -Seconds 1
  }

  & $NssmPath install $Name $NodePath $Script          | Out-Null
  & $NssmPath set $Name AppDirectory $WorkingDirectory | Out-Null
  & $NssmPath set $Name Description $Description       | Out-Null
  & $NssmPath set $Name Start SERVICE_AUTO_START       | Out-Null

  # Restart on failure, backing off so a misconfiguration does not spin.
  & $NssmPath set $Name AppExit Default Restart        | Out-Null
  & $NssmPath set $Name AppRestartDelay 10000          | Out-Null
  & $NssmPath set $Name AppThrottle 30000              | Out-Null

  # SIGTERM equivalent first: the worker finishes what it is doing and hands
  # back any leases it has not started.
  & $NssmPath set $Name AppStopMethodConsole 30000     | Out-Null
  & $NssmPath set $Name AppStopMethodWindow  10000     | Out-Null
  & $NssmPath set $Name AppStopMethodThreads 10000     | Out-Null

  & $NssmPath set $Name AppStdout (Join-Path $LogPath "$Name.out.log") | Out-Null
  & $NssmPath set $Name AppStderr (Join-Path $LogPath "$Name.err.log") | Out-Null
  & $NssmPath set $Name AppRotateFiles 1               | Out-Null
  & $NssmPath set $Name AppRotateOnline 1              | Out-Null
  & $NssmPath set $Name AppRotateBytes 10485760        | Out-Null

  & $NssmPath set $Name AppEnvironmentExtra "ENV_FILE=$envFile" "NODE_ENV=production" | Out-Null
  foreach ($key in $ExtraEnvironment.Keys) {
    & $NssmPath set $Name AppEnvironmentExtra "$key=$($ExtraEnvironment[$key])" | Out-Null
  }

  Write-Host "  installed $Name" -ForegroundColor Green
}

Write-Host 'Installing services...' -ForegroundColor Cyan

Install-CampaignService `
  -Name "$ServicePrefix-Worker" `
  -Script (Join-Path $campaignRoot 'apps\worker\dist\index.js') `
  -WorkingDirectory $campaignRoot `
  -Description 'Campaign sending worker. Consumes emails already authorized by the database and submits them to Microsoft Graph.' `
  -ExtraEnvironment @{ WORKER_PORT = $WorkerPort }

Install-CampaignService `
  -Name "$ServicePrefix-Web" `
  -Script (Join-Path $campaignRoot 'node_modules\next\dist\bin\next') `
  -WorkingDirectory (Join-Path $campaignRoot 'apps\web') `
  -Description 'Campaign admin console.' `
  -ExtraEnvironment @{ WEB_PORT = $WebPort }

& $NssmPath set "$ServicePrefix-Web" AppParameters "start -p $WebPort" | Out-Null

Write-Host 'Starting services...' -ForegroundColor Cyan
Start-Service "$ServicePrefix-Worker"
Start-Service "$ServicePrefix-Web"

Start-Sleep -Seconds 5

foreach ($name in @("$ServicePrefix-Worker", "$ServicePrefix-Web")) {
  $service = Get-Service -Name $name
  $colour = if ($service.Status -eq 'Running') { 'Green' } else { 'Red' }
  Write-Host "  $name : $($service.Status)" -ForegroundColor $colour
}

Write-Host ''
Write-Host "Console : http://localhost:$WebPort"     -ForegroundColor Cyan
Write-Host "Health  : http://localhost:$WorkerPort/health" -ForegroundColor Cyan
Write-Host "Logs    : $LogPath"                       -ForegroundColor Cyan
Write-Host ''
Write-Host 'Verify with: .\health-check.ps1' -ForegroundColor Yellow
