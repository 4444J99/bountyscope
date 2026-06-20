# BountyScope API Guide

BountyScope exposes a JSON API for program intelligence, gated change feeds, and
AI-assisted smart-contract analysis. This guide is written for customer
integrations that need repeatable authentication, request examples, response
shapes, and tier behavior.

Production base URL:

```sh
export BASE_URL="https://bountyscope.ivixivi.workers.dev"
```

All POST endpoints expect JSON and should be called with:

```http
Content-Type: application/json
```

## Authentication

Paid access uses a BountyScope API key with the `bsk_` prefix.

Preferred header:

```http
Authorization: Bearer bsk_your_api_key
```

Alternative header:

```http
x-api-key: bsk_your_api_key
```

Missing, unknown, or revoked keys do not return an auth error. They resolve to
the free tier, which means `/api/changes` is delayed and capped and
`/api/analyze` is limited to 5 calls per UTC day.

Check what the API sees:

```sh
curl "$BASE_URL/api/whoami" \
  -H "Authorization: Bearer $BOUNTYSCOPE_API_KEY"
```

Example paid response:

```json
{
  "tier": "pro",
  "authenticated": true,
  "key_present": true,
  "analyze_used_today": 0,
  "analyze_limit": null,
  "changes_real_time": true,
  "issued_at": "2026-06-20T14:25:00.000Z"
}
```

Treat API keys as bearer secrets. Do not place them in query strings or
client-side code that untrusted users can read.

## Quick Start: Buy And Use Pro

1. Request a payment quote:

```sh
curl -i -X POST "$BASE_URL/api/subscribe" \
  -H "Content-Type: application/json" \
  -d '{"tier":"pro"}'
```

`/api/subscribe` returns HTTP `402 Payment Required` by design. The response body
contains the payment instructions.

```json
{
  "status": "payment_required",
  "tier": "pro",
  "quote_id": "quote_123",
  "pay_to": {
    "rail": "crypto",
    "chain": "base",
    "asset": "USDC",
    "address": "0x0000000000000000000000000000000000000049",
    "amount": "49"
  },
  "checkout": null,
  "instructions": "Send exact USDC amount with the quote id as memo.",
  "expires_in_seconds": 900,
  "confirm_url": "/api/confirm"
}
```

2. Send the exact payment shown in `pay_to`, following `instructions`. Keep the
`quote_id`; it is the payment memo and activation handle.

3. Confirm payment with your transaction hash:

```sh
curl -i -X POST "$BASE_URL/api/confirm" \
  -H "Content-Type: application/json" \
  -d '{"quote_id":"quote_123","tx_hash":"0xabc123"}'
```

Successful confirmation returns HTTP `201 Created` and your API key.

```json
{
  "ok": true,
  "tier": "pro",
  "api_key": "bsk_0123456789abcdef0123456789abcdef0123456789abcdef",
  "usage": "Send this key as `Authorization: Bearer <key>` or `x-api-key: <key>`...",
  "receipt": {
    "id": "receipt_123",
    "accepted": true
  }
}
```

If you call `/api/confirm` again with an already activated `quote_id`, the API
returns HTTP `200 OK` with `already_active: true` and the existing key.

4. Use the key:

```sh
export BOUNTYSCOPE_API_KEY="bsk_0123456789abcdef0123456789abcdef0123456789abcdef"

curl "$BASE_URL/api/changes" \
  -H "Authorization: Bearer $BOUNTYSCOPE_API_KEY"
```

## Tier Behavior

| Tier | `/api/changes` | Repo detail | `/api/analyze` |
| --- | --- | --- | --- |
| Free | Delayed 24 hours, max 5 events | No | 5 calls/day per IP or key |
| Pro | Real-time, max 200 events | Yes | Unlimited |
| Team | Real-time, max 1000 events | Yes | Unlimited |

Quota reset is based on the UTC date. Paid tiers are not currently quota-limited
for analysis calls.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/programs` | Optional | Current tracked program registry |
| GET | `/api/changes` | Optional, paid key recommended | Tier-gated program change feed |
| POST | `/api/analyze` | Optional, paid key recommended | Analyze Solidity code or protocol descriptions |
| GET | `/api/whoami` | Optional | Resolve tier and analysis quota for the presented key |
| POST | `/api/subscribe` | No | Request a Pro or Team payment quote |
| POST | `/api/confirm` | No | Confirm payment and mint or recover an API key |
| GET | `/api/pay-status` | No | Poll payment receipt status by `quote_id` |
| GET | `/api/status` | No | Service health summary |

## GET /api/programs

Returns the tracked program registry, sorted by descending `max_bounty_usd`.

```sh
curl "$BASE_URL/api/programs"
```

Example response:

```json
{
  "count": 10,
  "programs": [
    {
      "id": "imm-uniswap",
      "source": "immunefi",
      "name": "Uniswap V4",
      "url": "https://immunefi.com/bounty/uniswapv4/",
      "max_bounty_usd": 15500000,
      "ecosystem": "ethereum",
      "in_scope_repos": ["https://github.com/Uniswap/v4-core"],
      "last_seen_at": "2026-06-20T14:00:00.000Z",
      "status": "live"
    }
  ],
  "note": "Curated starter list. Cron polls headers every 30min for changes."
}
```

Program fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable BountyScope program id |
| `source` | string | `immunefi`, `code4rena`, `sherlock`, `cantina`, or `curated` |
| `name` | string | Program display name |
| `url` | string | Source program URL |
| `max_bounty_usd` | number | Published maximum bounty when known |
| `ecosystem` | string | Ecosystem label when known |
| `in_scope_repos` | string[] | Source repositories when known |
| `in_scope_contracts` | string[] | Contract addresses when known |
| `last_seen_at` | string | Last cron observation timestamp |
| `last_changed_at` | string | Last detected source-header change, when present |
| `status` | string | `live`, `paused`, or `closed` when known |
| `notes` | string | Optional operator notes |

## GET /api/changes

Returns the tier-gated change feed, newest first. BountyScope polls tracked
program URLs every 30 minutes and records events when observed headers change
after the first fingerprint has been stored.

Free request:

```sh
curl "$BASE_URL/api/changes"
```

Paid request:

```sh
curl "$BASE_URL/api/changes" \
  -H "Authorization: Bearer $BOUNTYSCOPE_API_KEY"
```

Example free response:

```json
{
  "tier": "free",
  "real_time": false,
  "delay_hours": 24,
  "count": 5,
  "total_visible": 18,
  "hidden_by_delay": 3,
  "capped": true,
  "changes": [
    {
      "program_id": "imm-aave",
      "name": "Aave Protocol",
      "url": "https://immunefi.com/bounty/aave/",
      "source": "immunefi",
      "max_bounty_usd": 1000000,
      "changed_at": "2026-06-18T15:00:00.000Z"
    }
  ],
  "note": "Free feed is delayed 24h, capped at 5 events, and omits in-scope repo detail..."
}
```

Example paid response:

```json
{
  "tier": "pro",
  "real_time": true,
  "delay_hours": 0,
  "count": 1,
  "total_visible": 1,
  "changes": [
    {
      "program_id": "imm-aave",
      "name": "Aave Protocol",
      "url": "https://immunefi.com/bounty/aave/",
      "source": "immunefi",
      "max_bounty_usd": 1000000,
      "in_scope_repos": ["https://github.com/aave-dao/aave-v3-origin"],
      "changed_at": "2026-06-20T14:00:00.000Z"
    }
  ]
}
```

Recommended polling pattern:

```sh
curl -s "$BASE_URL/api/changes" \
  -H "Authorization: Bearer $BOUNTYSCOPE_API_KEY" |
  jq '.changes[] | {program_id, changed_at, name, in_scope_repos}'
```

There is no pagination cursor. For scheduled integrations, keep your own
`changed_at` watermark and ignore events you have already processed.

## POST /api/analyze

Runs a first-pass smart-contract or protocol analysis and stores the report for
30 days.

Authenticated request:

```sh
curl -X POST "$BASE_URL/api/analyze" \
  -H "Authorization: Bearer $BOUNTYSCOPE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "program_id": "vault-review",
    "repo_url": "https://github.com/example/vault",
    "code": "contract Vault { function withdraw(uint256 amount) external { /* ... */ } }"
  }'
```

Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `code` | string | Required unless `description` is present | Solidity snippet or source content |
| `description` | string | Required unless `code` is present | Protocol or function description |
| `program_id` | string | No | Defaults to `ad-hoc` |
| `repo_url` | string | No | Included in the analysis prompt and report |

The combined `code` or `description` value must be under 60,000 characters.
Chunk larger projects before submitting.

Example response:

```json
{
  "id": "4f2fba03-782a-4543-8b06-ef4b1f3e3b2d",
  "program_id": "vault-review",
  "repo_url": "https://github.com/example/vault",
  "finding_classes": [
    {
      "class": "reentrancy",
      "locations": ["withdraw"],
      "severity": "high",
      "rationale": "External call happens before state is reduced."
    }
  ],
  "attack_surface_summary": "The vault exposes an externally callable withdrawal flow...",
  "recommended_focus": ["withdraw"],
  "generated_at": "2026-06-20T14:05:00.000Z"
}
```

Analysis output is a prioritization aid, not a vulnerability verdict. Validate
findings against the target program rules and source code before taking action.

Common errors:

| Status | Body | Meaning |
| --- | --- | --- |
| 400 | `{"error":"invalid JSON"}` | Request body was not JSON |
| 400 | `{"error":"missing code or description"}` | Neither `code` nor `description` was provided |
| 400 | `{"error":"too long; chunk smaller (<60k chars)"}` | Input exceeded the 60,000 character limit |
| 402 | `{"error":"quota_exceeded", ...}` | Free daily analysis quota is exhausted |
| 500 | `{"error":"inference: ..."}` | Worker AI inference failed |
| 502 | `{"error":"analysis output malformed", ...}` | The model response was not parseable JSON |

## GET /api/whoami

Resolves the presented key and reports the analysis quota state.

```sh
curl "$BASE_URL/api/whoami" \
  -H "Authorization: Bearer $BOUNTYSCOPE_API_KEY"
```

Example anonymous response:

```json
{
  "tier": "free",
  "authenticated": false,
  "key_present": false,
  "analyze_used_today": 2,
  "analyze_limit": 5,
  "changes_real_time": false,
  "issued_at": null
}
```

Field notes:

| Field | Type | Notes |
| --- | --- | --- |
| `tier` | string | `free`, `pro`, or `team` |
| `authenticated` | boolean | True only when the key maps to an active subscription |
| `key_present` | boolean | True when a key header was sent, even if it is invalid |
| `analyze_used_today` | number | UTC-day usage count for the resolved identity |
| `analyze_limit` | number or null | `null` means unlimited under current policy |
| `changes_real_time` | boolean | True for paid real-time feed access |
| `issued_at` | string or null | API key issue timestamp for active keys |

## POST /api/subscribe

Creates a pending Pro or Team payment quote.

```sh
curl -i -X POST "$BASE_URL/api/subscribe" \
  -H "Content-Type: application/json" \
  -d '{"tier":"team"}'
```

Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `tier` | string | No | `pro` or `team`; defaults to `pro` |

Response status is `402 Payment Required` when a quote is created.

```json
{
  "status": "payment_required",
  "tier": "team",
  "quote_id": "quote_123",
  "pay_to": {
    "rail": "crypto",
    "chain": "base",
    "asset": "USDC",
    "address": "0x0000000000000000000000000000000000000049",
    "amount": "199"
  },
  "checkout": null,
  "instructions": "Send exact USDC amount with the quote id as memo.",
  "expires_in_seconds": 900,
  "confirm_url": "/api/confirm"
}
```

Pending quotes are stored for 7 days. The payment quote itself includes its own
`expires_in_seconds`; request a fresh quote if the payment rail indicates expiry.

Error responses:

| Status | Body | Meaning |
| --- | --- | --- |
| 405 | `POST only` | Wrong method |
| 502 | `{"error":"rail_unavailable", ...}` | Payment rail could not provide a quote |

## POST /api/confirm

Confirms payment and activates the subscription key.

```sh
curl -i -X POST "$BASE_URL/api/confirm" \
  -H "Content-Type: application/json" \
  -d '{"quote_id":"quote_123","tx_hash":"0xabc123"}'
```

Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `quote_id` | string | Yes | Value returned by `/api/subscribe` |
| `tx_hash` | string | Yes | Payment transaction hash |

Successful first activation returns `201 Created`. Repeating the same confirmed
quote returns `200 OK` with `already_active: true`.

Error responses:

| Status | Body | Meaning |
| --- | --- | --- |
| 400 | `{"error":"quote_id and tx_hash required"}` | Missing activation fields |
| 404 | `{"error":"quote_not_found_or_expired"}` | No pending or active quote was found |
| 405 | `POST only` | Wrong method |
| 502 | `{"error":"receipt_rejected", ...}` | Payment rail rejected the receipt |

## GET /api/pay-status

Polls payment receipt status by `quote_id`.

```sh
curl "$BASE_URL/api/pay-status?quote_id=quote_123"
```

Unpaid response:

```json
{
  "paid": false,
  "quote_id": "quote_123"
}
```

Paid response:

```json
{
  "paid": true,
  "receipt": {
    "ok": true,
    "quote_id": "quote_123"
  }
}
```

Errors:

| Status | Body | Meaning |
| --- | --- | --- |
| 400 | `{"error":"quote_id required"}` | Missing query parameter |
| 502 | `{"error":"status_unavailable", ...}` | Payment rail status lookup failed |

## GET /api/status

Returns service health and cron state.

```sh
curl "$BASE_URL/api/status"
```

Example response:

```json
{
  "name": "BountyScope",
  "program_count": 10,
  "recent_changes": 1,
  "last_cron_at": "2026-06-20T14:00:00.000Z"
}
```

`recent_changes` is the number of stored programs with `last_changed_at` set.
Use `/api/changes` for the rolling change log.

## Operational Notes

- The program registry is seeded from a curated starter list if KV is empty.
- Cron runs every 30 minutes.
- Change detection uses source `Last-Modified` or `ETag` headers. Some source
  pages may not expose either header, so always verify high-impact findings
  against the official program page.
- First cron observation stores a fingerprint without emitting a change event.
- Change feed events are capped by tier and by the service's rolling log.
- There is no webhook endpoint in the current API. Poll `/api/changes` and keep a
  client-side watermark.
- Paid keys unlock tier behavior; they do not change the legal scope of any bug
  bounty program.
