const express = require('express');
const router = express.Router();

const { getPlan, matchPlanByAmount } = require('../plans');
const mpesa = require('../mpesa');
const mikrotik = require('../mikrotik');
const db = require('../db');

/**
 * POST /api/stk-push
 * body: { phone: "0712345678", planId: "hrs24" }
 * Kicks off an STK Push prompt on the customer's phone and returns the
 * checkoutRequestId the frontend should poll for status.
 */
router.post('/stk-push', async (req, res) => {
  try {
    const { phone, planId } = req.body;
    const plan = getPlan(planId);

    if (!phone || !/^0[71]\d{8}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712345678' });
    }
    if (!plan) {
      return res.status(400).json({ error: 'Unknown plan' });
    }

    const stkResponse = await mpesa.initiateStkPush({
      phone,
      amount: plan.amount,
      accountReference: 'Marknet',
      transactionDesc: plan.label,
    });

    if (stkResponse.ResponseCode !== '0') {
      return res.status(502).json({ error: stkResponse.ResponseDescription || 'STK push failed' });
    }

    db.createOrder({
      checkoutRequestId: stkResponse.CheckoutRequestID,
      merchantRequestId: stkResponse.MerchantRequestID,
      phone,
      planId,
      amount: plan.amount,
    });

    res.json({
      checkoutRequestId: stkResponse.CheckoutRequestID,
      message: 'Check your phone and enter your M-Pesa PIN to complete payment.',
    });
  } catch (err) {
    console.error('STK push error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

/**
 * GET /api/status/:checkoutRequestId
 * Frontend polls this every couple seconds while the customer is completing
 * the STK prompt, to know when to show success/failure/connected.
 */
router.get('/status/:checkoutRequestId', (req, res) => {
  const order = db.getOrderByCheckoutId(req.params.checkoutRequestId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  res.json({
    status: order.status, // pending | paid | provisioned | failed
    hotspotUsername: order.hotspot_username,
    hotspotPassword: order.hotspot_password,
  });
});

/**
 * POST /api/mpesa/callback
 * Safaricom calls this once the customer accepts/declines/times out on the
 * STK prompt. This is where payment gets confirmed and hotspot access granted.
 * Must be reachable over public HTTPS — register this URL's domain in your
 * Daraja app settings.
 */
router.post('/mpesa/callback', async (req, res) => {
  // Always ack Safaricom immediately; do the real work after responding.
  res.json({ ResultCode: 0, ResultDesc: 'Received' });

  try {
    const result = mpesa.parseStkCallback(req.body);
    if (!result) return;

    const order = db.getOrderByCheckoutId(result.checkoutRequestId);
    if (!order) {
      console.warn('Callback for unknown order:', result.checkoutRequestId);
      return;
    }

    if (!result.success) {
      db.markFailed(result.checkoutRequestId);
      console.log(`Payment failed/cancelled for order ${order.id}: ${result.resultDesc}`);
      return;
    }

    db.markPaid(result.checkoutRequestId, { mpesaReceipt: result.mpesaReceipt });

    const plan = getPlan(order.plan_id);
    const { username, password } = await mikrotik.provisionHotspotUser({
      seed: order.phone,
      plan,
      orderId: order.id,
    });

    db.markProvisioned(result.checkoutRequestId, { username, password });
    console.log(`Order ${order.id} provisioned: ${username}`);
  } catch (err) {
    // Payment succeeded but MikroTik provisioning failed — this needs manual
    // follow-up, so log it loudly rather than silently losing the order.
    console.error('Post-payment provisioning failed:', err);
  }
});

/**
 * POST /api/relogin
 * body: { message: "<pasted M-Pesa confirmation SMS>" }
 *
 * Lets a customer reconnect by pasting the confirmation text Safaricom sent
 * them, instead of relying on the browser still holding a checkoutRequestId.
 * Two cases:
 *   1. The receipt matches an order we already created via STK push — just
 *      finish provisioning it if that hasn't happened yet.
 *   2. The receipt is unknown (money was sent straight to the paybill,
 *      outside the site) — match the amount to a plan and provision fresh.
 * Either way, each M-Pesa receipt can only be redeemed once (enforced by
 * the unique index on orders.mpesa_receipt), so a message can't be reused
 * to connect a second device for free.
 */
router.post('/relogin', async (req, res) => {
  try {
    const { message } = req.body;
    const parsed = mpesa.parseConfirmationSms(message);

    if (!parsed) {
      return res.status(400).json({
        error: "That doesn't look like a full M-Pesa confirmation message. Paste the whole SMS, including the code at the start.",
      });
    }

    const existing = db.findOrderByReceipt(parsed.receipt);

    if (existing) {
      if (existing.status === 'provisioned') {
        return res.json({
          status: 'provisioned',
          hotspotUsername: existing.hotspot_username,
          hotspotPassword: existing.hotspot_password,
        });
      }

      if (existing.status === 'paid') {
        const plan = getPlan(existing.plan_id);
        const { username, password } = await mikrotik.provisionHotspotUser({
          seed: existing.phone || parsed.receipt,
          plan,
          orderId: existing.id,
        });
        db.markProvisioned(existing.checkout_request_id, { username, password });
        return res.json({ status: 'provisioned', hotspotUsername: username, hotspotPassword: password });
      }

      // pending or failed
      return res.status(409).json({
        error: 'This payment has not been confirmed yet. Wait a moment and try again.',
      });
    }

    // No matching order — likely paid straight to the paybill. Match by amount.
    const match = matchPlanByAmount(parsed.amount);
    if (!match) {
      return res.status(404).json({
        error: `We couldn't match Ksh ${parsed.amount} to a bundle. Contact support with your M-Pesa message.`,
      });
    }

    const order = db.createManualOrder({
      planId: match.id,
      amount: parsed.amount,
      mpesaReceipt: parsed.receipt,
    });

    const { username, password } = await mikrotik.provisionHotspotUser({
      seed: parsed.receipt,
      plan: match.details,
      orderId: order.id,
    });

    db.markProvisionedByReceipt(parsed.receipt, { username, password });
    res.json({ status: 'provisioned', hotspotUsername: username, hotspotPassword: password });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This M-Pesa message has already been used to connect a device.' });
    }
    console.error('Relogin error:', err);
    res.status(500).json({ error: "Couldn't verify that payment. Please try again." });
  }
});

/**
 * GET /api/admin/orders?key=ADMIN_API_KEY
 * Basic admin lookup for support/reconciliation. Protect this further
 * (IP allowlist, real auth) before using in production.
 */
router.get('/admin/orders', (req, res) => {
  const config = require('../config');
  if (req.query.key !== config.adminApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const rows = db.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

module.exports = router;
