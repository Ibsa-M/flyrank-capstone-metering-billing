# FlyRank Capstone - Metering & Billing Engine

This repository contains the backend for a robust, idempotent metering and billing engine built for the FlyRank capstone project. 

The system provides endpoints to track fine-grained AI token usage (including reasoning tokens, cached inputs, and fresh inputs) and standard API calls, enforces real-time quota limitations based on active Stripe subscriptions, and provides accurate cost calculations natively priced in thousandths of a cent.

## Architecture

```text
+----------------+        +-------------------+        +----------------+
|  Stripe (SaaS) | <----> | POST /webhooks    |        | PostgreSQL DB  |
+----------------+        +-------------------+        +----------------+
                                  |                             ^
                                  v                             |
+----------------+        +-------------------+                 |
|  Client App    | -----> | POST /generate    | ----------------+
|                | <----- | GET /usage        |
+----------------+        +-------------------+
```

1. **Client App**: Makes requests to `/generate` passing an `Idempotency-Key` and usage payloads.
2. **Billing Service (`/generate`)**:
   - Safely checks quotas using atomic DB row locks (`SELECT FOR UPDATE`).
   - Ensures exactly-once processing (Idempotency) using Postgres unique constraints.
   - Computes usage costs accurately, applying tiered pricing rules per token type.
3. **Stripe Integration**:
   - Processes webhooks (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`) to manage tenant subscription tiers.
   - Validates webhook signatures using the raw request body.

## Setup & Running

1. **Clone & Install Dependencies**
```bash
   npm install
```

2. **Environment Variables**
   Copy the example file and fill in your own Stripe test-mode keys:
```bash
   cp .env.example .env
```
   The default `DATABASE_URL` already matches the Docker Compose setup below —
   no changes needed there for local development.

3. **Start the Database (one command)**
   This starts Postgres and automatically applies all migrations on first run:
```bash
   docker compose up -d
```

4. **Run the Application**
```bash
   npm start
   # Server listens on port 3000
```

5. **Seed Demo Data (optional)**
   To create a demo tenant with usage pre-set near, at, or over its quota:
```bash
   node scripts/seed_quota.js <tenantName> <planName> <targetUsageApi> <targetUsageAi>
   # Example: places tenant "demo" on the Pro plan near its quota (49999/50000 API calls)
   node scripts/seed_quota.js demo pro 49999 0
```

6. **Run Tests**
```bash
   npx jest
```

## Limitations (Out of Scope for Core)
- **Overage Billing**: Not currently implemented. Once a tenant hits their API or AI token quota, they receive a `429 Too Many Requests` hard cap.
- **Proration**: Subscription downgrades/upgrades mid-cycle do not support complex proration logic for historical events.
- **Background Async Quota Checks**: The system currently blocks the `/generate` call to perform strict database quota checks, which may impact tail latency under massive load (Phase 5 stretch goal).
