'use strict';

const {
  parseAmount,
  cleanString,
  validatePayLinkSendRequest,
} = require('../middleware/validation');

const runMiddleware = (middleware, body) => {
  const req = { body };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
};

describe('validation helpers', () => {
  test('parseAmount rounds to cents', () => {
    expect(parseAmount('12.345')).toBe(12.35);
  });

  test('parseAmount rejects invalid values', () => {
    expect(parseAmount(0)).toBeNull();
    expect(parseAmount(-1)).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  test('cleanString trims and enforces max length', () => {
    expect(cleanString('  ok  ', 10)).toBe('ok');
    expect(cleanString('too long', 3)).toBeNull();
    expect(cleanString(123, 10)).toBeNull();
  });
});

describe('validatePayLinkSendRequest', () => {
  test('accepts whatsapp and normalizes phone', () => {
    const { req, nextCalled } = runMiddleware(validatePayLinkSendRequest, {
      channel: 'whatsapp',
      phone: '+243 971 234 567',
    });

    expect(nextCalled).toBe(true);
    expect(req.body.phone).toBe('+243971234567');
  });

  test('rejects unsupported channel', () => {
    const { res, nextCalled } = runMiddleware(validatePayLinkSendRequest, {
      channel: 'email',
      phone: '+243971234567',
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(422);
    expect(res.payload.code).toBe('INVALID_CHANNEL');
  });
});
