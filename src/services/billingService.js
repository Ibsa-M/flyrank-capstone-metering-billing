const crypto = require('crypto');
const db = require('../db');

function hashRequest(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
}

/**
 * Calculates placeholder cost for Phase 2.
 * Real pricing rules to be implemented in Phase 4.
 */
function calculatePlaceholderCost(type, payload) {
  if (type === 'api_call') {
    return (payload.quantity || 1) * 1; // 1 cent per API call
  } else if (type === 'ai_tokens') {
    const tokens = payload.tokens || {};
    const input = tokens.input || 0;
    const output = tokens.output || 0;
    return (input + output) * 1; // 1 cent per token
  }
  return 0;
}

async function recordUsageEvent(tenantId, idempotencyKey, payload) {
  const requestHash = hashRequest(payload);
  const type = payload.type;
  
  let quantity = 0;
  let inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, reasoningTokens = 0;
  
  if (type === 'api_call') {
    quantity = payload.quantity || 1;
  } else if (type === 'ai_tokens') {
    const t = payload.tokens || {};
    inputTokens = t.input || 0;
    cachedInputTokens = t.cached_input || 0;
    outputTokens = t.output || 0;
    reasoningTokens = t.reasoning || 0;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Attempt INSERT into usage_events (to handle idempotency via DB constraint)
    let insertedRowId;
    try {
      const insertResult = await client.query(`
        INSERT INTO usage_events (
          tenant_id, idempotency_key, request_hash, type, quantity, 
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, 
          cost_cents, response_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, NULL)
        RETURNING id
      `, [tenantId, idempotencyKey, requestHash, type, quantity, inputTokens, cachedInputTokens, outputTokens, reasoningTokens]);
      
      insertedRowId = insertResult.rows[0].id;
    } catch (error) {
      if (error.code === '23505') { // Postgres unique_violation
        await client.query('ROLLBACK');
        // Fetch the existing row
        const existingRes = await client.query(
          'SELECT request_hash, response_snapshot FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2',
          [tenantId, idempotencyKey]
        );
        const existingRow = existingRes.rows[0];
        
        if (!existingRow) {
           throw new Error('Concurrency conflict, row disappeared');
        }

        if (existingRow.request_hash === requestHash) {
          // Idempotent retry, match
          return { status: 201, data: existingRow.response_snapshot };
        } else {
          // Idempotency key reused with mismatched payload
          return { status: 409, data: { error: 'Idempotency key reused with different payload' } };
        }
      }
      throw error;
    }

    // 2. Fetch Subscription (with row lock for atomicity)
    const subRes = await client.query(`
      SELECT s.*, p.api_call_limit, p.ai_token_limit 
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.tenant_id = $1 AND s.status = 'active'
      FOR UPDATE
    `, [tenantId]);

    const subscription = subRes.rows[0];
    if (!subscription) {
      // Could be canceled, past_due, or unpaid
      await client.query('ROLLBACK');
      
      // Let's find the actual status to return in 402
      const anySubRes = await client.query('SELECT status FROM subscriptions WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 1', [tenantId]);
      const status = anySubRes.rows[0] ? anySubRes.rows[0].status : 'none';
      return { status: 402, data: { error: 'Payment required', subscription_status: status } };
    }

    // 3. Quota check
    let usageRes;
    if (type === 'api_call') {
      usageRes = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) as total_used 
        FROM usage_events 
        WHERE tenant_id = $1 AND type = 'api_call' AND created_at >= $2 AND created_at <= $3
      `, [tenantId, subscription.current_period_start, subscription.current_period_end]);
    } else {
      usageRes = await client.query(`
        SELECT COALESCE(SUM(input_tokens + output_tokens + cached_input_tokens + reasoning_tokens), 0) as total_used 
        FROM usage_events 
        WHERE tenant_id = $1 AND type = 'ai_tokens' AND created_at >= $2 AND created_at <= $3
      `, [tenantId, subscription.current_period_start, subscription.current_period_end]);
    }

    const currentUsed = parseInt(usageRes.rows[0].total_used, 10);
    const limit = type === 'api_call' ? subscription.api_call_limit : subscription.ai_token_limit;
    
    // Note: currentUsed ALREADY includes the row we just inserted above because the query is in the same transaction!
    if (currentUsed > limit) {
      await client.query('ROLLBACK');
      const now = new Date();
      const periodEnd = new Date(subscription.current_period_end);
      const retryAfterSeconds = Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / 1000));
      return { 
        status: 429, 
        headers: { 'Retry-After': retryAfterSeconds.toString() },
        data: { 
          error: 'Quota exceeded', 
          used: currentUsed - (type === 'api_call' ? quantity : (inputTokens + outputTokens + cachedInputTokens + reasoningTokens)), // subtract the failed request attempt 
          limit, 
          period_end: subscription.current_period_end 
        } 
      };
    }

    // 4. Finalize
    const costCents = calculatePlaceholderCost(type, payload);
    const responseSnapshot = {
      usage_event_id: insertedRowId,
      cost_cents: costCents,
      usage_period: {
        used: currentUsed,
        limit,
        remaining: limit - currentUsed,
        period_end: subscription.current_period_end
      }
    };

    await client.query(`
      UPDATE usage_events 
      SET cost_cents = $1, response_snapshot = $2 
      WHERE id = $3
    `, [costCents, responseSnapshot, insertedRowId]);

    await client.query('COMMIT');
    return { status: 201, data: responseSnapshot };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getUsageRollup(tenantId) {
  const subRes = await db.query(`
    SELECT s.current_period_start, s.current_period_end, p.name as plan_name, p.api_call_limit, p.ai_token_limit 
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.tenant_id = $1 AND s.status = 'active'
  `, [tenantId]);

  if (subRes.rows.length === 0) {
    return { status: 404, data: { error: 'No active subscription found' } };
  }

  const sub = subRes.rows[0];

  const usageRes = await db.query(`
    SELECT 
      type,
      COALESCE(SUM(quantity), 0) as api_quantity,
      COALESCE(SUM(input_tokens + output_tokens + cached_input_tokens + reasoning_tokens), 0) as ai_quantity,
      COALESCE(SUM(cost_cents), 0) as total_cost
    FROM usage_events
    WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
    GROUP BY type
  `, [tenantId, sub.current_period_start, sub.current_period_end]);

  let apiUsed = 0, aiUsed = 0, totalCost = 0, apiCost = 0, aiCost = 0;
  
  for (const row of usageRes.rows) {
    const cost = parseInt(row.total_cost, 10);
    totalCost += cost;
    if (row.type === 'api_call') {
      apiUsed = parseInt(row.api_quantity, 10);
      apiCost = cost;
    } else if (row.type === 'ai_tokens') {
      aiUsed = parseInt(row.ai_quantity, 10);
      aiCost = cost;
    }
  }

  return {
    status: 200,
    data: {
      plan: sub.plan_name,
      period_start: sub.current_period_start,
      period_end: sub.current_period_end,
      total_cost_cents: totalCost,
      breakdown: {
        api_call: { used: apiUsed, limit: sub.api_call_limit, cost_cents: apiCost },
        ai_tokens: { used: aiUsed, limit: sub.ai_token_limit, cost_cents: aiCost }
      }
    }
  };
}

module.exports = {
  recordUsageEvent,
  getUsageRollup
};
