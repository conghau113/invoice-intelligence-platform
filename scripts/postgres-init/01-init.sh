#!/bin/sh
# Runs once on first start of an empty data volume.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DATABASE "${KEYCLOAK_DB:-keycloak}";
SQL
