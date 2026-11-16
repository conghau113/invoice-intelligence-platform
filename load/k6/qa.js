/**
 * T6.6: questions asked together, on a local stack whose AI service runs LLM_PROVIDER=fake (no
 * model is called, no quota is used). There is no NFR for Q&A latency: the run reports it.
 *
 * Every identity asks PER_IDENTITY questions at the same moment. The defaults fill the `qa`
 * buckets exactly (5 a minute per user, 20 per tenant), so a 429 fails the run; wait a minute
 * between two runs. The answer is a server-sent event stream: `http_req_waiting` is the time to
 * the first byte, `http_req_duration` the time until the stream ended.
 */
import http from 'k6/http';
import { check } from 'k6';
import { API, headersOf, identitiesWith, identityOf, rateLimited } from './lib/common.js';

const PER_IDENTITY = Number(__ENV.PER_IDENTITY || 5);
const askers = identitiesWith();

const QUESTIONS = [
  'Tổng tiền SAMPLE tháng 5 năm 2026?',
  'Hoá đơn của Công ty SAMPLE Bán 0 có tổng tiền bao nhiêu?',
  'Which SAMPLE invoices have a 0% VAT rate?',
  'Vật tư SAMPLE được mua với đơn giá bao nhiêu?',
  'How much did Công ty SAMPLE Mua 0 pay in total?',
];

export const options = {
  scenarios: {
    ask: {
      executor: 'per-vu-iterations',
      vus: askers.length * PER_IDENTITY,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    rate_limited: ['count==0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const me = identityOf(askers, __VU);
  const question = QUESTIONS[__VU % QUESTIONS.length];
  const res = http.post(`${API}/qa/ask`, JSON.stringify({ question }), {
    headers: headersOf(me, { 'Content-Type': 'application/json' }),
    tags: { name: 'qa' },
    timeout: '90s',
  });
  if (res.status === 429) rateLimited.add(1);
  const body = res.body || '';
  check(res, {
    'qa is 200': (r) => r.status === 200,
    'qa stream ends with done': () => body.includes('event: done'),
    'qa stream has no error event': () => !body.includes('event: error'),
  });
}
