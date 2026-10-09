# Submission Summary — EU Pay QA Engineer Assignment

**Candidate:** Lade Dhatrinath

**Approach in brief:** I treated the API the way its own README asks to be treated — as a black box first. I booted it, ran the documented happy paths, and then probed it systematically (invalid inputs, boundary values, forged and replayed webhooks, duplicate submissions) with curl, recording the actual responses before reading a single line of route code. All 7 intended bugs reproduced live, plus one extra that blocked the documented login. Each fix is a minimal, surgical change with a comment explaining it; every fix is locked in with automated regression tests (53 tests, all passing via `npm test`), and the webhook flow has a dedicated test plan with a risk assessment.

## What is in this submission

| File | Contents |
| --- | --- |
| `bug-reports.md` | All 7 bugs + 1 bonus finding (broken seed login), each with reproduction steps, verbatim responses, impact, and root cause |
| `fixes.md` | Per-bug diffs, rationale, and the tests that guard them |
| `test-plan.md` | Webhook payment-flow test plan: scope, environment, 15 scenarios, security tests, edge cases, integration tests, risk assessment |
| Fixed code | `src/routes/payment.routes.js`, `auth.routes.js`, `webhook.routes.js`, `table-order.routes.js`, `einvoice.routes.js`, `src/db/database.js` |
| Tests | `src/routes/__tests__/` — auth, payment, webhook, table-order, e-invoice suites plus a real-server Socket.IO end-to-end test (`integration.socket.test.js`) and shared `helpers.js` |

## The bugs, in one line each

- **A** — payment amounts were returned as strings on both read endpoints (client math broke). Fixed to numbers.
- **B** — no maximum amount; a €999,999,999 payment was created. Added the €50,000 cap (boundary-tested).
- **C** — registration accepted `user@domain`. Email validation now requires a TLD.
- **D** *(critical)* — webhooks accepted forged signatures; anyone could mark payments `completed`. HMAC-SHA256 verification now runs first.
- **E** — duplicate webhook deliveries re-applied state. Processing is now idempotent by `event_id`.
- **F** — a table could hold multiple pending orders. Duplicate creates now return 409.
- **G** — invoices could be submitted to the tax authority repeatedly, each with a new submission id. Re-submits now return 409.
- **H (bonus)** — the seeded demo account's bcrypt hash was truncated (56 vs 60 chars), so the documented login never worked. Replaced with a valid hash.

I also wired the documented Socket.IO emissions (`new_order`, `order_status_changed`) — the server already exposed its `io` instance to the routes, but the emit calls were commented out, so real-time clients received nothing. Both are covered by an end-to-end test with a real Socket.IO client.

## Verification

- `npm test` — 53 tests, 53 passing.
- `npm run verify-bugs` — 0/7 bugs present in the fixed code (the script is a pre-flight presence check for the original repo, so 0/7 is the expected post-fix result).
- Every fix additionally verified by hand with curl, including boundary cases (€50,000 vs €50,000.01, one-character TLDs, tampered-body signatures, provider-style webhook retries).

Known limitations are stated rather than hidden: the in-memory store loses state on restart, `event_id`-less webhooks cannot be deduplicated, and signature comparison should move to `crypto.timingSafeEqual` in production — all three are written up in `test-plan.md` with mitigations.
