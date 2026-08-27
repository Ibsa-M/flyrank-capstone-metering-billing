require('dotenv').config();
const request = require('supertest');
const crypto = require('crypto');
const app = require('../src/app');
const db = require('../src/db');
const { calculateCost } = require('../src/services/billingService');
const pricingConfig = require('../src/config/pricing.config');

describe('Pricing Calculation Logic', () => {
  let testTenantId;
  let testPlanId;

  // Pure Unit Tests
  describe('Pure Cost Calculation', () => {
    it('test_hand_calculated_cost', () => {
      // 1000 input @ 4c + 200 cached @ 1c + 500 output @ 12c + 100 reasoning @ 12c
      // = 4 + 0.2 + 6 + 1.2 = 11.4 -> Math.ceil -> 12 cents
      const payload = {
        tokens: {
          input: 1000,
          cached_input: 200,
          output: 500,
          reasoning: 100
        }
      };

      const cost = calculateCost('ai_tokens', payload);
      expect(cost).toBe(12);
    });

    it('test_cached_input_cheaper_than_fresh', () => {
      // Compare 10,000 cached vs 10,000 fresh
      const freshPayload = { tokens: { input: 10000 } };
      const cachedPayload = { tokens: { cached_input: 10000 } };

      const freshCost = calculateCost('ai_tokens', freshPayload);
      const cachedCost = calculateCost('ai_tokens', cachedPayload);

      expect(cachedCost).toBeLessThan(freshCost);
      expect(cachedCost).toBe(Math.ceil(freshCost * 0.25)); // Verifying 25% ratio
    });

    it('test_reasoning_tokens_priced_identically_to_output', () => {
      // Compare 5,000 output vs 5,000 reasoning
      const outputPayload = { tokens: { output: 5000 } };
      const reasoningPayload = { tokens: { reasoning: 5000 } };

      const outputCost = calculateCost('ai_tokens', outputPayload);
      const reasoningCost = calculateCost('ai_tokens', reasoningPayload);

      expect(reasoningCost).toBe(outputCost);
    });
    
    it('test_api_call_pricing', () => {
      const payload = { quantity: 1 };
      const cost = calculateCost('api_call', payload);
      expect(cost).toBe(5);
    });
  });

  // Integration Tests
  describe('Integration Pricing tests', () => {
    beforeAll(async () => {
      testTenantId = crypto.randomUUID();
      testPlanId = crypto.randomUUID();
      
      await db.query("INSERT INTO tenants (id, name) VALUES ($1, 'Pricing Test Tenant')", [testTenantId]);
      
      await db.query(`
        INSERT INTO plans (id, name, api_call_limit, ai_token_limit, price_cents)
        VALUES ($1, 'Pricing Pro', 100, 10000, 1000)
      `, [testPlanId]);
      
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
      
      await db.query(`
        INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
        VALUES ($1, $2, 'active', $3, $4)
      `, [testTenantId, testPlanId, start, end]);
    });

    afterAll(async () => {
      await db.pool.end();
    });

    it('test_pricing_integration_generate_and_rollup', async () => {
      // 1. Post a usage event
      const payload = {
        type: 'ai_tokens',
        tokens: {
          input: 1000,
          cached_input: 200,
          output: 500,
          reasoning: 100
        }
      };

      const res = await request(app)
        .post('/generate')
        .set('x-tenant-id', testTenantId)
        .set('Idempotency-Key', 'test_pricing_idem_1')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.cost_cents).toBe(12); // From hand-calculated math

      // 2. Fetch usage rollup
      const rollup = await request(app)
        .get('/usage')
        .set('x-tenant-id', testTenantId);
      
      expect(rollup.status).toBe(200);
      expect(rollup.body.total_cost_cents).toBe(12);
      expect(rollup.body.breakdown.ai_tokens.cost_cents).toBe(12);
      expect(rollup.body.breakdown.ai_tokens.used).toBe(1800); // 1000+200+500+100
    });
  });
});
