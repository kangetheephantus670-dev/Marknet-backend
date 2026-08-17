const express = require('express');
const cors = require('cors');
const config = require('./config');
const paymentsRouter = require('./routes/payments');

const app = express();

app.use(cors()); // In production, restrict this to your site's domain.
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'net-at-10bob-backend' }));

app.use('/api', paymentsRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(config.port, () => {
  console.log(`Net at 10bob backend running on port ${config.port}`);
});
