require('dotenv').config();

function required(name, fallback) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

module.exports = {
  port: process.env.PORT || 4000,
  publicBaseUrl: required('PUBLIC_BASE_URL'),

  mpesa: {
    env: process.env.MPESA_ENV || 'sandbox',
    consumerKey: required('MPESA_CONSUMER_KEY'),
    consumerSecret: required('MPESA_CONSUMER_SECRET'),
    shortcode: required('MPESA_SHORTCODE'),
    passkey: required('MPESA_PASSKEY'),
    transactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    get baseUrl() {
      return this.env === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';
    },
  },

  mikrotik: {
    host: required('MIKROTIK_HOST'),
    user: required('MIKROTIK_USER'),
    password: required('MIKROTIK_PASSWORD'),
    port: Number(process.env.MIKROTIK_PORT || 8728),
    hotspotServer: process.env.MIKROTIK_HOTSPOT_SERVER || 'hotspot1',
  },

  adminApiKey: required('ADMIN_API_KEY'),
};
