const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../src/app');
const db = require('../src/db');

describe('Billing Logic (Phase 2)', () => {
  
  // Helper to create a throwaway tenant and subscription for testing
  async function createTestTenant(status = 'active', apiCallLimit = 1000) {
    const tenantId = uuidv4();
    const planId = uuidv4();
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    await db.query(`
      INSERT INTO tenants (id, name) VALUES ($1, 'Test Tenant')
    `, [tenantId]);

    await db.query(`
      INSERT INTO plans (id, name, api_call_limit, ai_token_limit, price_cents) 
      VALUES ($1, 'Test Plan', $2, 10000, 0)
    `, [planId, apiCallLimit]);

    await db.query(`
      INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
      VALUES ($1, $2, $3, $4, $5)
    `, [tenantId, planId, status, periodStart, periodEnd]);

    return { tenantId, planId, periodStart, periodEnd };
  }

  afterAll(async () => {
    await db.pool.end();
  });

  it('test_idempotent_retry_no_duplicate', async () => {
    const { tenantId } = await createTestTenant();
    const idempotencyKey = uuidv4();
    const payload = { type: 'api_call', quantity: 1 };

    // First request
    const res1 = await request(app)
      .post('/generate')
      .set('x-tenant-id', tenantId)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);

    expect(res1.status).toBe(201);
    expect(res1.body.cost_cents).toBe(1);

    // Second request with exact same key and payload
    const res2 = await request(app)
      .post('/generate')
      .set('x-tenant-id', tenantId)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.body).toEqual(res1.body);

    // Verify DB only has 1 row
    const dbRes = await db.query('SELECT * FROM usage_events WHERE tenant_id = $1', [tenantId]);
    expect(dbRes.rows.length).toBe(1);
  });

  it('test_idempotency_payload_mismatch', async () => {
    const { tenantId } = await createTestTenant();
    const idempotencyKey = uuidv4();

    await request(app)
      .post('/generate')
      .set('x-tenant-id', tenantId)
      .set('Idempotency-Key', idempotencyKey)
      .send({ type: 'api_call', quantity: 1 });

    const res2 = await request(app)
      .post('/generate')
      .set('x-tenant-id', tenantId)
      .set('Idempotency-Key', idempotencyKey)
      .send({ type: 'api_call', quantity: 5 }); // Different payload!

    expect(res2.status).toBe(409);
    expect(res2.body.error).toMatch(/payload/i);
  });

  it('test_quota_boundary_exact', async () => {
    const limit = 5;
    const { tenantId } = await createTestTenant('active', limit);

    // Seed usage to limit-1 (4)
    await db.query(`
      INSERT INTO usage_events (tenant_id, idempotency_key, request_hash, type, quantity, cost_cents) 
      VALUES ($1, $2, 'seed_hash', 'api_call', 4, 4)
    `, [tenantId, uuidv4()]);

    // Request 1: at limit-1 -> limit (should succeed)
    const res1 = await request(app)
      .post('/generate')
      .set('x-tenant-id', tenantId)
      .set('Idempotency-Key', uuidv4())
      .send({ type: 'api_call', quantity: 1 });
    
    expect(res1.status).toBe(201);
    expect(res1.body.usage_period.used).toBe(5);

    // Request 2: at limit -> limit+1 (should fail)
    const res2 = await request(app)
      .post('/generate')
      .set('x-tenant-id', tenantId)
      .set('Idempotency-Key', uuidv4())
      .send({ type: 'api_call', quantity: 1 });

    expect(res2.status).toBe(429);
    expect(res2.headers).toHaveProperty('retry-after');
    expect(res2.body.error).toMatch(/quota exceeded/i);
  });

  it('test_concurrent_quota_check', async () => {
    const limit = 10;
    const { tenantId } = await createTestTenant('active', limit);

    // Seed usage to limit-5 (5 used)
    await db.query(`
      INSERT INTO usage_events (tenant_id, idempotency_key, request_hash, type, quantity, cost_cents) 
      VALUES ($1, $2, 'seed_hash', 'api_call', 5, 5)
    `, [tenantId, uuidv4()]);

    // Fire 10 concurrent requests
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        request(app)
          .post('/generate')
          .set('x-tenant-id', tenantId)
          .set('Idempotency-Key', uuidv4())
          .send({ type: 'api_call', quantity: 1 })
      );
    }

    const results = await Promise.all(promises);
    
    const successes = results.filter(r => r.status === 201).length;
    const rateLimits = results.filter(r => r.status === 429).length;

    // Exactly 5 should succeed to reach the limit of 10. The other 5 must fail.
    expect(successes).toBe(5);
    expect(rateLimits).toBe(5);

    // Verify DB usage is exactly 10
    const dbRes = await db.query(`SELECT SUM(quantity) as total FROM usage_events WHERE tenant_id = $1`, [tenantId]);
    expect(parseInt(dbRes.rows[0].total, 10)).toBe(10);
  });

  it('test_past_due_subscription', async () => {
    const { tenantId } = await createTestTenant('past_due');

    const res = await request(app)
      .post('/generate')
      .set('x-tenant-id', tenantId)
      .set('Idempotency-Key', uuidv4())
      .send({ type: 'api_call', quantity: 1 });

    expect(res.status).toBe(402);
    expect(res.body.subscription_status).toBe('past_due');
  });

});
