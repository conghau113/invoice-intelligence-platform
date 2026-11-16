#!/usr/bin/env bash
# T6.7: what the failure drill must prove, for the documents created since a moment (UTC, ISO 8601).
#
#   load/drill/check.sh 2026-11-16T10:00:00Z          # report; exit 1 if a job is lost or duplicated
#   load/drill/check.sh 2026-11-16T10:00:00Z 2026-11-16T10:05:00Z   # only documents created before the 2nd
#
# Reads the LOCAL dev infra only (compose.yaml): Postgres as its owner (dev superuser, so RLS does
# not hide other tenants) and Redis with redis-cli, both inside their containers. Prints ids,
# statuses and counts, never document content.
#
#   lost        a document still `queued`/`processing` with no live BullMQ job: the job key is gone
#               (e.g. Redis restarted without its data) or the job already finished (`finishedOn`
#               is set: completed or finally failed). Nothing will ever move such a document again.
#   duplicate   more than one extraction for one (document, version), or a document that reached
#               `needs_review` more often than it has versions. The first cannot happen while the
#               unique key exists; both are a backstop. Retries and redeliveries show in the
#               `times_processing` table, and repeated AI calls only in the AI service's access log.
#
# A document that is `queued`/`processing` WITH a live job is in flight, not lost: run the check
# again once the queue is empty. Exits 2 if Postgres or Redis cannot be read: no answer is no proof.
set -euo pipefail
# Exit 1 means "lost or duplicated"; a command that failed (Postgres or Redis unreachable) is 2.
trap 'echo "could not read Postgres or Redis: no result" >&2; exit 2' ERR

from_ts="${1:?usage: load/drill/check.sh <since> [until], e.g. 2026-11-16T10:00:00Z}"
to_ts="${2:-infinity}"
# Only digits, '-', ':', 'T', 'Z', '.', '+' (or "infinity"): both are pasted into SQL below.
for t in "$from_ts" "$to_ts"; do
  if [[ ! "$t" =~ ^([0-9T:.Z+-]+|infinity)$ ]]; then
    echo "since and until must be ISO 8601 timestamps" >&2
    exit 2
  fi
done
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

psql() {
  docker compose exec -T postgres psql -U "${POSTGRES_USER:-invoice}" -d "${POSTGRES_DB:-invoice}" \
    -At -F ' ' -v ON_ERROR_STOP=1 -c "$1" </dev/null
}
redis() {
  docker compose exec -T redis redis-cli "$@" </dev/null
}

batch="select id from documents where created_at >= '$from_ts'::timestamptz and created_at < '$to_ts'::timestamptz"

echo "== documents created from $from_ts to $to_ts, by status"
psql "select status, count(*) from documents where id in ($batch) group by status order by status"

echo "== BullMQ extraction queue"
for list in wait active paused; do
  printf '%-12s %s\n' "$list" "$(redis LLEN "bull:extraction:$list")"
done
for zset in prioritized delayed failed completed; do
  printf '%-12s %s\n' "$zset" "$(redis ZCARD "bull:extraction:$zset")"
done

echo "== lost: unsettled documents without a live job"
# Command substitution, not `< <(...)`: a failure inside a process substitution escapes `set -e`
# and would leave an empty list, i.e. "nothing lost" without having looked.
rows="$(psql "select id, status from documents where id in ($batch) and status in ('queued', 'processing') order by created_at")"
unsettled=()
[[ -n "$rows" ]] && mapfile -t unsettled <<<"$rows"
lost=0
if ((${#unsettled[@]} > 0)); then
  # One redis-cli for all of them (one `docker compose exec` each would take minutes): two answers
  # per document, in order: does the job key exist, has the job finished.
  answers="$(
    for row in "${unsettled[@]}"; do
      id="${row%% *}"
      printf 'EXISTS bull:extraction:%s\nHEXISTS bull:extraction:%s finishedOn\n' "$id" "$id"
    done | docker compose exec -T redis redis-cli
  )"
  mapfile -t reply <<<"$answers"
  if ((${#reply[@]} != 2 * ${#unsettled[@]})); then
    echo "redis-cli gave ${#reply[@]} answers for ${#unsettled[@]} documents: cannot tell" >&2
    exit 2
  fi
  for i in "${!unsettled[@]}"; do
    exists="${reply[$((2 * i))]}"
    finished="${reply[$((2 * i + 1))]}"
    if [[ ! "$exists$finished" =~ ^[01][01]$ ]]; then
      echo "unexpected redis-cli answer for ${unsettled[$i]%% *}: cannot tell" >&2
      exit 2
    fi
    if [[ "$exists" == "0" ]]; then
      echo "LOST ${unsettled[$i]} (no job)"
      lost=$((lost + 1))
    elif [[ "$finished" == "1" ]]; then
      echo "LOST ${unsettled[$i]} (job already finished)"
      lost=$((lost + 1))
    fi
  done
fi
echo "lost=$lost (of ${#unsettled[@]} unsettled)"

echo "== duplicate: extractions per (document, version) > 1"
dup_extractions="$(psql "select count(*) from (select 1 from extractions where document_id in ($batch) group by document_id, document_version having count(*) > 1) d")"
echo "duplicate_extractions=$dup_extractions"

echo "== duplicate: reached needs_review more often than versions"
# Each reopen makes a new version, so a document may reach needs_review once per version.
dup_reviews="$(psql "select count(*) from (
  select a.entity_id from audit_logs a join documents d on d.id = a.entity_id
  where a.entity_id in ($batch) and a.action = 'document.status_changed' and a.meta->>'to' = 'needs_review'
  group by a.entity_id, d.version having count(*) > d.version) r")"
echo "duplicate_needs_review=$dup_reviews"

echo "== attempts: entries into processing, per document (retries and redeliveries)"
psql "select n as times_processing, count(*) as documents from (
  select count(*) as n from audit_logs
  where entity_id in ($batch) and action = 'document.status_changed' and meta->>'to' = 'processing'
  group by entity_id) p group by n order by n"

echo "== failure codes"
psql "select coalesce(failure_code, '-'), count(*) from documents where id in ($batch) and status = 'failed' group by 1"

if ((lost > 0 || dup_extractions > 0 || dup_reviews > 0)); then
  echo "RESULT: FAIL (lost=$lost duplicate_extractions=$dup_extractions duplicate_needs_review=$dup_reviews)"
  exit 1
fi
echo "RESULT: OK (no lost job, nothing processed twice)"
