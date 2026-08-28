require('dotenv').config();
const db = require('../src/db');
const crypto = require('crypto');

async function seedQuota(tenantName, planName, targetUsageApi, targetUsageAi) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Look up or create tenant by name
    let tenantRes = await client.query(
      'SELECT id FROM tenants WHERE name = $1', [tenantName]
    );
    let tenantId;
    if (tenantRes.rows.length > 0) {
      tenantId = tenantRes.rows[0].id;
      console.log(`Found existing tenant "${tenantName}" (${tenantId})`);
    } else {
      tenantId = crypto.randomUUID();
      await client.query(
        'INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, tenantName]
      );
      console.log(`Created tenant "${tenantName}" (${tenantId})`);
    }

    // 2. Look up plan by name (case-insensitive partial match on 'free' or 'pro')
    const planRes = await client.query(
      "SELECT id, name FROM plans WHERE LOWER(name) LIKE $1 LIMIT 1",
      [`%${planName.toLowerCase()}%`]
    );
    if (planRes.rows.length === 0) {
      throw new Error(`No plan found matching "${planName}". Seed the plans table first.`);
    }
    const planId = planRes.rows[0].id;
    console.log(`Using plan "${planRes.rows[0].name}" (${planId})`);

    // 3. Ensure an active subscription exists for this tenant on this plan
    const subRes = await client.query(
      "SELECT id FROM subscriptions WHERE tenant_id = $1 AND status = 'active'",
      [tenantId]
    );
    if (subRes.rows.length > 0) {
      // Update existing active subscription to point to the requested plan
      await client.query(
        "UPDATE subscriptions SET plan_id = $1 WHERE id = $2",
        [planId, subRes.rows[0].id]
      );
      console.log(`Updated existing active subscription to plan "${planRes.rows[0].name}"`);
    } else {
      // Create a new active subscription
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
      await client.query(`
        INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
        VALUES ($1, $2, 'active', $3, $4)
      `, [tenantId, planId, periodStart, periodEnd]);
      console.log(`Created active subscription on plan "${planRes.rows[0].name}"`);
    }

    // 4. Insert usage events
    if (targetUsageApi > 0) {
      const idempotencyKeyApi = crypto.randomUUID();
      await client.query(`
        INSERT INTO usage_events (
          tenant_id, idempotency_key, request_hash, type, quantity, cost_cents
        ) VALUES ($1, $2, 'seed_hash_api', 'api_call', $3, $4)
      `, [tenantId, idempotencyKeyApi, targetUsageApi, targetUsageApi * 5]);
      console.log(`Seeded ${targetUsageApi} API calls`);
    }

    if (targetUsageAi > 0) {
      const idempotencyKeyAi = crypto.randomUUID();
      await client.query(`
        INSERT INTO usage_events (
          tenant_id, idempotency_key, request_hash, type, quantity, input_tokens, cost_cents
        ) VALUES ($1, $2, 'seed_hash_ai', 'ai_tokens', 0, $3, $4)
      `, [tenantId, idempotencyKeyAi, targetUsageAi, Math.ceil(targetUsageAi * 4 / 1000)]);
      console.log(`Seeded ${targetUsageAi} AI tokens (as input_tokens)`);
    }

    await client.query('COMMIT');
    console.log(`\nDone. Tenant "${tenantName}" is ready with ${targetUsageApi} API calls and ${targetUsageAi} AI tokens.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error seeding quota:', err.message);
  } finally {
    client.release();
    await db.pool.end();
    process.exit(0);
  }
}

const args = process.argv.slice(2);
if (args.length < 4) {
  console.log('Usage: node scripts/seed_quota.js <tenantName> <planName> <targetUsageApi> <targetUsageAi>');
  console.log('Example: node scripts/seed_quota.js demo pro 999 0');
  process.exit(1);
}

seedQuota(args[0], args[1], parseInt(args[2], 10), parseInt(args[3], 10));
