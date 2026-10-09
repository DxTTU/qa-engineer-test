import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { buildApp, loginAsSeedMerchant } from './helpers.js';
import authRoutes from '../auth.routes.js';
import einvoiceRoutes from '../einvoice.routes.js';

const VALID_SIRET = '12345678901234'; // 14 digits

let app;
let token;

beforeEach(async () => {
  app = buildApp([
    ['/api/auth', authRoutes],
    ['/api/einvoice', einvoiceRoutes],
  ]);
  token = await loginAsSeedMerchant(request, app);
});

function submitInvoice(overrides = {}) {
  return request(app)
    .post('/api/einvoice/submit')
    .set('Authorization', `Bearer ${token}`)
    .send({ invoice_id: 'inv_test_1', customer_siret: VALID_SIRET, ...overrides });
}

test('submitting an invoice succeeds and returns a submission id', async () => {
  const res = await submitInvoice();
  assert.strictEqual(res.status, 200);
  assert.match(res.body.data.submission_id, /^SUB-/);
  assert.strictEqual(res.body.data.status, 'submitted');
});

// Bug G regression: the same invoice must not be filed twice.
test('submitting the same invoice twice is rejected with 409 (Bug G)', async () => {
  const first = await submitInvoice();
  assert.strictEqual(first.status, 200);

  const second = await submitInvoice();
  assert.strictEqual(second.status, 409);
  assert.match(second.body.error, /already submitted/i);
});

test('a duplicate submission keeps the original submission id (Bug G)', async () => {
  const first = await submitInvoice();
  await submitInvoice(); // rejected duplicate

  const status = await request(app)
    .get('/api/einvoice/status/inv_test_1')
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(status.body.data.submission_id, first.body.data.submission_id);
  assert.strictEqual(status.body.data.einvoice_status, 'submitted');
});

test('different invoices can each be submitted once (Bug G)', async () => {
  assert.strictEqual((await submitInvoice({ invoice_id: 'inv_a' })).status, 200);
  assert.strictEqual((await submitInvoice({ invoice_id: 'inv_b' })).status, 200);
});

test('submit rejects a missing SIRET number', async () => {
  const res = await request(app)
    .post('/api/einvoice/submit')
    .set('Authorization', `Bearer ${token}`)
    .send({ invoice_id: 'inv_no_siret' });
  assert.strictEqual(res.status, 400);
});

test('submit rejects a SIRET that is not 14 digits', async () => {
  const res = await submitInvoice({ customer_siret: '12345' });
  assert.strictEqual(res.status, 400);
});

test('submit requires authentication', async () => {
  const res = await request(app)
    .post('/api/einvoice/submit')
    .send({ invoice_id: 'inv_anon', customer_siret: VALID_SIRET });
  assert.strictEqual(res.status, 401);
});

test('status of an unknown invoice returns 404', async () => {
  const res = await request(app)
    .get('/api/einvoice/status/inv_ghost')
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 404);
});
