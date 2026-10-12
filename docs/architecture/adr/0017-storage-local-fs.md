# ADR 0017: File storage: StoragePort with a local filesystem adapter (MinIO rejected)

- Status: Accepted
- Date: 2026-10-11

## Context
Uploaded invoices must be stored for processing and review. Constraint: zero cost, no card. MinIO community edition was archived on 2026-04-25 ("no longer maintained", source-only, no new binaries), so it would receive no security fixes; AIStor Free is proprietary (no modification/redistribution). Cloudflare R2 needs a payment method. SeaweedFS (Apache 2.0) is S3-compatible and production-ready but adds operational complexity.

## Options considered
1. Local filesystem behind a port
2. SeaweedFS (S3 API)
3. MinIO community
4. MinIO AIStor Free
5. Cloudflare R2

## Decision criteria
- Zero cost and no card
- Maintained / patched
- Simplicity for a single VM
- Path to S3 later

## Decision
Define `StoragePort` (put/get/delete/stat) with a `LocalFs` adapter writing to a mounted volume (`DATA_DIR`); uploads are streamed through the API; downloads go through the API after authorization. A contract test suite makes adding a SeaweedFS adapter (optional task O1) a drop-in change.

## Consequences
- + Simplest possible, no extra service
- + Same interface allows S3 later
- − No presigned direct-to-storage uploads (API carries upload bandwidth; fine at demo scale)
- − Files live on the VM disk → included in backups

## Revisit when
Multiple app instances need shared storage, or the owner wants to learn S3 (do O1).
