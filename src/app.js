const express = require('express');
const billingRoutes = require('./routes/billing');
const stripeRoutes = require('./routes/stripe');

const app = express();

app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeRoutes.webhookRouter);

app.use(express.json());

app.use('/', billingRoutes);
app.use('/', stripeRoutes.apiRouter);

module.exports = app;
