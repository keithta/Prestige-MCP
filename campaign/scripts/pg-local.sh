#!/usr/bin/env bash
# Local PostgreSQL cluster for integration + concurrency testing.
#
# Docker is not available in every dev/CI environment, but the PostgreSQL server
# binaries usually are. This script boots a throwaway cluster on a non-default
# port so tests get a REAL multi-connection Postgres (needed to prove
# FOR UPDATE ... SKIP LOCKED actually prevents double-claiming).
#
#   scripts/pg-local.sh up      start (idempotent)
#   scripts/pg-local.sh down    stop
#   scripts/pg-local.sh reset   drop + recreate the database
#   scripts/pg-local.sh psql    open a shell
#   scripts/pg-local.sh url     print the connection string
set -euo pipefail

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PGDATA_DIR="${PGDATA_DIR:-/var/tmp/campaign-pg/data}"
PGPORT_LOCAL="${PGPORT_LOCAL:-55432}"
PGDB="${PGDB:-campaign_test}"
PGUSER_LOCAL="${PGUSER_LOCAL:-campaign}"
PGPASS_LOCAL="${PGPASS_LOCAL:-campaign}"
LOGFILE="${PGDATA_DIR%/data}/postgres.log"

if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "ERROR: PostgreSQL server binaries not found. Set PGBIN=/path/to/postgres/bin" >&2
  exit 1
fi

# postgres refuses to run as root; when we are root we drop to the postgres account.
RUNAS=""
if [ "$(id -u)" -eq 0 ]; then
  RUNAS="postgres"
  id postgres >/dev/null 2>&1 || { echo "ERROR: running as root but no 'postgres' user exists" >&2; exit 1; }
fi

run() {  # run a command as the cluster owner
  if [ -n "$RUNAS" ]; then su "$RUNAS" -s /bin/bash -c "$1"; else bash -c "$1"; fi
}

url() { echo "postgresql://${PGUSER_LOCAL}:${PGPASS_LOCAL}@127.0.0.1:${PGPORT_LOCAL}/${PGDB}"; }

is_up() { "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT_LOCAL" -q 2>/dev/null; }

up() {
  if is_up; then echo "postgres already running on :$PGPORT_LOCAL"; url; return 0; fi

  mkdir -p "$PGDATA_DIR" "$(dirname "$LOGFILE")"
  if [ -n "$RUNAS" ]; then chown -R "$RUNAS" "$(dirname "$PGDATA_DIR")"; fi

  if [ ! -f "$PGDATA_DIR/PG_VERSION" ]; then
    echo "initdb -> $PGDATA_DIR"
    run "$PGBIN/initdb -D '$PGDATA_DIR' -U postgres --auth-local=trust --auth-host=trust -E UTF8 --locale=C" >/dev/null
    # Loopback only. This cluster is disposable test infrastructure, never production.
    run "printf '%s\n' \"listen_addresses='127.0.0.1'\" \"port=$PGPORT_LOCAL\" \"fsync=off\" \"synchronous_commit=off\" \"full_page_writes=off\" \"max_connections=100\" \"log_min_messages=warning\" >> '$PGDATA_DIR/postgresql.conf'"
  fi

  echo "starting postgres on :$PGPORT_LOCAL"
  run "$PGBIN/pg_ctl -D '$PGDATA_DIR' -l '$LOGFILE' -w -t 30 start" >/dev/null

  run "$PGBIN/psql -h 127.0.0.1 -p $PGPORT_LOCAL -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$PGUSER_LOCAL') THEN CREATE ROLE $PGUSER_LOCAL LOGIN SUPERUSER PASSWORD '$PGPASS_LOCAL'; END IF; END \\\$\\\$;\""
  run "$PGBIN/psql -h 127.0.0.1 -p $PGPORT_LOCAL -U postgres -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='$PGDB'\" | grep -q 1 || $PGBIN/createdb -h 127.0.0.1 -p $PGPORT_LOCAL -U postgres -O $PGUSER_LOCAL $PGDB"

  echo "ready: $(url)"
}

down() {
  if is_up; then run "$PGBIN/pg_ctl -D '$PGDATA_DIR' -m fast -w stop" >/dev/null && echo "stopped"; else echo "not running"; fi
}

reset() {
  up >/dev/null
  run "$PGBIN/psql -h 127.0.0.1 -p $PGPORT_LOCAL -U postgres -d postgres -q -c \"DROP DATABASE IF EXISTS $PGDB WITH (FORCE)\""
  run "$PGBIN/createdb -h 127.0.0.1 -p $PGPORT_LOCAL -U postgres -O $PGUSER_LOCAL $PGDB"
  echo "reset: $(url)"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  reset) reset ;;
  url) url ;;
  psql) exec "$PGBIN/psql" "$(url)" ;;
  status) is_up && echo "running on :$PGPORT_LOCAL" || { echo "not running"; exit 1; } ;;
  *) echo "usage: $0 {up|down|reset|url|psql|status}" >&2; exit 2 ;;
esac
