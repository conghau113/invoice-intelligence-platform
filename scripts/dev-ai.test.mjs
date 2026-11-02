import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEV_DEFAULTS, devApiEnv } from './dev-api.mjs';
import { devAiEnv } from './dev-ai.mjs';

test('dev-ai: uses the same token the API and the worker default to', () => {
  const ai = devAiEnv({ PATH: '/bin' });
  assert.equal(ai.AI_SERVICE_TOKEN, devApiEnv({}).AI_SERVICE_TOKEN);
  assert.equal(ai.AI_SERVICE_TOKEN, DEV_DEFAULTS.AI_SERVICE_TOKEN);
  assert.equal(ai.PATH, '/bin');
});

test('dev-ai: a token exported in the shell wins', () => {
  assert.equal(
    devAiEnv({ AI_SERVICE_TOKEN: 'my-own-token-0123456789' }).AI_SERVICE_TOKEN,
    'my-own-token-0123456789',
  );
});

test('dev-ai: refuses to run with a non-development NODE_ENV', () => {
  assert.throws(() => devAiEnv({ NODE_ENV: 'production' }), /local development only/);
});
