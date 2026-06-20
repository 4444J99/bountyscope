# BountyScope — Pricing & Access Tiers

BountyScope's bug-bounty intel feed is **defender-side**: when an in-scope program
or repo changes, protocol teams and security researchers want to know *first* so
they can react before the change is weaponized. Access is gated by tier. The free
tier is intentionally **limited and delayed**; paid tiers unlock the **real-time**
feed and are authenticated with an API key.

## Tiers

| Tier  | Price    | Intel feed (`/api/changes`)                              | Analyzer (`/api/analyze`)        | Other                                        |
|-------|----------|----------------------------------------------------------|----------------------------------|----------------------------------------------|
| Free  | $0       | Delayed **24h**, capped at **5** events, no repo detail   | **5 calls/day** (per IP)         | Public program list                          |
| Pro   | $49/mo   | **Real-time**, up to **200** events, in-scope repo detail | Unlimited                        | Full program intel + change alerts           |
| Team  | $199/mo  | **Real-time**, up to **1000** events, in-scope repo detail| Unlimited                        | Everything in Pro + custom watchlists + SLA  |

The exact policy lives in one place in code — `TIER_POLICY` in `src/index.ts` — so
this table and the gate can't drift.

## What "limited / delayed" means on the free tier

- **Delayed 24h** — `/api/changes` hides any change event newer than 24 hours for
  free callers. A change a protocol team most wants to see (a fresh in-scope repo
  edit) is exactly what the free tier *cannot* see in time.
- **Capped at 5** — only the 5 most recent *visible* events are returned.
- **No repo detail** — the `in_scope_repos` field is stripped from free results.
- The free response includes `hidden_by_delay` so a caller can see how many
  real-time events they're missing.

## How to subscribe (Stripe)

1. `POST /api/subscribe` with `{"tier":"pro"}` (or `"team"`) → Returns a Stripe `checkout_url`.
2. Complete the payment via Stripe Checkout. You will be redirected to the app with a `session_id`.
3. `POST /api/confirm` with `{"session_id"}`. The session is verified against Stripe, and the response returns your **`api_key`**
   (`bsk_…`). It is shown once — store it.

BountyScope uses Stripe for all billing and does not process card data directly.

## Using your API key

Send it on every gated request, either header form:

```
Authorization: Bearer bsk_xxxxxxxx…
x-api-key: bsk_xxxxxxxx…
```

Check what a key resolves to (tier + remaining analyzer quota):

```
GET /api/whoami        # with the key header
```

An absent, unknown, or revoked key transparently falls back to the **free** tier
— requests never hard-fail on auth; they're just limited.

## Notes

- The free analyzer quota is keyed by API key when present, otherwise by client IP,
  and resets daily (UTC).
- Lost your key? Re-`POST /api/confirm` with your Stripe `session_id`; an already-confirmed
  session returns the existing key instead of minting a new one.
