// Keep this list in sync with the package cards on the website.
// durationMinutes / dataLimitDevices drive what gets provisioned on MikroTik.

const PLANS = {
  'min30': { label: '30 Minutes Unlimited', amount: 5, durationMinutes: 30, devices: 1 },
  'hrs2': { label: '2 Hours Unlimited', amount: 10, durationMinutes: 2 * 60, devices: 1 },
  'hrs18': { label: '18 Hrs Unlimited', amount: 20, durationMinutes: 18 * 60, devices: 1 },
  'hrs24': { label: '24 Hrs Unlimited', amount: 35, durationMinutes: 24 * 60, devices: 1 },
  'daily2dev': { label: '24 Hrs Unlimited · 2 devices', amount: 60, durationMinutes: 24 * 60, devices: 2 },
  'weekly': { label: '7 Days Unlimited', amount: 215, durationMinutes: 7 * 24 * 60, devices: 1 },
  'monthly': { label: '1 Month Unlimited', amount: 699, durationMinutes: 30 * 24 * 60, devices: 1 },
  'monthly2dev': { label: '1 Month Unlimited · 2 devices', amount: 900, durationMinutes: 30 * 24 * 60, devices: 2 },
};

function getPlan(planId) {
  return PLANS[planId] || null;
}

// Used by the relogin flow: when a pasted M-Pesa message matches no order
// we started (e.g. paid straight to the paybill), fall back to matching by
// the amount paid.
function matchPlanByAmount(amount) {
  const entry = Object.entries(PLANS).find(([, p]) => p.amount === amount);
  if (!entry) return null;
  return { id: entry[0], details: entry[1] };
}

module.exports = { PLANS, getPlan, matchPlanByAmount };
