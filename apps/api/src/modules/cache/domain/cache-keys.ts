import { isUuid } from '../../../common/uuid';

/**
 * Every cache key of the API (ADR 0013): the tenant is always the first part, inside a hash tag
 * (`{tenantId}`, the same convention as the rate-limit buckets) so one tenant's keys stay on one
 * slot if Redis is ever clustered. Builders refuse anything that is not a uuid, a sha256 or a short
 * version token: a key is never built from free text, so a value cannot reach another tenant's key
 * by containing `:` or `}`.
 */

/** Names of the cached reads; also the field prefix of the hit/miss counters. */
export const READ_CACHES = ['documents-list', 'insights-online'] as const;
export type ReadCacheName = (typeof READ_CACHES)[number];
export const EXTRACTION_CACHE = 'extraction-result';
/** Counter name of the generation bumps (only failures are counted). */
export const GENERATION = 'generation';
export type CacheName = ReadCacheName | typeof EXTRACTION_CACHE | typeof GENERATION;

/** Counters of hits and misses, one hash for the whole process fleet. Counts only, no tenant. */
export const STATS_KEY = 'cache:stats';

const SHA256 = /^[0-9a-f]{64}$/;
// A model name (`gemini-3.5-flash-lite`), a prompt version (`invoice_extraction/v1`) or a hash.
const VERSION_TOKEN = /^[A-Za-z0-9._/-]{1,128}$/;

function tenant(tenantId: string): string {
  if (!isUuid(tenantId)) throw new Error('Invalid tenant id');
  return `cache:{${tenantId.toLowerCase()}}`;
}

/**
 * Generation of one tenant's cached reads. Every write to the tenant's documents increments it after
 * COMMIT; readers put the number they read into their key, so older entries are never read again and
 * expire on their own TTL. O(1), and no SCAN/DEL race with a reader that is still filling the old key.
 */
export const generationKey = (tenantId: string): string => `${tenant(tenantId)}:gen`;

/**
 * One cached read. `params` is the validated query, written in a fixed key order (the caller passes
 * plain values: numbers, enums, YYYY-MM-DD), so the same query always maps to the same key.
 */
export function readKey(
  tenantId: string,
  generation: number,
  name: ReadCacheName,
  params: Readonly<Record<string, string | number | undefined>> = {},
): string {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid generation');
  const parts = Object.keys(params)
    .sort((a, b) => a.localeCompare(b))
    .filter((k) => params[k] !== undefined)
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`);
  return `${tenant(tenantId)}:g${generation}:${name}:${parts.join('&')}`;
}

export interface ExtractionVersion {
  model: string;
  promptVersion: string;
  pipelineVersion: string;
}

export const isExtractionVersion = (v: ExtractionVersion): boolean =>
  VERSION_TOKEN.test(v.model) &&
  VERSION_TOKEN.test(v.promptVersion) &&
  VERSION_TOKEN.test(v.pipelineVersion);

/**
 * A stored extraction result: same tenant, same bytes, same model, prompt and pipeline code (ADR 0013,
 * Phát sinh T4.1b). The tenant is part of it on purpose (T6.3, option A): a shared key would tell one
 * tenant, through latency or a $0 cost, that another tenant uploaded the same file.
 */
export function extractionKey(
  tenantId: string,
  contentHash: string,
  version: ExtractionVersion,
): string {
  if (!SHA256.test(contentHash)) throw new Error('Invalid content hash');
  if (!isExtractionVersion(version)) throw new Error('Invalid extraction version');
  const { model, promptVersion, pipelineVersion } = version;
  return `${tenant(tenantId)}:extract:${contentHash}:${model}:${promptVersion}:${pipelineVersion}`;
}

/** Held by the one worker calling the AI service for that key (request coalescing, Phát sinh T2.9). */
export const extractionLockKey = (resultKey: string): string => `${resultKey}:lock`;
