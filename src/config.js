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
    // The router polls us for work now — we never connect to it directly —
    // so it just needs the hotspot server name to stamp onto new users.
    hotspotServer: process.env.MIKROTIK_HOTSPOT_SERVER || 'hotspot1',
  },

  // Shared secret embedded in the URL the router's scheduler fetches.
  // Keep this private — anyone with it could see/queue hotspot logins.
  routerPollKey: required('ROUTER_POLL_KEY'),

  adminApiKey: required('ADMIN_API_KEY'),
};
