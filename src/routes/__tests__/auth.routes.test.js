import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { buildApp } from './helpers.js';
import authRoutes from '../auth.routes.js';

let app;

beforeEach(() => {
  app = buildApp([['/api/auth', authRoutes]]);
});

function registerBody(overrides = {}) {
  return {
    email: 'new.merchant@shop.com',
    password: 'SecurePass123!',
    business_name: 'New Shop',
    ...overrides,
  };
}

test('register accepts a valid email address', async () => {
  const res = await request(app).post('/api/auth/register').send(registerBody());
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.user.email, 'new.merchant@shop.com');
  assert.ok(res.body.token, 'expected a JWT in the response');
});

// Bug C regression: the old regex accepted addresses without a TLD.
test('register rejects an email address without a TLD (Bug C)', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send(registerBody({ email: 'user@domain' }));
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /invalid email/i);
});

test('register rejects an email with a one-character TLD (Bug C)', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send(registerBody({ email: 'user@domain.c' }));
  assert.strictEqual(res.status, 400);
});

test('register rejects an email with no @ sign (Bug C)', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send(registerBody({ email: 'userdomain.com' }));
  assert.strictEqual(res.status, 400);
});

test('register rejects a duplicate email address', async () => {
  await request(app).post('/api/auth/register').send(registerBody());
  const res = await request(app).post('/api/auth/register').send(registerBody());
  assert.strictEqual(res.status, 409);
});

test('register rejects passwords shorter than 8 characters', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send(registerBody({ password: 'Short1!' }));
  assert.strictEqual(res.status, 400);
});

// Guards the seeded demo account: its stored password hash must be a valid
// bcrypt hash for "Test123!" so the documented login flow works.
test('seeded demo merchant can log in with Test123!', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'merchant@test.com', password: 'Test123!' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
});

test('login rejects a wrong password', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'merchant@test.com', password: 'WrongPass123!' });
  assert.strictEqual(res.status, 401);
});

test('login rejects an unknown email address', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'nobody@nowhere.com', password: 'Test123!' });
  assert.strictEqual(res.status, 401);
});

test('login requires both email and password', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'merchant@test.com' });
  assert.strictEqual(res.status, 400);
});
