# Marknet — backend

Handles the money-and-access part of the site:
1. Customer taps **Buy** → backend asks Safaricom to send an STK push prompt.
2. Customer enters M-Pesa PIN → Safaricom calls our `/api/mpesa/callback`.
3. On success, backend logs into your MikroTik router and creates a
   time-limited hotspot login for that customer.
4. Frontend polls `/api/status/:checkoutRequestId` and shows the login once ready.

## 1. Install

Requires Node.js 18+.

```bash
cd backend
npm install
cp .env.example .env
```

Fill in `.env`:

- **M-Pesa (Daraja) values** — from https://developer.safaricom.co.ke
  - Create an account, create an app, and you'll get `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET`.
  - `MPESA_SHORTCODE` and `MPESA_PASSKEY` come from your **Lipa Na M-Pesa Online** product — for sandbox testing, Safaricom gives you a public test shortcode (174379) and passkey on their docs site.
  - Going live requires Safaricom to approve your paybill/till for Lipa Na M-Pesa Online — this is a business registration step done through Safaricom, not something code can skip.
- **MikroTik values**
  - On your router: `/user add name=api-user password=... group=full` (or a narrower group with API + hotspot permissions).
  - Make sure the RouterOS API service is enabled: `/ip service enable api` (port 8728 by default). If your router is remote, consider `api-ssl` (port 8729) instead and keep the API off the public internet — put it behind a VPN or restrict by source IP with a firewall rule.
  - `MIKROTIK_HOTSPOT_SERVER` is the name of your hotspot server instance, visible under **IP > Hotspot > Servers**.
- **PUBLIC_BASE_URL** — must be a real HTTPS URL Safaricom can reach for the callback. `localhost` will not work; use ngrok while developing.

## 2. Run locally

```bash
npm run dev
```

Server starts on `http://localhost:4000`. For Safaricom's callback to reach you locally, expose it with a tunnel:

```bash
ngrok http 4000
```

Copy the `https://xxxx.ngrok-free.app` URL into `PUBLIC_BASE_URL` in `.env`, restart the server.

## 3. Point the frontend at it

In `index.html`, set:

```js
const API_BASE = "https://your-ngrok-or-real-domain";
```

## 4. Test end-to-end (sandbox)

1. Use Safaricom's sandbox test shortcode/passkey and their **test MSISDN** (found in the Daraja docs) as the phone number.
2. Buy a bundle on the site → you'll get a simulated STK prompt result automatically from Safaricom's sandbox (no real phone involved).
3. Check `data.sqlite` (or hit `/api/admin/orders?key=YOUR_ADMIN_KEY`) to confirm the order moved from `pending` → `paid` → `provisioned`.
4. Check your MikroTik under **IP > Hotspot > Users** for the new account.

## 5. Going to production

- Switch `MPESA_ENV=production`, and use your real, Safaricom-approved shortcode + passkey.
- Deploy this backend somewhere it stays running with a stable HTTPS URL — see hosting options below.
- Make sure the backend can reach your MikroTik router: if the router isn't on the same network as your host, use a VPN (WireGuard/OpenVPN) between them rather than exposing the RouterOS API publicly.
- Restrict `cors()` in `src/server.js` to your actual site domain instead of allowing all origins.
- Back up `data.sqlite` regularly — it's your record of every payment and login issued.

## API summary

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/stk-push` | POST | `{ phone, planId }` → starts payment, returns `checkoutRequestId` |
| `/api/status/:checkoutRequestId` | GET | Poll for `pending` / `paid` / `provisioned` / `failed` |
| `/api/mpesa/callback` | POST | Safaricom → us. Not called by the frontend. |
| `/api/relogin` | POST | `{ message }` → paste an M-Pesa confirmation SMS to reconnect |
| `/api/admin/orders?key=...` | GET | Recent orders, for support/reconciliation |

### How "Already paid?" (relogin) works

The customer pastes the full M-Pesa confirmation SMS they received. The backend:

1. Pulls the receipt code (e.g. `QGR7XJ2K9L`) and amount out of the message.
2. If that receipt matches an order our own STK push created, it finishes provisioning it (covers the case where the callback fired but the customer's browser lost the session).
3. If the receipt is unrecognized — meaning they paid your paybill directly, outside the site — it matches the amount to a bundle and provisions a hotspot login from scratch.
4. Each receipt code can only be redeemed once (a database constraint blocks reuse), so the same SMS can't be pasted twice to get two free logins.

This is a lightweight trust mechanism, not identity verification — anyone who received the SMS can redeem it. That's an acceptable tradeoff for a small hotspot business, but if you want it tighter, consider also asking for the payer's phone number and cross-checking it against your Daraja transaction records via the [Reconciliation/Transaction Status API](https://developer.safaricom.co.ke).
