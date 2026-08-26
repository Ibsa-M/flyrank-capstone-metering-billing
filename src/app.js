const express = require('express');
const billingRoutes = require('./routes/billing');

const app = express();
app.use(express.json());

app.use('/', billingRoutes);

module.exports = app;
