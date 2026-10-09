import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { buildApp, loginAsSeedMerchant } from './helpers.js';
import authRoutes from '../auth.routes.js';
import paymentRoutes from '../payment.routes.js';

let app;
let token;

beforeEach(async () => {
  app = buildApp([
    ['/api/auth', authRoutes],
    ['/api/payments', paymentRoutes],
  ]);
  token = await loginAsSeedMerchant(request, app);
});

function createPayment(overrides = {}) {
  return request(app)
    .post('/api/payments')
    .set('Authorization', `Bearer ${token}`)
    .send({
      amount: 42.5,
      currency: 'EUR',
      customer_email: 'customer@example.com',
      ...overrides,
    });
}

// Bug A regression: amount must be a JSON number, not a string.
test('GET /payments returns amount as a number, not a string (Bug A)', async () => {
  const res = await request(app).get('/api/payments').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.length >= 2, 'expected the seeded payments');
  for (const payment of res.body.data) {
    assert.strictEqual(typeof payment.amount, 'number', `amount should be a number, got ${typeof payment.amount}`);
  }
  assert.strictEqual(res.body.data[0].amount, 25.5);
});

// Bug A regression (single-payment endpoint had the same string conversion).
test('GET /payments/:id returns amount as a number, not a string (Bug A)', async () => {
  const list = await request(app).get('/api/payments').set('Authorization', `Bearer ${token}`);
  const id = list.body.data[0].id;
  const res = await request(app).get(`/api/payments/${id}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.body.data.amount, 'number');
  assert.strictEqual(res.body.data.amount, 25.5);
});

// Bug B regression: unrealistic amounts must be rejected.
test('POST /payments rejects an amount of €999,999,999 (Bug B)', async () => {
  const res = await createPayment({ amount: 999999999 });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /maximum/i);
});

test('POST /payments rejects an amount just over the €50,000 limit (Bug B)', async () => {
  const res = await createPayment({ amount: 50000.01 });
  assert.strictEqual(res.status, 400);
});

test('POST /payments accepts an amount exactly at the €50,000 limit', async () => {
  const res = await createPayment({ amount: 50000 });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.data.amount, 50000);
});

test('POST /payments rejects a zero amount', async () => {
  const res = await createPayment({ amount: 0 });
  assert.strictEqual(res.status, 400);
});

test('POST /payments rejects a negative amount', async () => {
  const res = await createPayment({ amount: -10 });
  assert.strictEqual(res.status, 400);
});

test('POST /payments rejects an unsupported currency', async () => {
  const res = await createPayment({ currency: 'BTC' });
  assert.strictEqual(res.status, 400);
});

test('POST /payments rejects a request without a JWT', async () => {
  const res = await request(app)
    .post('/api/payments')
    .send({ amount: 10, currency: 'EUR', customer_email: 'a@b.com' });
  assert.strictEqual(res.status, 401);
});

test('GET /payments rejects a request without a JWT', async () => {
  const res = await request(app).get('/api/payments');
  assert.strictEqual(res.status, 401);
});

test('POST /payments creates a payment and echoes a numeric amount', async () => {
  const res = await createPayment({ amount: 19.99 });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.data.amount, 19.99);
  assert.strictEqual(res.body.data.status, 'pending');
});

test("a merchant cannot read another merchant's payment", async () => {
  const created = await createPayment();
  const paymentId = created.body.data.id;

  const other = await request(app)
    .post('/api/auth/register')
    .send({ email: 'other@shop.com', password: 'SecurePass123!', business_name: 'Other Shop' });
  const otherToken = other.body.token;

  const res = await request(app)
    .get(`/api/payments/${paymentId}`)
    .set('Authorization', `Bearer ${otherToken}`);
  assert.strictEqual(res.status, 403);
});
