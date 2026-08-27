require('dotenv').config();
const request = require('supertest');
const crypto = require('crypto');
const app = require('../src/app');
const db = require('../src/db');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

describe('Stripe Webhooks', () => {
  jest.setTimeout(30000);
  let webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let testProPriceId;
  let testProPlanId;
  let testFreePlanId;
  let testTenantId;
  let testSubscriptionId;
  let testProductName = 'Pro Test ' + Date.now();

  async function createTestTenant(status = 'active') {
    const tenantId = crypto.randomUUID();
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    await db.query(`
      INSERT INTO tenants (id, name) VALUES ($1, 'Test Tenant Stripe')
    `, [tenantId]);

    // Insert subscriptions row for Free Plan
    await db.query(`
      INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
      VALUES ($1, $2, $3, $4, $5)
    `, [tenantId, testFreePlanId, status, periodStart, periodEnd]);

    return tenantId;
  }

  function createSignedWebhookRequest(payload) {
    const payloadString = JSON.stringify(payload);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: payloadString,
      secret: webhookSecret,
    });
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payloadString);
  }

  beforeAll(async () => {
    // 1. Create Plans in DB
    testFreePlanId = crypto.randomUUID();
    testProPlanId = crypto.randomUUID();
    
    await db.query(`
      INSERT INTO plans (id, name, api_call_limit, ai_token_limit, price_cents) 
      VALUES ($1, 'Free Plan', 100, 1000, 0)
    `, [testFreePlanId]);

    await db.query(`
      INSERT INTO plans (id, name, api_call_limit, ai_token_limit, price_cents) 
      VALUES ($1, $2, 10000, 100000, 2000)
    `, [testProPlanId, testProductName]);

    // 2. Setup Stripe test data
    const paymentMethod = await stripe.paymentMethods.create({
      type: 'card',
      card: { token: 'tok_visa' },
    });

    const customer = await stripe.customers.create({ 
      email: 'test_webhook@example.com',
      payment_method: paymentMethod.id,
      invoice_settings: {
        default_payment_method: paymentMethod.id,
      }
    });
    
    const product = await stripe.products.create({ name: testProductName });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 2000,
      currency: 'usd',
      recurring: { interval: 'month' },
    });
    testProPriceId = price.id;
    
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: testProPriceId }],
    });
    testSubscriptionId = sub.id;
  });

  afterAll(async () => {
    await db.pool.end();
  });

  it('test_forged_webhook_rejected', async () => {
    const payload = { type: 'checkout.session.completed', id: 'evt_bad' };
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 't=123,v1=bad_signature')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));
    
    expect(res.status).toBe(400);
    
    // verify NO row was written
    const resDb = await db.query("SELECT * FROM processed_stripe_events WHERE event_id = 'evt_bad'");
    expect(resDb.rows.length).toBe(0);
  });

  it('test_valid_checkout_session_completed', async () => {
    testTenantId = await createTestTenant();
    const eventId = 'evt_test_checkout_' + Date.now();

    const payload = {
      id: eventId,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          object: 'checkout.session',
          client_reference_id: testTenantId,
          subscription: testSubscriptionId,
        }
      }
    };

    const res = await createSignedWebhookRequest(payload);
    expect(res.status).toBe(200);

    // Verify tenant flipped to Pro
    const subRes = await db.query("SELECT * FROM subscriptions WHERE tenant_id = $1 AND status = 'active'", [testTenantId]);
    expect(subRes.rows.length).toBe(1);
    expect(subRes.rows[0].plan_id).toBe(testProPlanId);

    // Verify exactly one active row and one canceled row
    const allSubs = await db.query("SELECT * FROM subscriptions WHERE tenant_id = $1", [testTenantId]);
    expect(allSubs.rows.length).toBe(2);
    expect(allSubs.rows.filter(s => s.status === 'canceled').length).toBe(1);
  });

  it('test_replayed_event_dedup', async () => {
    // Same event ID as previous test
    const eventId = 'evt_test_checkout_' + Date.now(); // wait I need a new one for this test
    const replayedEventId = 'evt_test_replay_' + Date.now();
    
    const payload = {
      id: replayedEventId,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_456',
          object: 'checkout.session',
          client_reference_id: testTenantId, // reuse tenant
          subscription: testSubscriptionId,
        }
      }
    };

    // First send
    const res1 = await createSignedWebhookRequest(payload);
    expect(res1.status).toBe(200);

    // Second send
    const res2 = await createSignedWebhookRequest(payload);
    expect(res2.status).toBe(200);

    // Verify only one row in processed_stripe_events
    const eventDb = await db.query("SELECT * FROM processed_stripe_events WHERE event_id = $1", [replayedEventId]);
    expect(eventDb.rows.length).toBe(1);
  });

  it('test_customer_subscription_updated_unrecognized_plan', async () => {
    const eventId = 'evt_test_unrecognized_' + Date.now();
    const payload = {
      id: eventId,
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: testSubscriptionId,
          object: 'subscription',
          status: 'active',
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 3600,
          items: {
            data: [
              {
                price: { id: 'price_fake_999' } // Fake price ID
              }
            ]
          }
        }
      }
    };

    const res = await createSignedWebhookRequest(payload);
    expect(res.status).toBe(500); // Fail loud
  });
});
