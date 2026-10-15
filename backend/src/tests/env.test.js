'use strict';

const { validateEnv } = require('../config/env');

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('validateEnv', () => {
  test('reports missing production essentials without throwing in non-strict mode', () => {
    delete process.env.DB_PASSWORD;
    delete process.env.JWT_SECRET;

    const report = validateEnv({ strict: false });

    expect(report.ok).toBe(false);
    expect(report.missing).toContain('DB_PASSWORD');
    expect(report.missing).toContain('JWT_SECRET');
  });

  test('throws in strict mode when essentials are placeholders', () => {
    process.env.DB_HOST = 'postgres';
    process.env.DB_NAME = 'cplus_db';
    process.env.DB_USER = 'cplus_user';
    process.env.DB_PASSWORD = 'CHANGE_ME';
    process.env.JWT_SECRET = 'CHANGE_ME_64_CHARS_RANDOM_SECRET';
    process.env.INTERNAL_TOKEN = 'CHANGE_ME';
    process.env.API_BASE_URL = 'https://api.c-pay.global';
    process.env.PAY_LINK_BASE_URL = 'https://pay.c-pay.global';
    process.env.ALLOWED_ORIGINS = 'https://admin.c-pay.global';

    expect(() => validateEnv({ strict: true })).toThrow(/Production environment invalid/);
  });
});
