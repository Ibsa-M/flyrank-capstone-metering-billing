const express = require('express');
const router = express.Router();
const billingService = require('../services/billingService');
const db = require('../db');

// Middleware to extract tenant_id (Mocking auth for capstone Phase 2)
// In a real app, this comes from a verified JWT or API key
router.use((req, res, next) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) {
    return res.status(401).json({ error: 'Missing x-tenant-id header' });
  }
  req.tenantId = tenantId;
  next();
});

router.post('/generate', async (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Missing Idempotency-Key header' });
    }

    if (!req.body || !req.body.type) {
      return res.status(400).json({ error: 'Missing payload or type' });
    }

    const result = await billingService.recordUsageEvent(req.tenantId, idempotencyKey, req.body);
    
    if (result.headers) {
      res.set(result.headers);
    }
    
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Error in /generate:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/usage', async (req, res) => {
  try {
    const result = await billingService.getUsageRollup(req.tenantId);
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Error in /usage:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/dev/reset-usage/:tenantId', async (req, res) => {
  if (process.env.ALLOW_DEV_RESET !== 'true') {
    return res.status(403).json({ error: 'Dev reset not allowed' });
  }
  
  try {
    await db.query('DELETE FROM usage_events WHERE tenant_id = $1', [req.params.tenantId]);
    res.status(200).json({ message: 'Usage reset successfully' });
  } catch (error) {
    console.error('Error in /dev/reset-usage:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
