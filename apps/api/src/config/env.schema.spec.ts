import { validateEnv } from './env.schema';

const ISSUER = 'http://localhost:8080/realms/invoice';
const DB_URL = 'postgres://invoice_app:pw@localhost:5433/invoice';
const DATA_DIR = '/var/lib/invoice-data';
const REDIS_URL = 'redis://localhost:6380';
const AI = { AI_SERVICE_URL: 'http://localhost:8000', AI_SERVICE_TOKEN: 'x'.repeat(16) };

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(
      validateEnv({
        NODE_ENV: 'test',
        OIDC_ISSUER_URL: ISSUER,
        DATABASE_URL: DB_URL,
        DATA_DIR,
        REDIS_URL,
        ...AI,
      }),
    ).toEqual({
      NODE_ENV: 'test',
      PORT: 3001,
      DEMO_READ_ONLY: false,
      OIDC_ISSUER_URL: ISSUER,
      DATABASE_URL: DB_URL,
      DATA_DIR,
      REDIS_URL,
      ...AI,
      QUEUE_BACKOFF_BASE_MS: 5000,
      AI_LLM_TIMEOUT_MS: 60000,
      TRUSTED_PROXIES: 'loopback',
      OIDC_AUDIENCE: 'api',
    });
  });

  it('AI_LLM_TIMEOUT_MS is read as a number and refuses a value too small to work (the 60 s default is in the first test)', () => {
    const base = {
      NODE_ENV: 'test',
      OIDC_ISSUER_URL: ISSUER,
      DATABASE_URL: DB_URL,
      DATA_DIR,
      REDIS_URL,
      ...AI,
    };
    expect(validateEnv({ ...base, AI_LLM_TIMEOUT_MS: '90000' }).AI_LLM_TIMEOUT_MS).toBe(90000);
    expect(() => validateEnv({ ...base, AI_LLM_TIMEOUT_MS: '5' })).toThrow(/AI_LLM_TIMEOUT_MS/);
  });

  it('parses "false" as false (not a truthy string)', () => {
    const base = {
      NODE_ENV: 'test',
      OIDC_ISSUER_URL: ISSUER,
      DATABASE_URL: DB_URL,
      DATA_DIR,
      REDIS_URL,
      ...AI,
    };
    expect(validateEnv({ ...base, DEMO_READ_ONLY: 'false' }).DEMO_READ_ONLY).toBe(false);
    expect(validateEnv({ ...base, DEMO_READ_ONLY: 'true' }).DEMO_READ_ONLY).toBe(true);
  });

  it('requires REDIS_URL and bounds the backoff base', () => {
    const base = {
      NODE_ENV: 'test',
      OIDC_ISSUER_URL: ISSUER,
      DATABASE_URL: DB_URL,
      DATA_DIR,
      ...AI,
    };
    expect(() => validateEnv(base)).toThrow(/REDIS_URL/);
    expect(() => validateEnv({ ...base, REDIS_URL, QUEUE_BACKOFF_BASE_MS: '0' })).toThrow(
      /QUEUE_BACKOFF_BASE_MS/,
    );
    expect(
      validateEnv({ ...base, REDIS_URL, QUEUE_BACKOFF_BASE_MS: '10' }).QUEUE_BACKOFF_BASE_MS,
    ).toBe(10);
  });

  it('requires the token issuer (no silent insecure default)', () => {
    expect(() => validateEnv({ NODE_ENV: 'test' })).toThrow(/OIDC_ISSUER_URL/);
  });

  it('requires the database url and never prints it', () => {
    expect.assertions(2);
    expect(() => validateEnv({ NODE_ENV: 'test', OIDC_ISSUER_URL: ISSUER, DATA_DIR })).toThrow(
      /DATABASE_URL/,
    );
    try {
      validateEnv({
        NODE_ENV: 'test',
        OIDC_ISSUER_URL: ISSUER,
        DATABASE_URL: 'not-a-url-secret',
        DATA_DIR,
      });
    } catch (e) {
      expect((e as Error).message).not.toContain('not-a-url-secret');
    }
  });

  it('requires DATA_DIR to be an absolute path', () => {
    const base = { NODE_ENV: 'test', OIDC_ISSUER_URL: ISSUER, DATABASE_URL: DB_URL };
    expect(() => validateEnv(base)).toThrow(/DATA_DIR/);
    expect(() => validateEnv({ ...base, DATA_DIR: './data' })).toThrow(/DATA_DIR.*absolute/);
  });

  it('EVAL_REPORTS_DIR is optional, empty means not set, and must be absolute when set', () => {
    const base = {
      NODE_ENV: 'test',
      OIDC_ISSUER_URL: ISSUER,
      DATABASE_URL: DB_URL,
      DATA_DIR,
      REDIS_URL,
      ...AI,
    };
    expect(validateEnv(base).EVAL_REPORTS_DIR).toBeUndefined();
    expect(validateEnv({ ...base, EVAL_REPORTS_DIR: '' }).EVAL_REPORTS_DIR).toBeUndefined();
    expect(validateEnv({ ...base, EVAL_REPORTS_DIR: '/srv/eval' }).EVAL_REPORTS_DIR).toBe(
      '/srv/eval',
    );
    expect(() => validateEnv({ ...base, EVAL_REPORTS_DIR: 'eval/reports' })).toThrow(
      /EVAL_REPORTS_DIR.*absolute/,
    );
  });

  it('names every invalid variable but never prints its value', () => {
    expect.assertions(3);
    try {
      validateEnv({ PORT: 'abc-secret' });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('NODE_ENV');
      expect(msg).toContain('PORT');
      expect(msg).not.toContain('abc-secret');
    }
  });

  it('requires the AI service URL and a token of at least 16 characters', () => {
    const base = {
      NODE_ENV: 'test',
      OIDC_ISSUER_URL: ISSUER,
      DATABASE_URL: DB_URL,
      DATA_DIR,
      REDIS_URL,
    };
    expect(() => validateEnv(base)).toThrow(/AI_SERVICE_URL[\s\S]*AI_SERVICE_TOKEN/);
    expect(() => validateEnv({ ...base, ...AI, AI_SERVICE_TOKEN: 'short' })).toThrow(
      /AI_SERVICE_TOKEN/,
    );
  });
});
