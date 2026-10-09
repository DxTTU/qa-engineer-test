# Bug Reports — EU Pay QA Test API

Tester: Lade Dhatrinath
Environment: Node.js v24, fresh clone, `npm install && npm start` (http://localhost:3000)
Method: every bug below was reproduced against the running API with curl before any code was changed. Responses are quoted verbatim from those runs.

Setup note that applies to several repros: the documented demo login (`merchant@test.com` / `Test123!`) fails out of the box — see Bug H. Where a JWT is needed, the repros register a fresh merchant instead, which is also how the bugs were confirmed.

---

## Bug A: Payment amount is returned as a string instead of a number

**Location:** `src/routes/payment.routes.js` — GET `/api/payments` and GET `/api/payments/:id`
**Severity:** Medium
**Component:** Payment API

**How to Reproduce:**

1. Start the server: `npm start`
2. Register a merchant: `POST /api/auth/register` with `{"email":"qa@test.com","password":"Test123!","business_name":"QA Test Co"}` and keep the returned token
3. Create a payment: `POST /api/payments` with header `Authorization: Bearer <token>` and body `{"amount": 25.5, "currency": "EUR", "customer_email": "a@b.com"}`
4. List payments: `GET /api/payments` with the same token
5. Observe the `amount` field in the JSON response

**Expected Behavior:**
`amount` is a JSON number (`25.5`), consistent with the create-payment response and with what a payment API client needs for arithmetic.

**Actual Behavior:**
`amount` is a JSON string on both read endpoints:

```json
{"id": "3", "amount": "999999999", "currency": "EUR", "status": "pending", ...}
```

Confirmed programmatically: `typeof data[0].amount === "string"`.

**Impact:**
Any client doing arithmetic on the amount gets string behavior instead of numeric behavior: `"25.5" + "10.0"` concatenates to `"25.510.0"`, totals render as `NaN` or silently wrong sums, and strict comparisons (`amount === 25.5`) fail. Money fields are the worst place in a payment API for a type bug.

**Root Cause:**
Both GET handlers explicitly convert the stored numeric amount with `p.amount.toString()` / `payment.amount.toString()` when formatting the response.

**Suggested Fix:**
Return the numeric value (`parseFloat(p.amount)`), keeping the field a JSON number on every endpoint.

---

## Bug B: No maximum payment amount — €999,999,999 payments are accepted

**Location:** `src/routes/payment.routes.js` — POST `/api/payments`
**Severity:** High
**Component:** Payment API

**How to Reproduce:**

1. Start the server and obtain a JWT (register or login)
2. Send: `POST /api/payments` with `{"amount": 999999999, "currency": "EUR", "customer_email": "big@spender.com"}`

**Expected Behavior:**
The request is rejected with 400. A single card payment has a sane ceiling (this codebase's own guidance suggests €50,000).

**Actual Behavior:**
The payment is created successfully:

```json
{"success":true,"message":"Payment created","data":{"id":"3","amount":999999999,"currency":"EUR","status":"pending","customer_email":"big@spender.com"}}
```

**Impact:**
Fat-fingered or malicious amounts (extra zeros, unit confusion between cents and euros) flow straight into settlement, invoicing, and reporting. In a real integration this can trigger provider limit errors far downstream, failed payouts, and reconciliation mismatches that are expensive to unwind after the fact.

**Root Cause:**
The handler validates that the amount is present, numeric, and positive — but never checks an upper bound.

**Suggested Fix:**
Reject `amount > 50000` with `400 {"error": "Amount exceeds the maximum transaction limit of €50,000"}`. Boundary behavior verified: 50000 passes, 50000.01 is rejected.

---

## Bug C: Registration accepts email addresses without a TLD

**Location:** `src/routes/auth.routes.js` — `validateEmail()`
**Severity:** Medium
**Component:** Auth API

**How to Reproduce:**

1. Start the server
2. Send: `POST /api/auth/register` with `{"email":"user@domain","password":"Test123!","business_name":"TLD Test"}`

**Expected Behavior:**
400 `Invalid email format` — `user@domain` has no top-level domain and is not a deliverable address.

**Actual Behavior:**
The account is created and a JWT is issued:

```json
{"message":"Registration successful","user":{"id":"3","email":"user@domain","business_name":"TLD Test"},"token":"eyJhbGciOi..."}
```

**Impact:**
Merchants can register with undeliverable addresses, so password resets, receipts, and payout notifications bounce. Support then has to reconcile "account exists but email never arrives" cases, and any downstream system that assumes validated emails inherits the bad data.

**Root Cause:**
The validation regex `/^[^\s@]+@[^\s@]+$/` only requires an `@` somewhere; it does not require a dot or TLD after the domain.

**Suggested Fix:**
Require a dot plus a TLD of at least two characters: `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`. Verified: `user@domain` and `user@domain.c` are rejected; `fine@domain.com` still registers.

---

## Bug D: Webhook endpoint accepts forged webhooks (no signature verification)

**Location:** `src/routes/webhook.routes.js` — POST `/api/webhooks/payment-status`
**Severity:** Critical
**Component:** Webhooks

**How to Reproduce:**

1. Start the server
2. Send a webhook with an obviously fake signature:

```bash
curl -X POST http://localhost:3000/api/webhooks/payment-status \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: totally-fake-signature" \
  -d '{"payment_id":"1","status":"completed","event_id":"evt_fake_test"}'
```

**Expected Behavior:**
401 `Invalid signature`. A webhook is a claim from the payment provider; without verifying the HMAC signature, the claim is worthless.

**Actual Behavior:**
The forged webhook is fully processed:

```json
{"success":true,"message":"Webhook processed","payment_id":"1","new_status":"completed"}
```

**Impact:**
This is the most serious bug in the codebase. Anyone who can reach the endpoint can mark any payment as `completed` (or `refunded`, or any string) without paying. That is direct revenue fraud: goods/services released against payments that never happened, plus corrupted financial state that reconciliation may not catch until much later.

**Root Cause:**
The handler reads the `x-webhook-signature` header but never computes or compares the expected HMAC-SHA256 signature — the verification code exists only as a comment.

**Suggested Fix:**
Compute `HMAC-SHA256(JSON.stringify(req.body), WEBHOOK_SECRET)` and reject with 401 unless it matches the header. (For production, compare with `crypto.timingSafeEqual` to avoid leaking the signature through response timing — see the risk notes in `test-plan.md`.)

---

## Bug E: Duplicate webhook deliveries are processed repeatedly (no idempotency)

**Location:** `src/routes/webhook.routes.js` — POST `/api/webhooks/payment-status`
**Severity:** High
**Component:** Webhooks

**How to Reproduce:**

1. Start the server
2. Send the same webhook event twice (identical `event_id`):

```bash
curl -X POST http://localhost:3000/api/webhooks/payment-status \
  -H "Content-Type: application/json" \
  -d '{"payment_id":"2","status":"completed","event_id":"evt_dup_001"}'
# send the exact same request again
```

**Expected Behavior:**
The first delivery is processed; the second is acknowledged as a duplicate (HTTP 200 so the provider stops retrying) without re-applying the state change.

**Actual Behavior:**
Both deliveries return `"message":"Webhook processed"` and the status write happens twice. The `event_id` is ignored entirely.

**Impact:**
Payment providers deliver webhooks at-least-once: retries after timeouts are normal and expected. Without idempotency, every retry re-applies side effects — duplicate status notifications, double-counted completions, double "paid" emails/receipts, and race conditions when a stale retry lands after a newer event (e.g. a retried `completed` arriving after `refunded`, silently resurrecting a refunded payment).

**Root Cause:**
The handler never records which `event_id`s have been processed and never checks for them, even though the database has a `processed_webhooks` collection for exactly this purpose.

**Suggested Fix:**
Before applying a webhook, return `200 {"message":"Already processed"}` if its `event_id` is already recorded; after successful processing, record the `event_id`. Verified: first delivery processes, identical second delivery returns `Already processed`.

---

## Bug F: A table can hold multiple pending orders at once

**Location:** `src/routes/table-order.routes.js` — POST `/api/table-orders`
**Severity:** Medium
**Component:** Table Orders

**How to Reproduce:**

1. Start the server
2. Create an order: `POST /api/table-orders` with `{"merchant_id": "1", "table_number": 5, "items": [{"name": "Coffee", "price": 3.5, "quantity": 1}]}`
3. Create a second order for the same table with the same body (change the item if you like)

**Expected Behavior:**
409 — the table already has an active order; the second create should be rejected (or merged into the open order, per product rules — but never a silent duplicate).

**Actual Behavior:**
Both orders are created with 201 and both sit in `pending`:

```json
{"success":true,"message":"Table order created","data":{"id":"20c83621-...","table_number":5,...}}
{"success":true,"message":"Table order created","data":{"id":"f9232f0d-...","table_number":5,...}}
```

**Impact:**
Double-taps, client retries, and two waiters ringing up the same table all create duplicate kitchen tickets: food gets prepared twice, bills split across two orders, and staff have to void items manually. The real-time room (`table_5`) also shows two competing "current" orders.

**Root Cause:**
The create handler never checks whether the same merchant + table already has an order in `pending` status.

**Suggested Fix:**
Look up an existing `pending` order for the merchant + table before creating; if found, return `409 {"error": "Table already has a pending order"}`. Verified: the duplicate is rejected, a different table is unaffected, and a new order is accepted once the previous one is cancelled.

---

## Bug G: The same invoice can be submitted to the tax authority repeatedly

**Location:** `src/routes/einvoice.routes.js` — POST `/api/einvoice/submit`
**Severity:** Medium
**Component:** E-Invoice

**How to Reproduce:**

1. Start the server and obtain a JWT
2. Submit: `POST /api/einvoice/submit` with `{"invoice_id": "inv_dup_test", "customer_siret": "12345678901234"}` and the JWT
3. Send the exact same request again

**Expected Behavior:**
409 — an invoice that has already been submitted (or accepted) must not be filed again.

**Actual Behavior:**
Both submissions succeed, and each generates a **different** submission id:

```json
{"success":true,...,"data":{"invoice_id":"inv_dup_test","submission_id":"SUB-248ecbab-...","status":"submitted",...}}
{"success":true,...,"data":{"invoice_id":"inv_dup_test","submission_id":"SUB-242d4483-...","status":"submitted",...}}
```

**Impact:**
Against a real tax-authority integration (Seqino PDP in production), a double submission is a duplicate legal filing: the same invoice registered twice with the authority, with two different submission references stored against one invoice. That creates compliance exposure and painful reconciliation — which submission id is the real one?

**Root Cause:**
The handler sets `invoice.einvoice_status = 'submitted'` but never checks the current status before submitting, so retries and double-clicks always create a fresh submission.

**Suggested Fix:**
If `invoice.einvoice_status` is `submitted` or `accepted`, return `409 {"error": "Invoice already submitted to tax authority"}` before generating a new submission. Verified: the second submit is rejected and the status endpoint still shows the original submission id.

---

## Bug H (bonus, found during setup): Seeded demo account cannot log in

**Location:** `src/db/database.js` — seeded user `merchant@test.com`
**Severity:** Medium (blocks the documented quick-start and every authenticated test flow)
**Component:** Auth / test data

**How to Reproduce:**

1. Start the server on a fresh clone
2. Follow the README: `POST /api/auth/login` with `{"email":"merchant@test.com","password":"Test123!"}`

**Expected Behavior:**
200 with a JWT, as documented.

**Actual Behavior:**
`{"error":"Invalid credentials"}` — even though these are the documented credentials.

**Root Cause:**
The seeded bcrypt hash is truncated: it is 56 characters long, while a valid bcrypt hash is always 60. Verified directly with bcryptjs — the stored value does not match `Test123!` (or anything), so `bcrypt.compare` can never succeed.

**Impact:**
The documented happy path is broken out of the box: nobody can log in as the demo merchant, so payments, e-invoice, and order endpoints cannot be exercised with the seeded data at all. It is exactly the kind of defect that makes evaluators and new developers distrust the rest of the setup instructions.

**Fix Applied:**
Replaced the seed value with a freshly generated, valid bcrypt hash of `Test123!` (60 chars). The seeded login now works and is covered by a regression test.

---

## Additional observations (not counted among the 7, no behavior changed)

1. **The e-invoice status webhook (`POST /api/webhooks/e-invoice`) has no signature verification either.** Same class of issue as Bug D: a forged tax-authority callback could flip `einvoice_status` arbitrarily. Recommend applying the same HMAC check (with its own secret) before trusting it. Left unchanged here because the assignment scopes signature verification to the payment webhook; flagged for the team.
2. **Secrets are hardcoded** (`JWT_SECRET`, `WEBHOOK_SECRET` in source). Fine for a test assignment, but production code should read them from the environment and fail fast when unset.
3. **IDs are derived from array length** (`String(db.users.length + 1)` in user/payment creation). If records are ever deleted, new records can reuse live IDs. UUIDs (already a dependency) would remove the class of bug.
4. **`POST /api/table-orders` takes `merchant_id` from the request body without authentication**, unlike the other merchant endpoints. Worth a product decision: if waiters' devices are trusted terminals this may be intentional, but as written anyone can create orders under any merchant id.
