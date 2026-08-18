const express = require('express');
const router = express.Router();

const config = require('../config');
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
    // Log the actual reason Safaricom gave, not just axios's generic
    // "Request failed with status code 400" — that detail is what tells us
    // whether it's bad credentials, a bad shortcode, or something else.
    const daraja = err.response?.data;
    console.error('STK push error:', {
      status: err.response?.status,
      darajaResponse: daraja,
      message: err.message,
    });
    const reason = daraja?.errorMessage || daraja?.ResponseDescription;
    res.status(500).json({ error: reason ? `Payment failed: ${reason}` : 'Could not start payment. Please try again.' });
  }
});

/**
 * GET /api/status/:id
 * Frontend polls this — with either a checkoutRequestId (buy flow) or an
 * M-Pesa receipt (relogin flow) — to know when to show success/connected.
 * "paid" means Safaricom confirmed the money but the router hasn't picked
 * up the job yet; "provisioned" means the login is live on the router.
 */
router.get('/status/:id', (req, res) => {
  const order = db.getOrderByAnyId(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  res.json({
    status: order.status, // pending | paid | queued | provisioned | failed
    hotspotUsername: order.hotspot_username,
    hotspotPassword: order.hotspot_password,
  });
});

/**
 * POST /api/mpesa/callback
 * Safaricom calls this once the customer accepts/declines/times out on the
 * STK prompt. Generates the hotspot credentials right away and stores them
 * — the router picks the job up on its next poll (see /mikrotik/queue.rsc).
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

    const plan = getPlan(order.plan_id);
    const { usernames, password } = mikrotik.generateCredentials({
      seed: order.phone,
      plan,
      orderId: order.id,
    });

    db.markPaidWithCredentials(order.id, {
      mpesaReceipt: result.mpesaReceipt,
      username: usernames.join(', '),
      password,
    });
    console.log(`Order ${order.id} paid — queued for router: ${usernames.join(', ')}`);
  } catch (err) {
    console.error('Post-payment credential generation failed:', err);
  }
});

/**
 * POST /api/relogin
 * body: { message: "<pasted M-Pesa confirmation SMS>" }
 *
 * Lets a customer reconnect by pasting the confirmation text Safaricom sent
 * them, instead of relying on the browser still holding a checkoutRequestId.
 * Three cases:
 *   1. Receipt matches an order that's already provisioned — hand back the
 *      existing login.
 *   2. Receipt matches an order that's paid but not yet picked up by the
 *      router — nothing new to generate, just tell the frontend to poll.
 *   3. Receipt is unrecognized (paid straight to the paybill, outside the
 *      site) — match the amount to a plan, generate fresh credentials.
 * Each M-Pesa receipt can only be redeemed once (enforced by the unique
 * index on orders.mpesa_receipt), so a message can't be reused to connect
 * a second device for free.
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
      if (existing.status === 'provisioned' || existing.status === 'paid' || existing.status === 'queued') {
        // Credentials already exist (generated at payment time) or are on
        // their way — either way, give the frontend something to poll.
        return res.json({ pollId: parsed.receipt, status: existing.status });
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

    const { usernames, password } = mikrotik.generateCredentials({
      seed: parsed.receipt,
      plan: match.details,
      orderId: order.id,
    });

    db.markPaidWithCredentials(order.id, {
      mpesaReceipt: parsed.receipt,
      username: usernames.join(', '),
      password,
    });

    res.json({ pollId: parsed.receipt, status: 'paid' });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This M-Pesa message has already been used to connect a device.' });
    }
    console.error('Relogin error:', err);
    res.status(500).json({ error: "Couldn't verify that payment. Please try again." });
  }
});

/**
 * GET /api/mikrotik/queue.rsc?key=ROUTER_POLL_KEY
 * The router's scheduler fetches this file every ~20s and imports it,
 * running whatever commands it contains. Each job also includes a
 * /tool fetch call back to /mikrotik/ack so we know it landed.
 */
router.get('/mikrotik/queue.rsc', (req, res) => {
  res.type('text/plain');

  if (req.query.key !== config.routerPollKey) {
    return res.status(401).send('# unauthorized\n');
  }

  const pending = db.getPendingForRouter();
  if (pending.length === 0) {
    return res.send('# no pending orders\n');
  }

  const lines = ['# Marknet — auto-generated, do not edit'];

  for (const order of pending) {
    const plan = getPlan(order.plan_id);
    if (!plan || !order.hotspot_username || !order.hotspot_password) continue;

    const usernames = order.hotspot_username.split(', ');
    const commands = mikrotik.buildAddCommands({
      usernames,
      password: order.hotspot_password,
      plan,
      hotspotServer: config.mikrotik.hotspotServer,
      orderId: order.id,
    });

    lines.push(...commands);
    lines.push(
      `/tool fetch url="${config.publicBaseUrl}/api/mikrotik/ack?key=${config.routerPollKey}&order=${order.id}" keep-result=no`
    );

    db.markQueued(order.id);
  }

  res.send(lines.join('\n') + '\n');
});

/**
 * GET /api/mikrotik/ack?key=ROUTER_POLL_KEY&order=123
 * Called by the router (via /tool fetch) right after it successfully runs
 * a job's commands. Marks the order fully provisioned.
 */
router.get('/mikrotik/ack', (req, res) => {
  if (req.query.key !== config.routerPollKey) {
    return res.status(401).send('unauthorized');
  }
  const orderId = Number(req.query.order);
  if (!orderId) return res.status(400).send('missing order');

  db.markProvisionedByOrderId(orderId);
  res.send('ok');
});

/**
 * GET /api/admin/orders?key=ADMIN_API_KEY
 * Basic admin lookup for support/reconciliation. Protect this further
 * (IP allowlist, real auth) before using in production.
 */
router.get('/admin/orders', (req, res) => {
  if (req.query.key !== config.adminApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const rows = db.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

module.exports = router;
