import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import request from 'supertest';
import { buildApp, loginAsSeedMerchant } from './helpers.js';
import authRoutes from '../auth.routes.js';
import paymentRoutes from '../payment.routes.js';
import webhookRoutes from '../webhook.routes.js';

const WEBHOOK_SECRET = 'test-webhook-secret-key';

let app;
let token;

beforeEach(async () => {
  app = buildApp([
    ['/api/auth', authRoutes],
    ['/api/payments', paymentRoutes],
    ['/api/webhooks', webhookRoutes],
  ]);
  token = await loginAsSeedMerchant(request, app);
});

/** Sign a webhook payload exactly the way the provider is expected to. */
function sign(bodyObject) {
  return crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(bodyObject))
    .digest('hex');
}

function postWebhook(body, signature) {
  const req = request(app)
    .post('/api/webhooks/payment-status')
    .set('Content-Type', 'application/json');
  if (signature !== undefined) req.set('x-webhook-signature', signature);
  return req.send(JSON.stringify(body));
}

test('a correctly signed webhook updates the payment status', async () => {
  const body = { payment_id: '1', status: 'completed', event_id: 'evt_ok_1' };
  const res = await postWebhook(body, sign(body));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.message, 'Webhook processed');

  const payment = await request(app)
    .get('/api/payments/1')
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(payment.body.data.status, 'completed');
});

// Bug D regression: forged webhooks must be rejected.
test('a webhook with a forged signature is rejected with 401 (Bug D)', async () => {
  const body = { payment_id: '1', status: 'completed', event_id: 'evt_forged' };
  const res = await postWebhook(body, 'totally-fake-signature');
  assert.strictEqual(res.status, 401);
  assert.match(res.body.error, /invalid signature/i);
});

test('a webhook with no signature header is rejected with 401 (Bug D)', async () => {
  const body = { payment_id: '1', status: 'completed', event_id: 'evt_unsigned' };
  const res = await postWebhook(body, undefined);
  assert.strictEqual(res.status, 401);
});

test('a webhook signed over a tampered body is rejected (Bug D)', async () => {
  const signedBody = { payment_id: '1', status: 'refunded', event_id: 'evt_tamper' };
  const sentBody = { payment_id: '1', status: 'completed', event_id: 'evt_tamper' };
  const res = await postWebhook(sentBody, sign(signedBody));
  assert.strictEqual(res.status, 401);
});

// Bug E regression: providers retry webhooks; duplicates must be no-ops.
test('the same webhook event delivered twice is processed only once (Bug E)', async () => {
  const body = { payment_id: '2', status: 'completed', event_id: 'evt_dup_1' };

  const first = await postWebhook(body, sign(body));
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.message, 'Webhook processed');

  const second = await postWebhook(body, sign(body));
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.message, 'Already processed');
});

test('two different events for the same payment are both processed', async () => {
  const first = { payment_id: '2', status: 'completed', event_id: 'evt_seq_1' };
  const second = { payment_id: '2', status: 'refunded', event_id: 'evt_seq_2' };
  assert.strictEqual((await postWebhook(first, sign(first))).status, 200);
  const res = await postWebhook(second, sign(second));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.message, 'Webhook processed');
});

test('a signed webhook for a non-existent payment returns 404', async () => {
  const body = { payment_id: '999', status: 'completed', event_id: 'evt_ghost' };
  const res = await postWebhook(body, sign(body));
  assert.strictEqual(res.status, 404);
});

test('a signed webhook missing payment_id returns 400', async () => {
  const body = { status: 'completed', event_id: 'evt_nopayment' };
  const res = await postWebhook(body, sign(body));
  assert.strictEqual(res.status, 400);
});

test('a signed webhook with an SQL-injection-style payment_id returns 404, not 500', async () => {
  const body = { payment_id: "1' OR '1'='1", status: 'completed', event_id: 'evt_sqli' };
  const res = await postWebhook(body, sign(body));
  assert.strictEqual(res.status, 404);
});
