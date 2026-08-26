const db = require('../src/db');
const crypto = require('crypto');

async function seedQuota(tenantId, planId, targetUsageApi, targetUsageAi) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    
    const idempotencyKeyApi = crypto.randomUUID();
    const idempotencyKeyAi = crypto.randomUUID();

    if (targetUsageApi > 0) {
      await client.query(`
        INSERT INTO usage_events (
          tenant_id, idempotency_key, request_hash, type, quantity, cost_cents
        ) VALUES ($1, $2, 'seed_hash_api', 'api_call', $3, $4)
      `, [tenantId, idempotencyKeyApi, targetUsageApi, targetUsageApi]);
    }
    
    if (targetUsageAi > 0) {
       await client.query(`
        INSERT INTO usage_events (
          tenant_id, idempotency_key, request_hash, type, quantity, input_tokens, cost_cents
        ) VALUES ($1, $2, 'seed_hash_ai', 'ai_tokens', 0, $3, $4)
      `, [tenantId, idempotencyKeyAi, targetUsageAi, targetUsageAi]);
    }

    await client.query('COMMIT');
    console.log(`Successfully seeded ${targetUsageApi} API calls and ${targetUsageAi} AI tokens for tenant ${tenantId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error seeding quota:', err);
  } finally {
    client.release();
    process.exit(0);
  }
}

const args = process.argv.slice(2);
if (args.length < 4) {
  console.log('Usage: node seed_quota.js <tenantId> <planId> <targetUsageApi> <targetUsageAi>');
  process.exit(1);
}

seedQuota(args[0], args[1], parseInt(args[2], 10), parseInt(args[3], 10));
