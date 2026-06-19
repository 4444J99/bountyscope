# BountyScope

> Bug-bounty intel + on-demand AI smart-contract analysis.

**Live:** https://bountyscope.ivixivi.workers.dev

BountyScope tracks the top Immunefi DeFi programs (Uniswap V4 $15.5M, MakerDAO/Sky $5M,
Lido $2M, Morpho $2.5M, Optimism $2M, …), polls each program for code changes via HEAD
requests every 30 min, and exposes an AI smart-contract analyzer that flags reentrancy,
access control issues, integer overflow, and other high-severity patterns.

Attacker-side complement to [VulnPulse](https://vulnpulse.ivixivi.workers.dev) (defender-side CVE feed).

## API

```
GET  /api/programs          — Tracked Immunefi programs (severity caps, in-scope repos)
GET  /api/changes           — Intel feed: recent program/repo changes (HEAD diffs). GATED.
POST /api/analyze           — Analyze a Solidity snippet for known vuln patterns. Free: 5/day.
GET  /api/whoami            — Tier + remaining quota for the presented API key
POST /api/subscribe         — { tier } → USDC payment quote (402)
POST /api/confirm           — { quote_id, tx_hash } → mints your API key
GET  /api/status            — System health
```

Gated endpoints read an API key from `Authorization: Bearer bsk_…` or `x-api-key`.
No key → the **free** tier (limited + delayed).

## Pricing

Defender-side intel: the feed is gated so paying teams get changes in real time.
Full detail in **[PRICING.md](./PRICING.md)**.

| Tier  | Price    | Intel feed (`/api/changes`)              | Analyzer        |
|-------|----------|------------------------------------------|-----------------|
| Free  | $0       | Delayed 24h, capped at 5, no repo detail | 5 calls/day     |
| Pro   | $49/mo   | Real-time, ≤200 events, repo detail      | Unlimited       |
| Team  | $199/mo  | Real-time, ≤1000 events, repo detail     | Unlimited       |

**Pay any rail:** GitHub Sponsors, crypto, BMC, latent Stripe. Subscribe → pay USDC
→ confirm returns a `bsk_…` API key.

## Stack

- Cloudflare Workers (compute + cron)
- Cloudflare Workers AI — Llama 3.3 70B for contract analysis
- Cloudflare KV — program registry + report cache

## Sister products

BountyScope is part of an intelligence portfolio:

- [PromptScope](https://promptscope.ivixivi.workers.dev) — LLM system-prompt analyzer
- [EdgarFlash](https://edgarflash.ivixivi.workers.dev) — Real-time SEC EDGAR alerts
- [WriteLens](https://writelens.ivixivi.workers.dev) — Pay-per-call text quality scoring
- [TrendPulse](https://trendpulse.ivixivi.workers.dev) — Daily emerging-tech digest
- [VulnPulse](https://vulnpulse.ivixivi.workers.dev) — Defender-side CVE feed

## License

MIT — see [LICENSE](./LICENSE).
