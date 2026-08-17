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
    status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | provisioned
    mpesa_receipt TEXT,
    hotspot_username TEXT,
    hotspot_password TEXT,
    source TEXT NOT NULL DEFAULT 'stk', -- stk | relogin (paid outside the STK flow, matched by pasted SMS)
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

function getOrderByCheckoutId(checkoutRequestId) {
  return db.prepare(`SELECT * FROM orders WHERE checkout_request_id = ?`).get(checkoutRequestId);
}

function markPaid(checkoutRequestId, { mpesaReceipt }) {
  db.prepare(`
    UPDATE orders SET status = 'paid', mpesa_receipt = ?, updated_at = datetime('now')
    WHERE checkout_request_id = ?
  `).run(mpesaReceipt, checkoutRequestId);
}

function markFailed(checkoutRequestId) {
  db.prepare(`
    UPDATE orders SET status = 'failed', updated_at = datetime('now')
    WHERE checkout_request_id = ?
  `).run(checkoutRequestId);
}

function markProvisioned(checkoutRequestId, { username, password }) {
  db.prepare(`
    UPDATE orders
    SET status = 'provisioned', hotspot_username = ?, hotspot_password = ?, updated_at = datetime('now')
    WHERE checkout_request_id = ?
  `).run(username, password, checkoutRequestId);
}

function markProvisionedByReceipt(mpesaReceipt, { username, password }) {
  db.prepare(`
    UPDATE orders
    SET status = 'provisioned', hotspot_username = ?, hotspot_password = ?, updated_at = datetime('now')
    WHERE mpesa_receipt = ?
  `).run(username, password, mpesaReceipt);
}

function findOrderByReceipt(mpesaReceipt) {
  return db.prepare(`SELECT * FROM orders WHERE mpesa_receipt = ?`).get(mpesaReceipt);
}

/**
 * Records a payment that didn't come through our own STK push (e.g. the
 * customer sent money to the paybill directly). Created already "paid" —
 * provisioning happens right after, in the same request.
 */
function createManualOrder({ planId, amount, mpesaReceipt }) {
  const stmt = db.prepare(`
    INSERT INTO orders (phone, plan_id, amount, status, mpesa_receipt, source)
    VALUES (NULL, @planId, @amount, 'paid', @mpesaReceipt, 'relogin')
  `);
  const info = stmt.run({ planId, amount, mpesaReceipt });
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(info.lastInsertRowid);
}

function findLatestPaidOrderByPhone(phone) {
  return db.prepare(`
    SELECT * FROM orders
    WHERE phone = ? AND status IN ('paid', 'provisioned')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(phone);
}

module.exports = {
  db,
  createOrder,
  createManualOrder,
  getOrderByCheckoutId,
  findOrderByReceipt,
  markPaid,
  markFailed,
  markProvisioned,
  markProvisionedByReceipt,
  findLatestPaidOrderByPhone,
};
