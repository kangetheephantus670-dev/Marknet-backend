const { RouterOSAPI } = require('node-routeros');
const config = require('./config');

// Converts minutes into RouterOS's "1d02:30:00" style uptime-limit format.
function minutesToRouterOsDuration(totalMinutes) {
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return days > 0
    ? `${days}d${pad(hours)}:${pad(minutes)}:00`
    : `${pad(hours)}:${pad(minutes)}:00`;
}

function randomPassword(length = 6) {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I to avoid confusion
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Creates a hotspot user on the MikroTik router with a time-limited profile
 * matching the purchased plan. Returns the generated login credentials.
 *
 * `seed` identifies the customer for the username — normally their phone
 * number, but for orders matched by a pasted M-Pesa message (no phone on
 * file) the M-Pesa receipt code is used instead.
 *
 * `devices` > 1 is handled by creating N sibling accounts (username-2, -3, ...)
 * since RouterOS hotspot users are single-session by default.
 */
async function provisionHotspotUser({ seed, plan, orderId }) {
  const conn = new RouterOSAPI({
    host: config.mikrotik.host,
    user: config.mikrotik.user,
    password: config.mikrotik.password,
    port: config.mikrotik.port,
    timeout: 8,
  });

  const digits = (seed || '').replace(/\D/g, '');
  const idPart = digits.length >= 6 ? digits.slice(-9) : String(seed || '').slice(-9);
  const baseUsername = `${idPart}-${orderId}`;
  const password = randomPassword();
  const limitUptime = minutesToRouterOsDuration(plan.durationMinutes);

  const created = [];

  try {
    await conn.connect();

    for (let i = 0; i < plan.devices; i++) {
      const username = plan.devices > 1 ? `${baseUsername}-${i + 1}` : baseUsername;

      await conn.write('/ip/hotspot/user/add', [
        `=name=${username}`,
        `=password=${password}`,
        `=server=${config.mikrotik.hotspotServer}`,
        `=limit-uptime=${limitUptime}`,
        `=comment=order:${orderId} ref:${seed}`,
      ]);

      created.push(username);
    }
  } finally {
    conn.close();
  }

  // When devices > 1, all accounts share the same password; the customer
  // logs the second device in with the "-2" username printed on-screen.
  return { username: created.join(', '), password };
}

/** Removes a hotspot user, e.g. for a manual refund or cleanup job. */
async function removeHotspotUser(username) {
  const conn = new RouterOSAPI({
    host: config.mikrotik.host,
    user: config.mikrotik.user,
    password: config.mikrotik.password,
    port: config.mikrotik.port,
    timeout: 8,
  });

  try {
    await conn.connect();
    const rows = await conn.write('/ip/hotspot/user/print', [`?name=${username}`]);
    for (const row of rows) {
      await conn.write('/ip/hotspot/user/remove', [`=.id=${row['.id']}`]);
    }
  } finally {
    conn.close();
  }
}

module.exports = { provisionHotspotUser, removeHotspotUser, minutesToRouterOsDuration };
