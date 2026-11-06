import { applyVercelEnvDefaults } from './vercel-env';

describe('applyVercelEnvDefaults', () => {
  it('does nothing outside Vercel', () => {
    const env: NodeJS.ProcessEnv = { VERCEL_PROJECT_PRODUCTION_URL: 'cims.vercel.app' };
    applyVercelEnvDefaults(env);
    expect(env).toEqual({ VERCEL_PROJECT_PRODUCTION_URL: 'cims.vercel.app' });
  });

  it('derives the web origin, proxy hops and secure cookies on Vercel', () => {
    const env: NodeJS.ProcessEnv = {
      VERCEL: '1',
      VERCEL_PROJECT_PRODUCTION_URL: 'cims.vercel.app',
    };
    applyVercelEnvDefaults(env);
    expect(env.WEB_ORIGIN).toBe('https://cims.vercel.app');
    expect(env.TRUST_PROXY_HOPS).toBe('1');
    expect(env.COOKIE_SECURE).toBe('true');
  });

  it('never overrides explicitly configured values', () => {
    const env: NodeJS.ProcessEnv = {
      VERCEL: '1',
      VERCEL_PROJECT_PRODUCTION_URL: 'cims.vercel.app',
      WEB_ORIGIN: 'https://hr.example.com',
      TRUST_PROXY_HOPS: '2',
      COOKIE_SECURE: 'false',
    };
    applyVercelEnvDefaults(env);
    expect(env.WEB_ORIGIN).toBe('https://hr.example.com');
    expect(env.TRUST_PROXY_HOPS).toBe('2');
    expect(env.COOKIE_SECURE).toBe('false');
  });
});
