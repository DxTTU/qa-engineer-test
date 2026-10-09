import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { io as ioClient } from 'socket.io-client';

/**
 * End-to-end integration tests.
 *
 * These boot the real server (src/server.js) on a scratch port and exercise
 * the full flows over HTTP + Socket.IO, the way a real client would:
 *   register -> create payment -> signed provider webhook -> status visible
 *   create table order -> Socket.IO 'new_order' -> status change broadcast
 */

const PORT = 3217;
const BASE = `http://localhost:${PORT}`;
const WEBHOOK_SECRET = 'test-webhook-secret-key';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

let server;
let merchant;
let token;

async function waitForServer(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Server did not start in time');
}

async function api(path, { method = 'GET', body, token: authToken } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Resolve with the payload of the next named socket event (or time out). */
function nextEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for socket event "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

before(async () => {
  server = spawn('node', ['src/server.js'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForServer(`${BASE}/`);

  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      email: 'integration@merchant.com',
      password: 'SecurePass123!',
      business_name: 'Integration Bistro',
    },
  });
  assert.strictEqual(reg.status, 201);
  merchant = reg.body.user;
  token = reg.body.token;
});

after(() => {
  if (server) server.kill('SIGTERM');
});

test('webhook flow: signed provider webhook flips a created payment to completed', async () => {
  const created = await api('/api/payments', {
    method: 'POST',
    token,
    body: { amount: 75, currency: 'EUR', customer_email: 'diner@example.com' },
  });
  assert.strictEqual(created.status, 201);
  const paymentId = created.body.data.id;

  const webhookBody = { payment_id: paymentId, status: 'completed', event_id: `evt_e2e_${paymentId}` };
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(webhookBody))
    .digest('hex');

  const hookRes = await fetch(`${BASE}/api/webhooks/payment-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature },
    body: JSON.stringify(webhookBody),
  });
  assert.strictEqual(hookRes.status, 200);

  const afterHook = await api(`/api/payments/${paymentId}`, { token });
  assert.strictEqual(afterHook.body.data.status, 'completed');
  assert.strictEqual(afterHook.body.data.amount, 75);

  // Provider retry: the duplicate delivery must be acknowledged, not re-applied.
  const retry = await fetch(`${BASE}/api/webhooks/payment-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature },
    body: JSON.stringify(webhookBody),
  });
  const retryBody = await retry.json();
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retryBody.message, 'Already processed');
});

test('socket flow: order creation and status change are broadcast in real time', async () => {
  const socket = ioClient(BASE, { transports: ['websocket'] });
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
  });

  try {
    socket.emit('join_merchant', merchant.id);
    socket.emit('join_table', 12);

    const newOrderPromise = nextEvent(socket, 'new_order');
    const created = await api('/api/table-orders', {
      method: 'POST',
      body: {
        merchant_id: merchant.id,
        table_number: 12,
        items: [{ name: 'Pasta', price: 12, quantity: 1 }],
        customer_name: 'Socket Guest',
      },
    });
    assert.strictEqual(created.status, 201);
    const orderId = created.body.data.id;

    const newOrder = await newOrderPromise;
    assert.strictEqual(newOrder.id, orderId);
    assert.strictEqual(newOrder.table_number, 12);

    const statusPromise = nextEvent(socket, 'order_status_changed');
    const patched = await api(`/api/table-orders/${orderId}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'preparing' },
    });
    assert.strictEqual(patched.status, 200);

    const statusEvent = await statusPromise;
    assert.strictEqual(statusEvent.order_id, orderId);
    assert.strictEqual(statusEvent.status, 'preparing');
    assert.strictEqual(statusEvent.table_number, 12);
  } finally {
    socket.close();
  }
});
