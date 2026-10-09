import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { buildApp, loginAsSeedMerchant } from './helpers.js';
import authRoutes from '../auth.routes.js';
import tableOrderRoutes from '../table-order.routes.js';

let app;
let token;

beforeEach(async () => {
  app = buildApp([
    ['/api/auth', authRoutes],
    ['/api/table-orders', tableOrderRoutes],
  ]);
  token = await loginAsSeedMerchant(request, app);
});

function createOrder(overrides = {}) {
  return request(app)
    .post('/api/table-orders')
    .send({
      merchant_id: '1',
      table_number: 5,
      items: [{ name: 'Coffee', price: 3.5, quantity: 2 }],
      ...overrides,
    });
}

test('creating a table order succeeds and computes the total', async () => {
  const res = await createOrder();
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.data.status, 'pending');
  assert.strictEqual(res.body.data.total, 7);
});

// Bug F regression: a table may only have one pending order.
test('a second pending order for the same table is rejected with 409 (Bug F)', async () => {
  const first = await createOrder();
  assert.strictEqual(first.status, 201);

  const second = await createOrder({ items: [{ name: 'Tea', price: 2.5, quantity: 1 }] });
  assert.strictEqual(second.status, 409);
  assert.match(second.body.error, /already has a pending order/i);
});

test('orders for different tables do not block each other (Bug F)', async () => {
  assert.strictEqual((await createOrder({ table_number: 5 })).status, 201);
  assert.strictEqual((await createOrder({ table_number: 6 })).status, 201);
});

test('a new order is allowed once the previous one leaves pending (Bug F)', async () => {
  const created = await createOrder();
  const orderId = created.body.data.id;

  const cancel = await request(app)
    .patch(`/api/table-orders/${orderId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'cancelled' });
  assert.strictEqual(cancel.status, 200);

  const next = await createOrder();
  assert.strictEqual(next.status, 201);
});

test("a different merchant's pending order does not block this table (Bug F)", async () => {
  assert.strictEqual((await createOrder({ merchant_id: '1' })).status, 201);
  assert.strictEqual((await createOrder({ merchant_id: '2' })).status, 201);
});

test('creating an order with an empty items array is rejected', async () => {
  const res = await createOrder({ items: [] });
  assert.strictEqual(res.status, 400);
});

test('creating an order without items is rejected', async () => {
  const res = await request(app)
    .post('/api/table-orders')
    .send({ merchant_id: '1', table_number: 5 });
  assert.strictEqual(res.status, 400);
});

test('GET /table-orders requires authentication', async () => {
  const res = await request(app).get('/api/table-orders');
  assert.strictEqual(res.status, 401);
});

test('GET /table-orders lists the merchant orders', async () => {
  await createOrder();
  const res = await request(app)
    .get('/api/table-orders')
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.count, 1);
});

test('PATCH status rejects an unknown status value', async () => {
  const created = await createOrder();
  const res = await request(app)
    .patch(`/api/table-orders/${created.body.data.id}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'exploded' });
  assert.strictEqual(res.status, 400);
});

test('PATCH status updates the order and echoes the new status', async () => {
  const created = await createOrder();
  const res = await request(app)
    .patch(`/api/table-orders/${created.body.data.id}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'preparing' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.status, 'preparing');
});

test('PATCH status for a non-existent order returns 404', async () => {
  const res = await request(app)
    .patch('/api/table-orders/does-not-exist/status')
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'ready' });
  assert.strictEqual(res.status, 404);
});
