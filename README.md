# BountyScope

> Bug-bounty intel plus on-demand AI smart-contract analysis.

**Live:** https://bountyscope.ivixivi.workers.dev

BountyScope tracks high-value public smart-contract bug bounty programs, watches
their program pages for changes, and exposes a small API for program discovery,
change monitoring, and AI-assisted vulnerability triage.

It is built as a Cloudflare Worker with a scheduled cron job. The cron polls known
program sources every 30 minutes, records program metadata in KV, appends detected
change events to an intel feed, and serves the web UI plus JSON API from the same
Worker.

## What It Is

BountyScope is an intelligence layer for security teams and researchers who care
about bug bounty scope changes.

- **Program registry:** curated DeFi and smart-contract bounty programs with max
  payout, source, status, and in-scope repositories where available.
- **Intel feed:** recent program-page changes detected by polling source pages and
  comparing HTTP fingerprints, with in-scope repo metadata on paid tiers.
- **AI analyzer:** a Workers AI-backed endpoint that reviews Solidity snippets or
  protocol descriptions and returns vulnerability classes worth investigating.
- **Subscription gate:** free callers get useful but delayed data; paid API keys
  unlock real-time change intelligence and higher feed limits.

BountyScope is the attacker-side complement to
[VulnPulse](https://vulnpulse.ivixivi.workers.dev), which is focused on
defender-side CVE monitoring.

## Who Pays

The free product is useful for discovery and light analysis. The paid product is
for buyers who need time-sensitive intelligence:

- **Protocol teams** pay to know when their own or competitor bounty scope changes,
  so they can react before fresh surface area is exploited or overrun by hunters.
- **Security researchers and bounty hunters** pay for real-time scope-change feeds,
  repo detail, and unlimited analyzer calls while prioritizing targets.
- **Security firms and audit teams** pay for a shared feed that helps researchers
  spot new work and triage protocol changes faster.
- **Insurers and risk analysts** can use the public registry and paid feed as one
  input into protocol risk, bounty maturity, and maximum-loss monitoring.

The monetized value is not the public program list itself; it is speed, depth, and
automation around changes to that list.

## Pricing And Monetization

BountyScope uses a simple three-tier model. The exact enforcement lives in
`TIER_POLICY` in [src/index.ts](./src/index.ts), and the standalone pricing notes
are in [PRICING.md](./PRICING.md).

| Tier | Price | `/api/changes` intel feed | `/api/analyze` quota | Buyer |
| --- | ---: | --- | --- | --- |
| Free | $0 | Delayed 24h, capped at 5 visible events, no repo detail | 5 calls/day per IP or key | Discovery and evaluation |
| Pro | $49/mo | Real-time, up to 200 events, includes in-scope repo detail | Unlimited | Individual researchers and small teams |
| Team | $199/mo | Real-time, up to 1000 events, includes in-scope repo detail | Unlimited | Protocol teams, firms, and shared workspaces |

Paid access is unlocked with an API key minted after payment:

1. `POST /api/subscribe` with `{"tier":"pro"}` or `{"tier":"team"}`.
2. The API returns a USDC payment quote with a `quote_id`.
3. Pay the quote, then `POST /api/confirm` with `{"quote_id","tx_hash"}`.
4. The response returns a `bsk_...` API key. Store it; it is the bearer credential
   for paid requests.

Payment confirmation is delegated to the shared
[payrail](https://payrail.ivixivi.workers.dev) Worker. BountyScope records pending
and active subscriptions in Cloudflare KV and does not custody funds.

## Install

Prerequisites:

- Node.js 20+
- npm
- A Cloudflare account with Workers, Workers AI, and KV access
- Wrangler authentication for deploys: `npx wrangler login`

Install dependencies:

```bash
npm install
```

Run the local checks:

```bash
npm test
npm run typecheck
npm run lint
```

Start a local Worker:

```bash
npx wrangler dev
```

Build a deploy artifact without publishing:

```bash
npm run build
```

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

The checked-in [wrangler.toml](./wrangler.toml) defines:

- `ASSETS` for the static web UI in [public/index.html](./public/index.html)
- `AI` for Workers AI analysis
- `BS_PROGRAMS` for the program registry and change log
- `BS_REPORTS` for analyzer reports, quotas, pending subscriptions, and API keys
- a 30-minute cron trigger for bounty source polling
- an optional `PAYRAIL` service binding and `PAYRAIL_URL` fallback

For production receipt signing, set `SHIP_HMAC_SECRET` as a Wrangler secret when
your payrail deployment requires signed receipt writes:

```bash
npx wrangler secret put SHIP_HMAC_SECRET
```

## Usage

Open the hosted UI or local Wrangler URL in a browser to browse programs, inspect
the change feed, run the analyzer, and start a Pro or Team checkout.

The JSON API is also usable directly.

### List Programs

```bash
curl https://bountyscope.ivixivi.workers.dev/api/programs
```

Returns the curated program list sorted by maximum bounty.

### Read The Intel Feed

```bash
curl https://bountyscope.ivixivi.workers.dev/api/changes
```

Without a key, this uses the Free tier: delayed 24 hours, capped at 5 visible
events, and stripped of `in_scope_repos`.

Use a paid key to unlock real-time feed access:

```bash
curl https://bountyscope.ivixivi.workers.dev/api/changes \
  -H "Authorization: Bearer bsk_xxxxxxxx"
```

You can also send the same key with `x-api-key`.

### Analyze Code Or A Protocol Description

```bash
curl https://bountyscope.ivixivi.workers.dev/api/analyze \
  -H "content-type: application/json" \
  -d '{
    "program_id": "ad-hoc",
    "repo_url": "https://github.com/example/protocol",
    "code": "contract Vault { /* Solidity snippet or protocol notes */ }"
  }'
```

Free callers are limited to 5 analyzer calls per day. Pro and Team keys are not
daily-quota limited:

```bash
curl https://bountyscope.ivixivi.workers.dev/api/analyze \
  -H "Authorization: Bearer bsk_xxxxxxxx" \
  -H "content-type: application/json" \
  -d '{"program_id":"vault","code":"contract Vault { }"}'
```

### Subscribe And Confirm

Create a payment quote:

```bash
curl -i https://bountyscope.ivixivi.workers.dev/api/subscribe \
  -H "content-type: application/json" \
  -d '{"tier":"pro"}'
```

The response status is `402 Payment Required` and includes the payment address,
amount, checkout URL when available, and `quote_id`.

After payment, confirm it and mint an API key:

```bash
curl https://bountyscope.ivixivi.workers.dev/api/confirm \
  -H "content-type: application/json" \
  -d '{"quote_id":"QUOTE_ID","tx_hash":"TRANSACTION_HASH"}'
```

Check the current tier and analyzer quota for a key:

```bash
curl https://bountyscope.ivixivi.workers.dev/api/whoami \
  -H "Authorization: Bearer bsk_xxxxxxxx"
```

Check system health:

```bash
curl https://bountyscope.ivixivi.workers.dev/api/status
```

## API Summary

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/programs` | Optional | Curated bounty programs and known in-scope repositories |
| `GET` | `/api/changes` | Optional, tier-gated | Program-page change feed with Free, Pro, and Team behavior |
| `POST` | `/api/analyze` | Optional, quota-gated | AI vulnerability-class analysis for snippets or descriptions |
| `GET` | `/api/whoami` | Optional | Resolved tier, auth status, and analyzer quota usage |
| `POST` | `/api/subscribe` | None | Create a Pro or Team USDC payment quote |
| `POST` | `/api/confirm` | None | Confirm payment and mint or recover an API key |
| `GET` | `/api/pay-status` | None | Check payrail receipt status by `quote_id` |
| `GET` | `/api/status` | None | Worker health and registry count |

Authentication is intentionally soft-fail: absent, unknown, or revoked keys fall
back to Free tier behavior instead of hard-failing the request.

## Stack

- Cloudflare Workers for API, UI serving, and cron execution
- Cloudflare Workers AI for smart-contract analysis
- Cloudflare KV for program registry, change log, reports, quotas, and keys
- payrail for USDC quote and receipt confirmation
- TypeScript, Wrangler, ESLint, and Node's built-in test runner

## Sister Products

BountyScope is part of an intelligence portfolio:

- [PromptScope](https://promptscope.ivixivi.workers.dev) - LLM system-prompt analyzer
- [EdgarFlash](https://edgarflash.ivixivi.workers.dev) - Real-time SEC EDGAR alerts
- [WriteLens](https://writelens.ivixivi.workers.dev) - Pay-per-call text quality scoring
- [TrendPulse](https://trendpulse.ivixivi.workers.dev) - Daily emerging-tech digest
- [VulnPulse](https://vulnpulse.ivixivi.workers.dev) - Defender-side CVE feed

## License

MIT - see [LICENSE](./LICENSE).
