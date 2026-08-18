# Marknet — backend

Handles the money-and-access part of the site:
1. Customer taps **Buy** → backend asks Safaricom to send an STK push prompt.
2. Customer enters M-Pesa PIN → Safaricom calls our `/api/mpesa/callback`.
3. Backend generates the hotspot login right away and stores it — no network
   call to the router happens here.
4. **Your MikroTik router polls us** every ~20 seconds (via its own
   scheduler) asking "anything for me to do?", pulls down a tiny script for
   any newly-paid orders, and runs it locally to create the hotspot user.
5. Frontend polls `/api/status/:id` and shows the login once the router
   confirms it created it.

Step 4 is the important bit: most cloud hosts (Render included) can't open
a VPN or direct connection into a router sitting on a home/shop network.
So instead of us reaching into your router, your router reaches out to us
— which needs no special permissions on either side, just a normal HTTPS
request your router already knows how to make.

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
- **MIKROTIK_HOTSPOT_SERVER** — the name of your hotspot server instance, visible in Winbox under **IP > Hotspot > Servers**.
- **ROUTER_POLL_KEY** — make up a long random string. This is the "password" embedded in the URL your router polls; anyone who has it could see/queue hotspot logins, so don't share it.
- **PUBLIC_BASE_URL** — must be a real HTTPS URL both Safaricom and your router can reach. `localhost` will not work; use ngrok while developing.

## 2. Run locally

```bash
npm run dev
```

Server starts on `http://localhost:4000`. For Safaricom's callback (and your router) to reach you locally, expose it with a tunnel:

```bash
ngrok http 4000
```

Copy the `https://xxxx.ngrok-free.app` URL into `PUBLIC_BASE_URL` in `.env`, restart the server.

## 3. Point the frontend at it

In `index.html`, set:

```js
const API_BASE = "https://your-render-url-or-real-domain";
```

## 4. Set up the router side

On your MikroTik, open **New Terminal** (in Winbox or WebFig) and paste this,
replacing `YOUR_BACKEND_URL` and `YOUR_ROUTER_POLL_KEY` with your real values:

```
/system scheduler add name=marknet-poll interval=20s policy=read,write,test,fetch \
  on-event=":do {\
    /tool fetch url=(\"YOUR_BACKEND_URL/api/mikrotik/queue.rsc?key=YOUR_ROUTER_POLL_KEY\") dst-path=marknet-queue.rsc;\
    /import file-name=marknet-queue.rsc;\
  } on-error={}"
```

What this does: every 20 seconds, the router downloads a small script from
your backend listing any newly-paid orders, and runs it — which creates the
hotspot user(s) locally and then calls back to `/api/mikrotik/ack` to
confirm. If there's nothing to do, the script is just a comment and nothing
happens. The `on-error={}` keeps a bad fetch (e.g. brief internet blip)
from spamming your router's logs.

**Test it manually first** before relying on the scheduler: paste just the
`/tool fetch ... /import ...` two lines directly into the terminal after a
test purchase, and check **IP > Hotspot > Users** for the new account.

## 5. Test end-to-end (sandbox)

1. Use Safaricom's sandbox test shortcode/passkey and their **test MSISDN** (found in the Daraja docs) as the phone number.
2. Buy a bundle on the site → Safaricom's sandbox auto-completes the STK prompt (no real phone involved).
3. Check `data.sqlite` (or hit `/api/admin/orders?key=YOUR_ADMIN_KEY`) to confirm the order moves `pending` → `paid` → `queued` → `provisioned`.
4. Check your MikroTik under **IP > Hotspot > Users** for the new account.

## 6. Going to production

- Switch `MPESA_ENV=production`, and use your real, Safaricom-approved shortcode + passkey.
- Deploy this backend somewhere it stays running with a stable HTTPS URL (Render works fine now — it no longer needs to reach your router directly).
- Restrict `cors()` in `src/server.js` to your actual site domain instead of allowing all origins.
- Back up `data.sqlite` regularly — it's your record of every payment and login issued.
- If your router loses internet for a while, nothing is lost: paid orders just sit as `paid` until the scheduler successfully polls again, and any job handed out but not acked within 5 minutes is automatically retried.

## API summary

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/stk-push` | POST | `{ phone, planId }` → starts payment, returns `checkoutRequestId` |
| `/api/status/:id` | GET | Poll for `pending` / `paid` / `queued` / `provisioned` / `failed`, by checkoutRequestId or M-Pesa receipt |
| `/api/mpesa/callback` | POST | Safaricom → us. Not called by the frontend. |
| `/api/relogin` | POST | `{ message }` → paste an M-Pesa confirmation SMS to reconnect |
| `/api/mikrotik/queue.rsc?key=...` | GET | Router → us. Returns pending provisioning commands as a RouterOS script. |
| `/api/mikrotik/ack?key=...&order=...` | GET | Router → us. Confirms a job was run. |
| `/api/admin/orders?key=...` | GET | Recent orders, for support/reconciliation |

### How "Already paid?" (relogin) works

The customer pastes the full M-Pesa confirmation SMS they received. The backend:

1. Pulls the receipt code (e.g. `QGR7XJ2K9L`) and amount out of the message.
2. If that receipt matches an order our own STK push already created, it just hands back a poll id — credentials were already generated when the payment was confirmed.
3. If the receipt is unrecognized — meaning they paid your paybill directly, outside the site — it matches the amount to a bundle and generates fresh credentials.
4. Either way, the router picks the job up on its next poll, same as a normal purchase.
5. Each receipt code can only be redeemed once (a database constraint blocks reuse), so the same SMS can't be pasted twice to get two free logins.

This is a lightweight trust mechanism, not identity verification — anyone who received the SMS can redeem it. That's an acceptable tradeoff for a small hotspot business, but if you want it tighter, consider also asking for the payer's phone number and cross-checking it against your Daraja transaction records via the [Reconciliation/Transaction Status API](https://developer.safaricom.co.ke).
