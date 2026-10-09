# Test Plan — Webhook Payment Flow

Scope of this plan: the end-to-end payment-status webhook path of the EU Pay QA Test API — from a provider-style `POST /api/webhooks/payment-status` through signature verification, idempotent processing, and the resulting payment state — including its security posture and failure modes.

---

## 1. Test Scope

**In scope**

- `POST /api/webhooks/payment-status` — signature verification (HMAC-SHA256), required-field validation, idempotency by `event_id`, payment lookup, status update
- The state change it drives: `GET /api/payments/:id` reflecting the new status afterwards
- Duplicate/retried deliveries, out-of-order and stale events, forged and tampered payloads
- Interaction with the in-memory store (`db.payments`, `db.processed_webhooks`)

**Out of scope**

- UI / frontend behavior
- Performance and load testing (noted as a future activity — see Risks)
- The e-invoice status webhook (`POST /api/webhooks/e-invoice`) — covered by its own smoke checks in the test suite; its missing signature verification is logged as an observation in `bug-reports.md`
- Real provider (Powens) sandbox integration — no credentials in this environment; the provider is simulated with locally signed payloads
- Database persistence beyond process lifetime (the store is in-memory by design)

---

## 2. Test Environment

| Item | Value |
| --- | --- |
| API under test | `http://localhost:3000` (`npm start`), or the booted server on a scratch port for integration tests |
| Client | curl / Postman collection (`postman-collection.json`) for manual tests; Node.js built-in test runner + supertest for automated tests |
| Webhook simulator | curl with an `x-webhook-signature` header; valid signatures computed as `HMAC-SHA256(JSON.stringify(body), WEBHOOK_SECRET)` |
| Database | In-memory, seeded on boot (`merchant@test.com` / `Test123!`, two seeded payments); resets on restart |
| Test data | Seeded payments `1` (completed) and `2` (pending); fresh merchants registered per test run; unique `event_id`s per scenario |
| Oracle | `GET /api/payments/:id` after each webhook to observe the applied state; `npm test` suite for regression |

---

## 3. Test Scenarios

Each scenario lists the expected result **after** the Bug D/E fixes. (Before the fixes, scenarios 2, 3, 4 and 12 failed — that is how the bugs were found.)

| # | Scenario | Expected result |
| --- | --- | --- |
| 1 | Valid webhook, correct signature, existing payment | 200 `Webhook processed`; payment status updated |
| 2 | Webhook with an invalid/forged signature | 401 `Invalid signature`; payment unchanged |
| 3 | Webhook with no signature header | 401 `Invalid signature`; payment unchanged |
| 4 | Duplicate webhook (same `event_id` sent twice) | First: 200 processed. Second: 200 `Already processed`; state applied once |
| 5 | Webhook for a non-existent payment (valid signature) | 404 `Payment not found` |
| 6 | Webhook arrives before the payment is created (valid signature, unknown id) | 404; when the payment later exists it starts in its own initial state (the early webhook is not replayed) |
| 7 | Multiple webhooks for the same payment with different statuses (`completed` → `refunded`, distinct `event_id`s) | Both processed in arrival order; final status is the last one applied |
| 8 | Webhook with missing fields (no `payment_id`, valid signature over the sent body) | 400 `payment_id and status required` |
| 9 | Webhook with malformed JSON body | Request rejected by the JSON parser (400 from the framework); no state change; server stays up |
| 10 | Concurrent webhooks (same `event_id`, fired in parallel) | Exactly one applies the state change; the other is acknowledged as already processed; no 500s |
| 11 | Webhook with SQL-injection-style `payment_id` (`1' OR '1'='1`, valid signature) | 404, not 500; no other payment's status changes |
| 12 | Forged webhook replaying an old, already-processed `event_id` with a fresh fake signature | 401 (signature checked before idempotency); state unchanged |
| 13 | Tampered body (signature computed over a different body than the one sent) | 401; state unchanged |
| 14 | Webhook for another merchant's payment (valid signature) | Processed (webhooks are provider-driven, not merchant-scoped) — the provider is the authority on payment state; merchant scoping happens on read |
| 15 | Happy-path integration: create payment → signed `completed` webhook → read back | `GET /api/payments/:id` shows `status: "completed"` and a numeric `amount` |

Scenarios 1–8, 11, 13 and 15 are automated in `src/routes/__tests__/webhook.routes.test.js` and `src/routes/__tests__/integration.socket.test.js`; 9, 10, 12 and 14 are executed manually with curl during exploratory testing (10 and 12 are candidates to automate next — see Risks).

---

## 4. Security Tests

- **Signature verification (HMAC-SHA256)** — forged signature, missing signature, and signature-over-a-different-body are all rejected with 401 before any field validation or state access (scenarios 2, 3, 13). Verification happens first so attackers learn nothing from validation responses.
- **Replay attack prevention** — a captured, legitimately signed webhook re-sent later is neutralized by idempotency: it returns `Already processed` and changes nothing (scenario 4). A replay with a *modified* body fails signature verification (scenario 13).
- **Signature timing attack** — the current comparison uses `!==`, which short-circuits and could theoretically leak the expected signature through response timing. This is a known, documented limitation: the production recommendation is `crypto.timingSafeEqual` on equal-length buffers. Given the test environment (local, no latency oracle), it is accepted for this assignment and recorded here rather than silently ignored.
- **SQL injection in webhook payload** — `payment_id` values like `1' OR '1'='1` return 404 (scenario 11). The store is in-memory with strict-equality lookups, so there is no query language to inject into; the test exists to prove the endpoint degrades safely rather than erroring.
- **XSS in the status field** — status is stored and returned as data, never rendered by the API; a status of `<script>alert(1)</script>` round-trips as an inert string. No server-side action needed; noted so a future frontend knows to treat it as untrusted text.
- **Secret handling** — `WEBHOOK_SECRET` is hardcoded for this assignment; production must source it from the environment, rotate it, and never log it. Flagged in `bug-reports.md`.

---

## 5. Edge Cases

- **Very large `payment_id`** (e.g. 10,000 characters) — 404, no crash, no pathological lookup cost.
- **Unicode in status** (`"complété ✓"`) — accepted and stored verbatim; the API does not restrict the status vocabulary (see Risks: an allow-list is a product decision).
- **Null/empty `event_id`** — cannot be deduplicated, so the webhook is processed normally. Accepted limitation; providers contractually send event ids. Documented in `fixes.md`.
- **Future timestamps** — the webhook payload carries no timestamp field the API trusts; processing is driven by `event_id` and arrival order, so clock skew at the provider cannot corrupt state.
- **Unknown/extra fields in the payload** — ignored; only `payment_id`, `status`, `event_id` are read.
- **Duplicate delivery with a *different* status but the same `event_id`** — treated as a duplicate (`Already processed`); the first write wins. This is the standard at-least-once semantic: an event id names one event, and one event has one outcome.
- **Empty body with a signature header** — signature over `{}` (or an unparseable body) fails verification → 401; no state change.

---

## 6. Integration Tests

- **Webhook → payment status → read-back** (automated): create a payment via REST, deliver a signed `completed` webhook, then `GET /api/payments/:id` shows `completed` with a numeric amount. (In-memory store ⇒ "persistence" means the state is visible through the API for the life of the process.)
- **Webhook → provider retry** (automated): the same signed webhook re-delivered returns `Already processed` and the payment remains `completed`.
- **Webhook → Socket.IO emission** — **gap (known)**: the webhook route does not currently broadcast payment state changes to Socket.IO rooms, and the README's documented event list (`new_order`, `order_status_changed`) covers table orders only. The Socket.IO path itself is covered end-to-end by the table-order integration test (order created → `new_order` to the merchant room → status change → `order_status_changed` to the table room). Recommendation: define a `payment_status_changed` event for the merchant room and add the matching test.
- **Failed webhook → retry logic**: the API is the *receiver*; retry policy belongs to the provider. The receiver's contract is: 200 on processed/already-processed (stop retrying), 401/400/404 on requests that will never succeed as-is (retrying them unchanged is pointless), 500 reserved for genuine server faults (safe to retry). The scenarios above pin that contract down.

---

## 7. Risk Assessment

| Risk | What could go wrong in production | Detection | Mitigation |
| --- | --- | --- | --- |
| Forged webhooks (was Bug D) | Fake `completed` events → goods released without payment | Signature-failure rate alerts; reconciliation against provider records | HMAC verification (done); timing-safe comparison; IP allow-listing as defense in depth |
| Duplicate/replayed events (was Bug E) | Double-applied side effects; stale retries overwriting newer states | Processed-event log with duplicate counter | Idempotency by `event_id` (done); in production, a unique index on `event_id` in persistent storage (the in-memory list does not survive restarts) |
| Out-of-order events | An older `pending` event lands after `completed` and regresses state | State-transition audit log | Provider event timestamps / status transition rules (reject backwards transitions except `refunded`) |
| Unbounded status vocabulary | Junk statuses (`"complété"`, typos) enter financial state | Schema validation metrics | Allow-list of provider statuses mapped to internal states |
| In-memory store | Restart loses payments and the processed-event list → duplicates re-applied, state lost | N/A (by design here) | Production: PostgreSQL with a unique constraint on `event_id` (the EU Pay stack already uses Postgres) |
| Secret leakage / no rotation | Hardcoded `WEBHOOK_SECRET` committed to the repo | Secret scanning in CI | Env-sourced secrets, rotation procedure, fail-fast when unset |
| Concurrency races | Two parallel deliveries of one event both pass the dedupe check before either records it | Concurrent-delivery test (scenario 10) | Atomic check-and-set (unique constraint / lock) in production storage |
| Amount/type drift on reads (was Bug A) | Clients mis-sum money | Contract tests on response types | Numeric amounts asserted by automated tests (done) |

---

## 8. Entry / Exit Criteria

**Entry:** server boots on a fresh clone (`npm install && npm start`); seed data present; webhook secret known to the test harness.

**Exit:** all scenarios in §3 pass (automated ones via `npm test`, manual ones verified with curl and recorded); no forged/duplicate webhook can alter state; `npm run verify-bugs` reports 0/7 bugs present in the fixed code.

**Current status:** exit criteria met — 53 automated tests passing, including every webhook scenario marked automated above.
