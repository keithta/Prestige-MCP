<#
.SYNOPSIS
  Back up the campaign schema to a local file.

.DESCRIPTION
  A logical dump of the `campaign` schema only, so it can be restored beside
  whatever else lives in the database. This is a SECOND line of defence: your
  managed database's own backups are the first. Neither is a substitute for the
  other -- this one protects against a mistake made inside the application
  (a bad migration, a wrong bulk edit), which a point-in-time restore of the
  whole project would be a heavy way to undo.

  Retention defaults to 30 days.

.EXAMPLE
  .\backup.ps1 -BackupPath D:\backups\campaign
#>
[CmdletBinding()]
param(
  [string]$BackupPath = 'C:\ProgramData\CampaignApp\backups',
  [string]$EnvFile    = 'C:\campaign\campaign\.env',
  [int]$RetentionDays = 30,
  [string]$PgDumpPath = 'pg_dump'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $EnvFile)) { throw "No .env at $EnvFile." }

$databaseUrl = (Get-Content $EnvFile |
  Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } |
  Select-Object -First 1) -replace '^\s*DATABASE_URL\s*=\s*', '' -replace '^"|"$', ''

if (-not $databaseUrl) { throw "DATABASE_URL was not found in $EnvFile." }

New-Item -ItemType Directory -Force -Path $BackupPath | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file  = Join-Path $BackupPath "campaign-$stamp.dump"

Write-Host "Backing up the campaign schema to $file ..." -ForegroundColor Cyan

# Custom format: compressed, and restorable selectively with pg_restore.
& $PgDumpPath --dbname=$databaseUrl --schema=campaign --format=custom --no-owner --no-privileges --file=$file
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE." }

$size = [math]::Round((Get-Item $file).Length / 1MB, 2)
Write-Host "  wrote $size MB" -ForegroundColor Green

# A backup nobody can restore is not a backup. Prove the file is readable.
& $PgDumpPath --version | Out-Null
$listing = & pg_restore --list $file 2>$null
if (-not $listing) { throw "The dump could not be read back. Treat this backup as failed." }
Write-Host "  verified readable ($($listing.Count) objects)" -ForegroundColor Green

$cutoff = (Get-Date).AddDays(-$RetentionDays)
$removed = Get-ChildItem -Path $BackupPath -Filter 'campaign-*.dump' |
  Where-Object { $_.LastWriteTime -lt $cutoff }
foreach ($old in $removed) {
  Remove-Item $old.FullName -Force
  Write-Host "  removed expired backup $($old.Name)" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host "Restore with:" -ForegroundColor Cyan
Write-Host "  pg_restore --dbname=`$env:DATABASE_URL --schema=campaign --clean --if-exists `"$file`""
