/**
 * T6.6, NFR-02: 20 people browsing the document list at the same time, on a local stack.
 *
 * Each VU is one person: first page of the list, a deep page, one document, the dashboard, with
 * 2-4 s of reading between two pages. That is about 20 requests a minute per VU, so the four VUs
 * of one identity stay below the `read` bucket (120 a minute per user, ADR 0012): the run
 * measures the backend, not the limiter, and a single 429 fails it.
 *
 * Every request is tagged with `name` so the summary shows each endpoint apart. `VUS` and
 * `DURATION` exist to look for the knee (README); the NFR run uses the defaults.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  API,
  headersOf,
  identitiesWith,
  identityOf,
  rateLimited,
  pick,
  think,
} from './lib/common.js';

const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '2m30s';
const THINK_MIN = Number(__ENV.THINK_MIN ?? 2);
const THINK_MAX = Number(__ENV.THINK_MAX ?? 4);
const PAGE_SIZE = 20;

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // NFR-02, on the answers that were not errors.
    'http_req_duration{expected_response:true}': ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // See lib/common.js: a 429 means this run measured the limiter.
    rate_limited: ['count==0'],
    // One line per endpoint in the summary (k6 prints a sub-metric only when it has a threshold).
    'http_req_duration{name:list_first}': ['p(95)<300'],
    'http_req_duration{name:list_deep}': ['p(95)<300'],
    'http_req_duration{name:detail}': ['p(95)<300'],
    'http_req_duration{name:dashboard}': ['p(95)<300'],
  },
  // p(99) too: the report looks at the tail, not only at the NFR line.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const people = identitiesWith();

function get(identity, path, name) {
  const res = http.get(`${API}${path}`, { headers: headersOf(identity), tags: { name } });
  if (res.status === 429) rateLimited.add(1);
  check(res, { [`${name} is 200`]: (r) => r.status === 200 });
  return res;
}

export default function () {
  const me = identityOf(people, __VU);

  const first = get(me, `/documents?page=1&limit=${PAGE_SIZE}`, 'list_first');
  let total = 0;
  let ids = [];
  try {
    total = first.json('meta.total') || 0;
    ids = (first.json('items') || []).map((d) => d.id);
  } catch {
    // Not JSON: already counted as a failed check.
  }
  think(sleep, THINK_MIN, THINK_MAX);

  // A deep page: ADR 0019 expects OFFSET to cost more the further it goes.
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const deep = 1 + pick(pages);
  get(me, `/documents?page=${deep}&limit=${PAGE_SIZE}`, 'list_deep');
  think(sleep, THINK_MIN, THINK_MAX);

  if (ids.length > 0) {
    get(me, `/documents/${ids[pick(ids.length)]}`, 'detail');
    think(sleep, THINK_MIN, THINK_MAX);
  }

  get(me, '/insights/extraction', 'dashboard');
  think(sleep, THINK_MIN, THINK_MAX);
}
