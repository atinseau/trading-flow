#!/bin/bash
set -e

# Connect explicitly to $POSTGRES_DB (the bootstrap DB postgres always creates).
# Without --dbname, psql defaults to a DB matching the username, which only
# exists by coincidence when POSTGRES_USER == POSTGRES_DB. Breaks the moment
# you set a non-default POSTGRES_USER (then "FATAL: database <user> does not exist").
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE temporal;
  CREATE DATABASE temporal_visibility;
EOSQL
