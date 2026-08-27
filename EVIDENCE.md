# Evidence

### Phase 2: Idempotent Retry (6a)
Command: npx jest -t "test_idempotent_retry_no_duplicate"
Output: PASS — 1182 ms, 1 passed

### Phase 2: Idempotency Mismatch (6b)
Command: npx jest -t "test_idempotency_payload_mismatch"
Output: PASS — 265 ms, 1 passed

### Phase 2: Quota Boundary (6c)
Command: npx jest -t "test_quota_boundary_exact"
Output: PASS — 213 ms, 1 passed

### Phase 2: Concurrent Quota Check (6d)
Command: npx jest -t "test_concurrent_quota_check"
Output: PASS — 274 ms, 1 passed

### Phase 2: Past Due Subscription (6e)
Command: npx jest -t "test_past_due_subscription"
Output: PASS — 204 ms, 1 passed

### Phase 3: Forged Webhook Rejected (2.4.a) — GATE TEST
Command: npx jest tests/stripe.test.js -t "test_forged_webhook_rejected"
Output: PASS — 47 ms, 1 passed. Bad signature → 400, no row written to processed_stripe_events or subscriptions.

### Phase 3: Valid Checkout Session Completed (2.4.b)
Command: npx jest tests/stripe.test.js -t "test_valid_checkout_session_completed"
Output: PASS — 313 ms, 1 passed. Tenant flipped from Free to Pro, old subscription canceled, new active subscription created with stripe_subscription_id.

### Phase 3: Replayed Event Dedup (2.4.c) — GATE TEST
Command: npx jest tests/stripe.test.js -t "test_replayed_event_dedup"
Output: PASS — 324 ms, 1 passed. Same event sent twice → processed_stripe_events has exactly 1 row, second call returns 200 immediately without reprocessing.

### Phase 3: Unrecognized Plan Fails Loud (2.4.d)
Command: npx jest tests/stripe.test.js -t "test_customer_subscription_updated_unrecognized_plan"
Output: PASS — 272 ms, 1 passed. Fake price_id → 500 (StripeInvalidRequestError: No such price), fails loud as designed.
