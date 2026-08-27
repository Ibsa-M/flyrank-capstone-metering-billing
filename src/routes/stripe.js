const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../db');

const webhookRouter = express.Router();
const apiRouter = express.Router();

apiRouter.post('/checkout', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) {
    return res.status(401).json({ error: 'Missing x-tenant-id header' });
  }

  try {
    // Dynamically get or create a Pro price in Stripe test mode
    const products = await stripe.products.search({ query: "name:'Pro'" });
    let priceId;
    if (products.data.length > 0) {
      const prices = await stripe.prices.list({ product: products.data[0].id, active: true });
      if (prices.data.length > 0) {
        priceId = prices.data[0].id;
      }
    }
    
    if (!priceId) {
      const product = await stripe.products.create({ name: 'Pro' });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: 2000,
        currency: 'usd',
        recurring: { interval: 'month' },
      });
      priceId = price.id;
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      client_reference_id: tenantId,
      success_url: 'http://localhost:3000/success',
      cancel_url: 'http://localhost:3000/cancel',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

webhookRouter.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const eventId = event.id;

  try {
    await db.query(
      'INSERT INTO processed_stripe_events (event_id) VALUES ($1)',
      [eventId]
    );
  } catch (err) {
    if (err.code === '23505') { // unique constraint violation
      return res.status(200).send('Event already processed');
    }
    console.error('Error inserting processed event', err);
    return res.status(500).send('Internal Server Error');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const tenantId = session.client_reference_id;
      
      if (!tenantId) {
         throw new Error("Missing client_reference_id");
      }

      const subscriptionId = session.subscription;

      // Retrieve subscription from Stripe to get the price/product info
      const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price.product'] });
      const productName = sub.items.data[0].price.product.name;

      // Find plan by exact product name match
      const planRes = await db.query(
        "SELECT id FROM plans WHERE name = $1 OR name = $2",
        [productName, productName + ' Plan']
      );
      if (planRes.rows.length === 0) {
        throw new Error(`Pro plan not found in database for product: ${productName}`);
      }
      const proPlanId = planRes.rows[0].id;
      
      // Compute period: now → now + 1 month
      const now = new Date();
      const currentPeriodStart = now.toISOString();
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
      const currentPeriodEnd = periodEnd.toISOString();

      await db.query("UPDATE subscriptions SET status = 'canceled' WHERE tenant_id = $1 AND status = 'active'", [tenantId]);
      
      await db.query(`
        INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end, stripe_subscription_id)
        VALUES ($1, $2, 'active', $3, $4, $5)
      `, [tenantId, proPlanId, currentPeriodStart, currentPeriodEnd, subscriptionId]);

    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const stripePriceId = sub.items.data[0].price.id;
      
      const price = await stripe.prices.retrieve(stripePriceId, {expand: ['product']});
      const productName = price.product.name;
      
      const planRes = await db.query("SELECT id FROM plans WHERE name = $1 OR name = $2", [productName, productName + ' Plan']);
      if (planRes.rows.length === 0) {
        throw new Error(`Unrecognized price/plan ID mapping for product name: ${productName}`);
      }
      const planId = planRes.rows[0].id;
      
      // Use start_date from the event, compute period end as +1 month
      const startEpoch = sub.start_date || sub.billing_cycle_anchor || Math.floor(Date.now() / 1000);
      const currentPeriodStart = new Date(startEpoch * 1000).toISOString();
      const startDate = new Date(startEpoch * 1000);
      const currentPeriodEnd = new Date(startDate.getFullYear(), startDate.getMonth() + 1, startDate.getDate()).toISOString();
      
      await db.query(`
        UPDATE subscriptions 
        SET status = $1, current_period_start = $2, current_period_end = $3, plan_id = $4
        WHERE stripe_subscription_id = $5
      `, [sub.status, currentPeriodStart, currentPeriodEnd, planId, sub.id]);


    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const stripeSubId = sub.id;

      const resSub = await db.query("SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1", [stripeSubId]);
      if (resSub.rows.length > 0) {
        const tenantId = resSub.rows[0].tenant_id;
        
        await db.query("UPDATE subscriptions SET status = 'canceled' WHERE stripe_subscription_id = $1", [stripeSubId]);
        
        const planRes = await db.query("SELECT id FROM plans WHERE name ILIKE '%Free%'");
        if (planRes.rows.length === 0) {
          throw new Error("Free plan not found in database");
        }
        const freePlanId = planRes.rows[0].id;
        
        const now = new Date();
        const start = now.toISOString();
        const end = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).toISOString();

        await db.query(`
          INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
          VALUES ($1, $2, 'active', $3, $4)
        `, [tenantId, freePlanId, start, end]);
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling event:', err);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = { apiRouter, webhookRouter };
