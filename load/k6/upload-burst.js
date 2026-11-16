/**
 * T6.6, NFR-03: a burst of uploads arriving at once, on a local stack. Measures the
 * acknowledgment (file stored, row and job created, 201 returned), not the extraction that
 * follows in the worker.
 *
 * Every identity that may upload (four) sends PER_IDENTITY files at the same moment. The default,
 * 5, makes 20 uploads: the NFR-03 run, matching the 20 users of NFR-02. PER_IDENTITY=20 is the
 * stress run: 80 uploads fill the `upload` buckets exactly (20 a minute per user, 60 per tenant:
 * three acme identities make 60). A single 429 fails the run; wait a minute between two runs for
 * the buckets to refill.
 *
 * Each file is the synthetic invoice of fixtures/ (SAMPLE names, invalid tax-code check digit)
 * with its own invoice number, so its content hash is new: a repeated hash would be answered
 * with the existing document and skip the work being measured.
 */
import http from 'k6/http';
import { check } from 'k6';
import { API, headersOf, identitiesWith, identityOf, rateLimited } from './lib/common.js';

const PER_IDENTITY = Number(__ENV.PER_IDENTITY || 5);
const TEMPLATE = open('./fixtures/invoice-template.xml');
const uploaders = identitiesWith('accountant').concat(identitiesWith('tenant_admin'));

export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: uploaders.length * PER_IDENTITY,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    'http_req_duration{expected_response:true}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    rate_limited: ['count==0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

/** One number per run, so two runs never upload the same file. */
export function setup() {
  return { run: Date.now() % 1e9 };
}

export default function (data) {
  const me = identityOf(uploaders, __VU);
  const invoiceNo = `${data.run}${String(__VU).padStart(4, '0')}`;
  const body = {
    file: http.file(
      TEMPLATE.replace('{{SHDON}}', invoiceNo),
      `load-${invoiceNo}.xml`,
      'application/xml',
    ),
  };
  const res = http.post(`${API}/documents/upload`, body, {
    // k6's Web Crypto: a version 4 UUID from a secure generator.
    headers: headersOf(me, { 'Idempotency-Key': crypto.randomUUID() }),
    tags: { name: 'upload' },
  });
  if (res.status === 429) rateLimited.add(1);
  check(res, {
    'upload is 201': (r) => r.status === 201,
    'upload is queued': (r) => {
      try {
        return r.json('status') === 'queued';
      } catch {
        return false;
      }
    },
  });
}
