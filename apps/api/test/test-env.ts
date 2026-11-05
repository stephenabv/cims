/** Environment for integration tests. Uses a dedicated database that is reset per run. */
const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgresql://cims:cims_dev_password@localhost:5432/cims_test?schema=public';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DB,
  WEB_ORIGIN: 'http://localhost:5173',
  CSRF_SECRET: 'test-csrf-secret-test-csrf-secret-test-csrf',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  COOKIE_SECURE: 'false',
  LOG_LEVEL: 'silent',
});

export {};
