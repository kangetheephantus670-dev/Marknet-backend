const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkout_request_id TEXT UNIQUE,
    merchant_request_id TEXT,
    phone TEXT,
    plan_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | queued | provisioned | failed
    mpesa_receipt TEXT,
    hotspot_username TEXT,
    hotspot_password TEXT,
    source TEXT NOT NULL DEFAULT 'stk', -- stk | relogin (paid outside the STK flow, matched by pasted SMS)
    queued_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- One redemption per M-Pesa receipt: stops the same confirmation SMS
  -- being pasted twice to get connected on two devices. Partial index so
  -- it doesn't block the many rows where mpesa_receipt is still NULL.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_mpesa_receipt
    ON orders(mpesa_receipt) WHERE mpesa_receipt IS NOT NULL;
`);

function createOrder({ checkoutRequestId, merchantRequestId, phone, planId, amount }) {
  const stmt = db.prepare(`
    INSERT INTO orders (checkout_request_id, merchant_request_id, phone, plan_id, amount)
    VALUES (@checkoutRequestId, @merchantRequestId, @phone, @planId, @amount)
  `);
  stmt.run({ checkoutRequestId, merchantRequestId, phone, planId, amount });
  return getOrderByCheckoutId(checkoutRequestId);
}

/**
 * Records a payment that didn't come through our own STK push (e.g. the
 * customer sent money to the paybill directly, then pasted the SMS).
 * Created already "paid" — credentials get attached right after, in the
 * same request, via markPaidWithCredentials.
 */
function createManualOrder({ planId, amount, mpesaReceipt }) {
  const stmt = db.prepare(`
    INSERT INTO orders (phone, plan_id, amount, status, mpesa_receipt, source)
    VALUES (NULL, @planId, @amount, 'pending', @mpesaReceipt, 'relogin')
  `);
  const info = stmt.run({ planId, amount, mpesaReceipt });
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(info.lastInsertRowid);
}

function getOrderByCheckoutId(checkoutRequestId) {
  return db.prepare(`SELECT * FROM orders WHERE checkout_request_id = ?`).get(checkoutRequestId);
}

function findOrderByReceipt(mpesaReceipt) {
  return db.prepare(`SELECT * FROM orders WHERE mpesa_receipt = ?`).get(mpesaReceipt);
}

/**
 * The frontend polls by whatever id it was given — a checkoutRequestId
 * from the STK flow, or an M-Pesa receipt from the relogin flow. This
 * looks up either.
 */
function getOrderByAnyId(id) {
  return db
    .prepare(`SELECT * FROM orders WHERE checkout_request_id = ? OR mpesa_receipt = ?`)
    .get(id, id);
}

function markFailed(checkoutRequestId) {
  db.prepare(`
    UPDATE orders SET status = 'failed', updated_at = datetime('now')
    WHERE checkout_request_id = ?
  `).run(checkoutRequestId);
}

/**
 * Marks an order paid and immediately attaches the hotspot login it will
 * get — generated up front (pure computation, no router contact) so the
 * credentials are sitting there ready the instant the router polls in.
 */
function markPaidWithCredentials(orderId, { mpesaReceipt, username, password }) {
  db.prepare(`
    UPDATE orders
    SET status = 'paid', mpesa_receipt = COALESCE(?, mpesa_receipt),
        hotspot_username = ?, hotspot_password = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(mpesaReceipt || null, username, password, orderId);
}

/** Orders ready for the router to provision: freshly paid, or queued too long without an ack (router likely missed a poll — safe to hand out again). */
function getPendingForRouter() {
  return db.prepare(`
    SELECT * FROM orders
    WHERE status = 'paid'
       OR (status = 'queued' AND queued_at < datetime('now', '-5 minutes'))
    ORDER BY created_at ASC
    LIMIT 50
  `).all();
}

function markQueued(orderId) {
  db.prepare(`
    UPDATE orders SET status = 'queued', queued_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(orderId);
}

function markProvisionedByOrderId(orderId) {
  db.prepare(`
    UPDATE orders SET status = 'provisioned', updated_at = datetime('now')
    WHERE id = ?
  `).run(orderId);
}

module.exports = {
  db,
  createOrder,
  createManualOrder,
  getOrderByCheckoutId,
  findOrderByReceipt,
  getOrderByAnyId,
  markFailed,
  markPaidWithCredentials,
  getPendingForRouter,
  markQueued,
  markProvisionedByOrderId,
};
