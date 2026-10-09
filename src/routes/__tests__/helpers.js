import express from 'express';
import { initDatabase, db } from '../../db/database.js';

/**
 * Test helpers.
 *
 * Each test file builds a small Express app with only the routers it needs,
 * backed by the real (in-memory) database module and the real route code.
 * State is reset before every test so tests stay independent.
 */

export function resetDatabase() {
  db.users.length = 0;
  db.payments.length = 0;
  db.sessions.length = 0;
  db.table_orders.length = 0;
  db.invoices.length = 0;
  db.processed_webhooks.length = 0;
  initDatabase();
}

export function buildApp(routeMounts) {
  resetDatabase();
  const app = express();
  app.use(express.json());
  for (const [mountPath, router] of routeMounts) {
    app.use(mountPath, router);
  }
  return app;
}

/** Log in as the seeded demo merchant and return the JWT. */
export async function loginAsSeedMerchant(request, app) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'merchant@test.com', password: 'Test123!' });
  if (res.status !== 200) {
    throw new Error(`Seed merchant login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}
