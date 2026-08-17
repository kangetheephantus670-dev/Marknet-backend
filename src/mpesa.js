const axios = require('axios');
const config = require('./config');

let cachedToken = null;
let tokenExpiresAt = 0;

// Daraja OAuth token, cached until ~1 minute before it expires.
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const credentials = Buffer.from(
    `${config.mpesa.consumerKey}:${config.mpesa.consumerSecret}`
  ).toString('base64');

  const { data } = await axios.get(
    `${config.mpesa.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (Number(data.expires_in) - 60) * 1000;
  return cachedToken;
}

function timestampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function buildPassword(timestamp) {
  const raw = `${config.mpesa.shortcode}${config.mpesa.passkey}${timestamp}`;
  return Buffer.from(raw).toString('base64');
}

// Normalizes 07xxxxxxxx or +2547xxxxxxxx into Safaricom's expected 2547xxxxxxxx format.
function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) return `254${digits}`;
  return digits;
}

/**
 * Initiates an STK Push (Lipa Na M-Pesa Online) prompt on the customer's phone.
 * accountReference / transactionDesc show up in the customer's M-Pesa message.
 */
async function initiateStkPush({ phone, amount, accountReference, transactionDesc }) {
  const token = await getAccessToken();
  const timestamp = timestampNow();
  const password = buildPassword(timestamp);
  const msisdn = normalizePhone(phone);

  const payload = {
    BusinessShortCode: config.mpesa.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: config.mpesa.transactionType,
    Amount: amount,
    PartyA: msisdn,
    PartyB: config.mpesa.shortcode,
    PhoneNumber: msisdn,
    CallBackURL: `${config.publicBaseUrl}/api/mpesa/callback`,
    AccountReference: accountReference.slice(0, 12),
    TransactionDesc: transactionDesc.slice(0, 13),
  };

  const { data } = await axios.post(
    `${config.mpesa.baseUrl}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  // data: { MerchantRequestID, CheckoutRequestID, ResponseCode, ResponseDescription, CustomerMessage }
  return data;
}

/**
 * Parses the callback body Safaricom POSTs to CallBackURL after the customer
 * accepts/declines/times out on the STK prompt.
 */
function parseStkCallback(body) {
  const stk = body?.Body?.stkCallback;
  if (!stk) return null;

  const result = {
    merchantRequestId: stk.MerchantRequestID,
    checkoutRequestId: stk.CheckoutRequestID,
    resultCode: stk.ResultCode,
    resultDesc: stk.ResultDesc,
    success: stk.ResultCode === 0,
    mpesaReceipt: null,
    amount: null,
    phone: null,
  };

  if (result.success && Array.isArray(stk.CallbackMetadata?.Item)) {
    for (const item of stk.CallbackMetadata.Item) {
      if (item.Name === 'MpesaReceiptNumber') result.mpesaReceipt = item.Value;
      if (item.Name === 'Amount') result.amount = item.Value;
      if (item.Name === 'PhoneNumber') result.phone = String(item.Value);
    }
  }

  return result;
}

/**
 * Parses a pasted Safaricom M-Pesa confirmation SMS to pull out the receipt
 * code and amount paid, e.g.:
 *   "QGR7XJ2K9L Confirmed. Ksh20.00 paid to MARKNET. on 17/8/26 at 3:45 PM.
 *    New M-PESA balance is Ksh150.00."
 * Covers standard paybill/till confirmation wording. Returns null if the
 * text doesn't look like a real M-Pesa confirmation message.
 */
function parseConfirmationSms(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();

  const receiptMatch = cleaned.match(/^([A-Z0-9]{9,12})\s+Confirmed/i);
  if (!receiptMatch) return null;

  const amountMatch = cleaned.match(/Ksh\s?([\d,]+(?:\.\d{1,2})?)/i);
  if (!amountMatch) return null;

  const amount = Math.round(parseFloat(amountMatch[1].replace(/,/g, '')));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return { receipt: receiptMatch[1].toUpperCase(), amount };
}

module.exports = {
  getAccessToken,
  initiateStkPush,
  parseStkCallback,
  parseConfirmationSms,
  normalizePhone,
};
