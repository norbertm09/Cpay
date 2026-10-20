'use strict';

process.env.JWT_SECRET = 'security-first-lot-test-secret-at-least-32-chars';
const express = require('express'),
  request = require('supertest');
const mockPayment = jest.fn();
const mockQuery = jest.fn(),
  mockCharge = jest.fn(),
  mockTransfer = jest.fn(),
  mockCollect = jest.fn(),
  mockSendMail = jest.fn(),
  mockTransport = jest.fn();
jest.mock('../config/database', () => ({
  query: (...a) => mockQuery(...a),
  withTransaction: fn => fn({
    query: (...a) => mockQuery(...a)
  })
}));
jest.mock('../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));
jest.mock('../services/psp/psp.router', () => ({
  chargeCard: (...a) => mockCharge(...a),
  calculateFees: () => ({
    debitAmount: 1000,
    creditAmount: 990,
    fee: 10
  })
}));
jest.mock('../services/rails/mtn-momo.client', () => ({
  transfer: (...a) => mockTransfer(...a),
  requestToPay: (...a) => mockCollect(...a)
}));
jest.mock('nodemailer', () => ({
  createTransport: (...a) => mockTransport(...a)
}));
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({
  processPayment: (...a) => mockPayment(...a)
}));
jest.mock('../services/gateways/card.router', () => ({}));
jest.mock('../services/settlement/settlement.queue', () => ({
  enqueue: jest.fn()
}));
jest.mock('../services/integrations/integration.service', () => ({
  deliverEvent: async () => {}
}));
jest.mock('../services/pilot/pilot-control.service', () => ({
  evaluateFeature: async () => ({
    allowed: true
  })
}));
const {
  signAccessToken
} = require('../middleware/auth');
const app = express();
app.use(express.json());
app.use(require('../routes/card2momo.routes'));
app.use((err, req, res, next) => res.status(500).json({
  error: err.message
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({
    rows: [],
    rowCount: 1
  });
  mockCharge.mockRejectedValue(new Error('provider reached'));
  mockCollect.mockRejectedValue(new Error('provider reached'));
  mockTransport.mockReturnValue({
    sendMail: mockSendMail
  });
  mockSendMail.mockResolvedValue({
    messageId: 'test'
  });
});
const body = {
  amount: 1000,
  tokenId: 'token',
  momoPhone: '+237671234567',
  srcPhone: '+237671234567',
  dstPhone: '+237691234567'
};
test.each(['/card2momo', '/momo2card', '/momo2momo'])('%s refuses before any financial effect', async route => {
  const token = signAccessToken({
    sub: '11111111-1111-4111-8111-111111111111',
    type: 'cardholder'
  });
  const r = await request(app).post(route).set('Authorization', 'Bearer ' + token).send(body);
  expect(r.status).toBe(410);
  expect(r.body.code).toBe('FEATURE_DISABLED');
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockCharge).not.toHaveBeenCalled();
  expect(mockTransfer).not.toHaveBeenCalled();
  expect(mockCollect).not.toHaveBeenCalled();
});
test('suspended routes still require authentication', async () => {
  expect((await request(app).post('/momo2card').send(body)).status).toBe(401);
});
test('real fraud checks report a read failure instead of allowing', async () => {
  mockQuery.mockRejectedValue(new Error('fraud read unavailable'));
  await expect(require('../services/fraud/fraud.engine').evaluate({
    merchantId: 'm',
    terminalId: 't',
    amount: 1000,
    currency: 'XAF'
  })).rejects.toMatchObject({
    code: 'FRAUD_UNAVAILABLE'
  });
});
test('healthy fraud checks still allow ordinary payments', async () => {
  mockQuery.mockResolvedValue({
    rows: [{
      cnt: 0,
      status: 'active'
    }]
  });
  expect((await require('../services/fraud/fraud.engine').evaluate({
    merchantId: 'm',
    terminalId: 't',
    amount: 1000,
    currency: 'XAF'
  })).action).toBe('allow');
});
describe('SMTP TLS', () => {
  const saved = {
    ...process.env
  };
  beforeEach(() => {
    process.env.SMTP_HOST = 'localhost';
    process.env.SMTP_USER = 'audit';
    process.env.SMTP_PASS = 'audit';
    delete process.env.SMTP_TLS_CA;
    delete process.env.SMTP_TLS_CA_FILE;
  });
  afterAll(() => {
    process.env = saved;
  });
  test.each(['../services/email.service', '../services/notifications/email.service'])('%s verifies certificates', async file => {
    let service;
    jest.isolateModules(() => {
      service = require(file);
    });
    await service.send({
      to: 'recipient@example.test',
      subject: 'test',
      html: 'test'
    });
    expect(mockTransport).toHaveBeenCalledWith(expect.objectContaining({
      tls: expect.objectContaining({
        rejectUnauthorized: true
      })
    }));
  });
  test.each(['../services/email.service', '../services/notifications/email.service'])('%s supports a trusted CA without disabling verification', async file => {
    process.env.SMTP_TLS_CA = 'test-private-ca';
    let service;
    jest.isolateModules(() => {
      service = require(file);
    });
    await service.send({
      to: 'recipient@example.test',
      subject: 'test',
      html: 'test'
    });
    expect(mockTransport).toHaveBeenCalledWith(expect.objectContaining({
      tls: {
        rejectUnauthorized: true,
        ca: 'test-private-ca'
      }
    }));
  });
  test.each(['../services/email.service', '../services/notifications/email.service'])('%s loads an explicitly trusted CA file', async file => {
    const fs = require('fs'),
      os = require('os'),
      path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpay-smtp-'));
    const ca = path.join(dir, 'ca.pem');
    fs.writeFileSync(ca, 'private-ca-file');
    process.env.SMTP_TLS_CA_FILE = ca;
    try {
      let service;
      jest.isolateModules(() => {
        service = require(file);
      });
      await service.send({
        to: 'recipient@example.test',
        subject: 'test',
        html: 'test'
      });
      expect(mockTransport).toHaveBeenCalledWith(expect.objectContaining({
        tls: {
          rejectUnauthorized: true,
          ca: 'private-ca-file'
        }
      }));
    } finally {
      fs.unlinkSync(ca);
      fs.rmdirSync(dir);
    }
  });
  test.each(['../services/email.service', '../services/notifications/email.service'])('%s does not send if its configured CA cannot be read', async file => {
    process.env.SMTP_TLS_CA_FILE = require('path').join(require('os').tmpdir(), 'missing-cpay-ca-' + require('crypto').randomUUID());
    let service;
    jest.isolateModules(() => {
      service = require(file);
    });
    if (file === '../services/email.service') expect(await service.send({
      to: 'recipient@example.test',
      subject: 'test',
      html: 'test'
    })).toBe(false);else await expect(service.send({
      to: 'recipient@example.test',
      subject: 'test',
      html: 'test'
    })).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(mockTransport).not.toHaveBeenCalled();
  });
});

// A read failure must reach the existing degraded policy with the real engine.
describe('orchestrator uses real fraud failure decisions', () => {
  const saved = {
    ...process.env
  };
  afterEach(() => {
    process.env = {
      ...saved
    };
  });
  test.each([['block', 1000, false], ['review', 1000, true], ['allow_limited', 1000, true], ['allow_limited', 3000, false]])('%s at %i calls provider only when policy permits', async (mode, amount, allowed) => {
    process.env.FRAUD_DEGRADED_MODE = mode;
    process.env.FRAUD_DEGRADED_MAX_AMOUNT = '2000';
    mockQuery.mockImplementation(async (sql, p) => {
      if (sql.includes('COUNT(*)')) throw new Error('selective fraud read failure');
      if (sql.includes('FROM merchants WHERE merchant_id')) return {
        rows: [{
          merchant_id: p[0],
          merchant_status: 'active',
          kyb_level: 2,
          currency: 'XAF'
        }]
      };
      if (sql.includes('daily_volume')) return {
        rows: [{
          daily_volume: 0
        }]
      };
      return {
        rows: [],
        rowCount: 1
      };
    });
    mockPayment.mockResolvedValue({
      pending: true,
      approved: false,
      responseCode: '09'
    });
    const result = await require('../services/orchestration/orchestrator').processTransaction({
      merchantId: '11111111-1111-4111-8111-111111111111',
      type: 'collect',
      amount,
      customerPhone: '+237671234567'
    });
    if (allowed) {
      expect(result.status).toBe('pending');
      expect(mockPayment).toHaveBeenCalledTimes(1);
    } else {
      expect(result.code).toBe('FRAUD_UNAVAILABLE');
      expect(result.statusCode).toBe(503);
      expect(mockPayment).not.toHaveBeenCalled();
    }
  });
});

describe('known fraud blocks take priority over unavailable checks', () => {
  test.each(['device', 'velocity'])('preserves the %s block', async (blockingCheck) => {
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('FROM terminals')) {
        if (blockingCheck === 'velocity') throw new Error('device read unavailable');
        return { rows: [{ status: 'blocked' }] };
      }
      if (blockingCheck === 'device') throw new Error('velocity read unavailable');
      return { rows: [{ cnt: 5 }] };
    });
    const decision = await require('../services/fraud/fraud.engine').evaluate({ merchantId: 'm', terminalId: 't', amount: 1000, currency: 'XAF' });
    expect(decision.action).toBe('block');
    expect(decision.score).toBe(100);
  });
});
test('SMTP on port 587 requires STARTTLS instead of plaintext fallback', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SMTP_HOST: 'localhost', SMTP_PORT: '587', SMTP_USER: 'audit', SMTP_PASS: 'audit' });
    delete process.env.SMTP_TLS_CA; delete process.env.SMTP_TLS_CA_FILE;
    let service; jest.isolateModules(() => { service = require('../services/notifications/email.service'); });
    await service.send({ to: 'recipient@example.test', subject: 'test', html: 'test' });
    expect(mockTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true, tls: { rejectUnauthorized: true } }));
  } finally { process.env = saved; }
});
