# Billing Engine Design Document

## Problem
Design a robust, idempotent, and highly accurate usage metering and billing engine that tracks API calls and AI tokens across two plans (Free and Pro). It must enforce quotas dynamically per billing period without race conditions, accurately track token types (including reasoning and cached inputs), and handle edge cases gracefully (like retry conflicts or failed payments).

## Data Model
- **`tenants`**: Represents a customer. For Free users, `created_at` anchors their billing period. `stripe_customer_id` links to Stripe.
- **`plans`**: Static reference table containing quotas (`api_call_limit`, `ai_token_limit`) and pricing.
- **`subscriptions`**: The active plan link for a tenant. Explicitly tracks `current_period_start` and `current_period_end`. Free tenants have an explicit row to simplify quota queries.
- **`usage_events`**: Immutable ledger of billable actions. Enforces idempotency via a unique constraint on `(tenant_id, idempotency_key)` and protects against payload swapping with `request_hash`. Distinguishes tokens via granular columns (`input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens`).

## API Surface
- **`POST /generate`**: Records usage. Expects `Idempotency-Key` header. Validates subscription status first (402 Payment Required if invalid), then checks quota (429 Too Many Requests with `Retry-After` if exceeded). Handles idempotency replays (201 with cached response snapshot) or payload mismatches (409 Conflict).
- **`GET /usage`**: Returns period_start/end and granular usage stats (used, limit, cost) split by `api_call` and `ai_tokens`.

## Layer Sketch
1. **API/Routing**: Validates headers (Idempotency-Key), parses body.
2. **Middleware/Auth**: Scopes all requests to a `tenant_id`.
3. **Business Logic (Metering Service)**: Evaluates subscription status -> acquires row lock on subscription -> aggregates current period usage -> validates quota -> calculates cost.
4. **Data Access (Idempotent DB Insert)**: Inserts `usage_event` (catches unique constraint violation to return cached snapshot).

## Explicit Non-Goal
- Overage billing is explicitly a non-goal for the initial implementation. Pro tenants will hit a hard cap (429) rather than being billed for usage beyond their limit.
