/**
 * T6.1: drive one user over the API's rate limits and check every 429 (ADR 0012, NFR-09).
 *
 * Runs in the official k6 image (AGPL-3.0, unmodified, dev tool only: docs/LEGAL.md), against a
 * local API. The bearer token comes from the dev realm's `dev-cli` client (see README.md here);
 * nothing in this script calls an LLM.
 *
 *   read: 300 GET /documents from 20 VUs, as fast as they go. The `read` user bucket holds 120
 *         and refills 2 a second, so at most 120 + 2 per second of the run may pass.
 *   qa:   10 POST /qa/ask at the same moment. The `qa` user bucket holds 5: 5 reach the Q&A
 *         service (503 while the AI service is not running, which keeps this run free), the rest
 *         are 429 before any model could be called.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const API = __ENV.API_BASE_URL || 'http://localhost:3001';
const TOKEN = __ENV.TOKEN;
if (!TOKEN) throw new Error('Set TOKEN (see load/k6/README.md)');

const READ_CAPACITY = 120;
const READ_REFILL_PER_SECOND = 2;
const READ_MAX_SECONDS = 10;
const QA_CAPACITY = 5;

const allowed = new Counter('allowed');
const limited = new Counter('limited');
const qaPassed = new Counter('qa_passed');
const qaLimited = new Counter('qa_limited');

export const options = {
  scenarios: {
    read: {
      executor: 'shared-iterations',
      exec: 'read',
      vus: 20,
      iterations: 300,
      maxDuration: `${READ_MAX_SECONDS}s`,
    },
    // All at once: sent one after another, each slow call (the AI service is down) would give
    // the bucket time to refill one token every 12 s, and the run would prove nothing.
    qa: {
      executor: 'per-vu-iterations',
      exec: 'qa',
      vus: 10,
      iterations: 1,
      maxDuration: '60s',
    },
  },
  thresholds: {
    // Every response was the one expected (200/429 for reads, 503/429 for qa, with headers).
    checks: ['rate==1'],
    // The limit bit, and never let more through than a full bucket plus what refilled meanwhile.
    limited: ['count>0'],
    // At least a full bucket (a limiter that refuses everything must fail), at most a full bucket
    // plus what refilled during the run. Needs a full bucket: wait a minute between runs.
    allowed: [
      `count>=${READ_CAPACITY}`,
      `count<=${READ_CAPACITY + READ_REFILL_PER_SECOND * READ_MAX_SECONDS}`,
    ],
    qa_passed: [`count==${QA_CAPACITY}`],
    qa_limited: [`count==${10 - QA_CAPACITY}`],
  },
};

const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

/** What every 429 must carry: our code, a whole number of seconds to wait, the RateLimit fields. */
function checkLimited(res, cls) {
  const retryAfter = res.headers['Retry-After'];
  let code;
  try {
    code = res.json('code');
  } catch {
    code = undefined;
  }
  return check(res, {
    [`${cls} 429 has code RATE_LIMITED`]: () => code === 'RATE_LIMITED',
    [`${cls} 429 has Retry-After >= 1 s`]: () =>
      /^\d+$/.test(retryAfter || '') && Number(retryAfter) >= 1,
    [`${cls} 429 has RateLimit with r=0`]: () =>
      new RegExp(`^"${cls}-user";r=0;t=\\d+`).test(res.headers['Ratelimit'] || ''),
    [`${cls} 429 has RateLimit-Policy`]: () =>
      (res.headers['Ratelimit-Policy'] || '').startsWith(`"${cls}-user";q=`),
  });
}

export function read() {
  const res = http.get(`${API}/documents`, auth);
  if (res.status === 429) {
    limited.add(1);
    checkLimited(res, 'read');
    return;
  }
  allowed.add(1);
  check(res, {
    'read is 200 when not limited': (r) => r.status === 200,
    'read 200 has RateLimit': (r) => /^"read-user";r=\d+;t=\d+/.test(r.headers['Ratelimit'] || ''),
  });
}

export function qa() {
  const res = http.post(
    `${API}/qa/ask`,
    JSON.stringify({ question: 'Tổng tiền SAMPLE tháng 3?' }),
    {
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
    },
  );
  if (res.status === 429) {
    qaLimited.add(1);
    checkLimited(res, 'qa');
    return;
  }
  qaPassed.add(1);
  // The AI service is not running: the question got past the limiter and failed behind it.
  check(res, {
    'qa below the limit reaches the service (503 without AI)': (r) => r.status === 503,
  });
}
