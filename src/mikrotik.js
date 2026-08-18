// This file no longer connects to the router over the network — Render
// (and most cloud PaaS platforms) can't open a VPN/socket into a home or
// shop router. Instead, the ROUTER polls US for work: it fetches a small
// RouterOS script from /api/mikrotik/queue.rsc every ~20s and runs it
// locally. This module just builds that script's text.

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

// Defense in depth: even though every value that reaches this function has
// already been validated upstream (phone digits, plan lookup, or a
// receipt code matched by a strict regex), strip anything that isn't
// alphanumeric/dash before it's ever interpolated into a RouterOS script.
function sanitizeForRouterOs(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Builds the login credentials for a paid order. Pure computation, no
 * network call — stored on the order right away so they're ready the
 * instant the router polls for work.
 */
function generateCredentials({ seed, plan, orderId }) {
  const cleanSeed = sanitizeForRouterOs(seed);
  const digits = cleanSeed.replace(/\D/g, '');
  const idPart = (digits.length >= 6 ? digits.slice(-9) : cleanSeed.slice(-9)) || 'cust';
  const baseUsername = `${idPart}-${orderId}`;
  const password = randomPassword();

  const usernames = [];
  for (let i = 0; i < plan.devices; i++) {
    usernames.push(plan.devices > 1 ? `${baseUsername}-${i + 1}` : baseUsername);
  }

  return { usernames, password };
}

/**
 * Turns already-generated credentials into the RouterOS commands that
 * create them. Called each time /api/mikrotik/queue.rsc is served —
 * deterministic given the same stored username/password, so it's safe to
 * regenerate on every poll until the router acks the order.
 */
function buildAddCommands({ usernames, password, plan, hotspotServer, orderId }) {
  const limitUptime = minutesToRouterOsDuration(plan.durationMinutes);
  const server = sanitizeForRouterOs(hotspotServer);

  return usernames.map(
    (username) =>
      `/ip hotspot user add name="${sanitizeForRouterOs(username)}" password="${password}" server="${server}" limit-uptime="${limitUptime}" comment="order:${orderId}"`
  );
}

module.exports = {
  generateCredentials,
  buildAddCommands,
  minutesToRouterOsDuration,
  sanitizeForRouterOs,
};
