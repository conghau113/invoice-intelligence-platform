#!/bin/sh
# Production database roles (T4.7). Runs once, on the first start of an empty data volume, as the
# image's superuser (POSTGRES_USER=postgres), which is used for nothing else afterwards except the
# one-off demo data import.
#
#   invoice_owner  owns the `invoice` database and its tables; runs migrations. NOT a superuser,
#                  so FORCE ROW LEVEL SECURITY applies to it (Phát sinh T0.6/T1.3). CREATEROLE
#                  because migration 0001 creates invoice_app.
#   invoice_app    runtime role of the API and worker, created by the migrations (no BYPASSRLS).
#   keycloak       owns only the separate `keycloak` database.
#
# Passwords travel as psql variables (:'name' quotes them as literals), never pasted into SQL.
set -eu
: "${OWNER_DB_PASSWORD:?}" "${KEYCLOAK_DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -v owner_pw="$OWNER_DB_PASSWORD" -v keycloak_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE invoice_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB PASSWORD :'owner_pw';
CREATE DATABASE invoice OWNER invoice_owner;
CREATE ROLE keycloak LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD :'keycloak_pw';
CREATE DATABASE keycloak OWNER keycloak;
SQL

# Extensions need a superuser; create the ones the schema uses (pgvector, ADR 0011) up front.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d invoice <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
SQL
