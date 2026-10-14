import { validateEnv } from './env.schema';

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv({ NODE_ENV: 'test' })).toEqual({
      NODE_ENV: 'test',
      PORT: 3001,
      DEMO_READ_ONLY: false,
    });
  });

  it('parses "false" as false (not a truthy string)', () => {
    expect(validateEnv({ NODE_ENV: 'test', DEMO_READ_ONLY: 'false' }).DEMO_READ_ONLY).toBe(false);
    expect(validateEnv({ NODE_ENV: 'test', DEMO_READ_ONLY: 'true' }).DEMO_READ_ONLY).toBe(true);
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
});
