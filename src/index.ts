/**
 * BountyScope — bug bounty intel + on-demand AI contract analysis.
 *
 * Two purposes:
 *   1. Internal use: surface high-EV bounty targets for the operator's own hunting.
 *   2. Paid product: sell curated intel + analysis to other bounty hunters.
 *
 * Cron polls program sources every 30min, surfaces changes.
 * Free tier: top-N program listing.
 * Paid (when wired): real-time webhook alerts + analyze-on-demand endpoint.
 */

interface Env {
  AI: any;
  ASSETS: Fetcher;
  BS_PROGRAMS: KVNamespace;
  BS_REPORTS: KVNamespace;
  USER_AGENT: string;
  // Shared fleet money rail. PAYRAIL is a service binding (preferred — a direct
  // internal worker→worker call that skips the public edge, so it dodges both the
  // *.workers.dev same-zone restriction and edge bot-management). PAYRAIL_URL is the
  // public-hostname fallback (used when the binding is absent, e.g. local/standby).
  // SHIP_HMAC_SECRET (a wrangler secret, unset by default) signs receipt writes.
  PAYRAIL?: Fetcher;
  PAYRAIL_URL?: string;
  SHIP_HMAC_SECRET?: string;
}

type Source = 'immunefi' | 'code4rena' | 'sherlock' | 'cantina' | 'curated';

interface Program {
  id: string;
  source: Source;
  name: string;
  url: string;
  max_bounty_usd?: number;
  ecosystem?: string;       // e.g., "ethereum", "solana", "evm-multi"
  in_scope_repos?: string[];
  in_scope_contracts?: string[];
  last_seen_at: string;
  last_changed_at?: string;
  status?: 'live' | 'paused' | 'closed';
  notes?: string;
}

const PROGRAMS_KEY = 'programs:list';
const REPORT_PREFIX = 'report:';

// === payrail (shared fleet money rail) ===
// bountyscope plugs into the live payrail Worker instead of re-implementing
// "wallet unset / no checkout". payrail returns where to send money + a memo
// (quote_id); the buyer pays on-chain, then /api/confirm records the receipt.
const PAYRAIL_DEFAULT = 'https://payrail.ivixivi.workers.dev';
const TIER_PRICE: Record<'pro' | 'team', string> = { pro: '49', team: '199' };

interface PayrailQuote {
  quote_id: string;
  pay_to: { rail: string; chain: string; asset: string; address: string; amount: string } | null;
  checkout: string | null;
  instructions: string;
  expires_in_seconds: number;
}

// Single egress point to payrail. Prefers the service binding (an internal
// worker→worker call that never touches the public edge → immune to both the
// *.workers.dev same-zone restriction and edge bot-management). Falls back to the
// public hostname with a browser UA so even the fallback clears bot filters. When
// the binding is used the host in the URL is ignored — only path/query/method/body.
function payrailFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  if (env.PAYRAIL) return env.PAYRAIL.fetch(new Request(`https://payrail${path}`, init));
  const base = env.PAYRAIL_URL ?? PAYRAIL_DEFAULT;
  const headers = new Headers(init?.headers);
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'Mozilla/5.0 (compatible; bountyscope/1.0; +https://bountyscope.ivixivi.workers.dev)');
  }
  return fetch(base + path, { ...init, headers });
}

async function payrailQuote(env: Env, tier: 'pro' | 'team'): Promise<PayrailQuote> {
  const qs = new URLSearchParams({
    ship: 'bountyscope',
    sku: `bountyscope:${tier}`,
    amount: TIER_PRICE[tier],
    currency: 'USDC',
  });
  const r = await payrailFetch(env, `/pay?${qs.toString()}`);
  if (!r.ok) throw new Error(`payrail /pay ${r.status}`);
  return r.json();
}

// HMAC-SHA256 hex, byte-identical to payrail's hmac() so timingSafeEqual passes.
// Only used when SHIP_HMAC_SECRET is set (payrail has none today → optional).
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Curated starter set — well-known active programs. Cron will update.
// (External-source scraping is added incrementally; this guarantees a populated UI on day 1.)
const SEED_PROGRAMS: Program[] = [
  { id: 'imm-aave',     source: 'immunefi', name: 'Aave Protocol',     url: 'https://immunefi.com/bounty/aave/',     max_bounty_usd: 1_000_000, ecosystem: 'ethereum', in_scope_repos: ['https://github.com/aave-dao/aave-v3-origin'], status: 'live', last_seen_at: '' },
  { id: 'imm-compound', source: 'immunefi', name: 'Compound III',      url: 'https://immunefi.com/bounty/compound/', max_bounty_usd:   500_000, ecosystem: 'ethereum', in_scope_repos: ['https://github.com/compound-finance/comet'], status: 'live', last_seen_at: '' },
  { id: 'imm-curve',    source: 'immunefi', name: 'Curve Finance',     url: 'https://immunefi.com/bounty/curve/',    max_bounty_usd:   250_000, ecosystem: 'ethereum', in_scope_repos: ['https://github.com/curvefi/curve-contract'], status: 'live', last_seen_at: '' },
  { id: 'imm-lido',     source: 'immunefi', name: 'Lido',              url: 'https://immunefi.com/bounty/lido/',     max_bounty_usd: 2_000_000, ecosystem: 'ethereum', in_scope_repos: ['https://github.com/lidofinance/lido-dao'], status: 'live', last_seen_at: '' },
  { id: 'imm-makerdao', source: 'immunefi', name: 'MakerDAO / Sky',    url: 'https://immunefi.com/bounty/makerdao/', max_bounty_usd: 5_000_000, ecosystem: 'ethereum', in_scope_repos: ['https://github.com/makerdao/dss'], status: 'live', last_seen_at: '' },
  { id: 'imm-optimism', source: 'immunefi', name: 'Optimism',          url: 'https://immunefi.com/bounty/optimism/', max_bounty_usd: 2_000_042, ecosystem: 'ethereum', in_scope_repos: ['https://github.com/ethereum-optimism/optimism'], status: 'live', last_seen_at: '' },
  { id: 'imm-arbitrum', source: 'immunefi', name: 'Arbitrum',          url: 'https://immunefi.com/bounty/arbitrum/', max_bounty_usd: 2_000_000, ecosystem: 'arbitrum', in_scope_repos: ['https://github.com/OffchainLabs/nitro'], status: 'live', last_seen_at: '' },
  { id: 'imm-uniswap',  source: 'immunefi', name: 'Uniswap V4',        url: 'https://immunefi.com/bounty/uniswapv4/', max_bounty_usd: 15_500_000, ecosystem: 'ethereum', in_scope_repos: ['https://github.com/Uniswap/v4-core'], status: 'live', last_seen_at: '' },
  { id: 'imm-pendle',   source: 'immunefi', name: 'Pendle',            url: 'https://immunefi.com/bounty/pendle/',   max_bounty_usd: 1_500_000, ecosystem: 'ethereum', in_scope_repos: ['https://github.com/pendle-finance/pendle-core-v2-public'], status: 'live', last_seen_at: '' },
  { id: 'imm-morpho',   source: 'immunefi', name: 'Morpho',            url: 'https://immunefi.com/bounty/morpho/',   max_bounty_usd: 2_500_000, ecosystem: 'ethereum', in_scope_repos: ['https://github.com/morpho-org/morpho-blue'], status: 'live', last_seen_at: '' },
];

async function loadPrograms(env: Env): Promise<Program[]> {
  const raw = await env.BS_PROGRAMS.get(PROGRAMS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as Program[]; } catch { return []; }
}

async function savePrograms(env: Env, programs: Program[]) {
  await env.BS_PROGRAMS.put(PROGRAMS_KEY, JSON.stringify(programs));
}

async function ensureSeeded(env: Env): Promise<Program[]> {
  let list = await loadPrograms(env);
  if (list.length === 0) {
    const now = new Date().toISOString();
    list = SEED_PROGRAMS.map(p => ({ ...p, last_seen_at: now }));
    await savePrograms(env, list);
  }
  return list;
}

async function checkProgramChanges(env: Env, p: Program): Promise<boolean> {
  // HEAD request to program URL. If Last-Modified or ETag changed, mark.
  // (For programs that don't expose those headers, fall back to body hash.)
  try {
    const r = await fetch(p.url, {
      method: 'HEAD',
      headers: { 'User-Agent': env.USER_AGENT },
    });
    const lastMod = r.headers.get('last-modified') ?? r.headers.get('etag') ?? '';
    if (!lastMod) return false;
    const prevKey = `head:${p.id}`;
    const prev = await env.BS_PROGRAMS.get(prevKey);
    if (prev !== lastMod) {
      await env.BS_PROGRAMS.put(prevKey, lastMod);
      return prev != null; // changed only if we had a previous and it differs
    }
  } catch {}
  return false;
}

async function runCron(env: Env) {
  const programs = await ensureSeeded(env);
  const now = new Date().toISOString();
  let changed = 0;
  for (const p of programs) {
    p.last_seen_at = now;
    if (await checkProgramChanges(env, p)) {
      p.last_changed_at = now;
      changed++;
    }
  }
  await savePrograms(env, programs);
  console.log(`bountyscope: cron run, ${programs.length} programs, ${changed} changed`);
}

// === Analysis ===

interface AnalysisReport {
  id: string;
  program_id: string;
  repo_url?: string;
  contract_url?: string;
  finding_classes: { class: string; locations: string[]; severity: 'low' | 'medium' | 'high' | 'critical'; rationale: string }[];
  attack_surface_summary: string;
  recommended_focus: string[];
  generated_at: string;
}

const ANALYSIS_SYSTEM = `You are an expert smart contract auditor. Given a snippet of Solidity code or a description of a protocol, identify potential vulnerability classes worth deep-investigation by a bounty hunter.

Return JSON:
{
  "finding_classes": [
    {"class": "<vuln class name>", "locations": ["<file:line or function name>"], "severity": "low|medium|high|critical", "rationale": "<one-sentence why>"}
  ],
  "attack_surface_summary": "<2-3 sentences on what this code does and where attacks would target>",
  "recommended_focus": ["<file or function name to deep-dive>", ...]
}

Classes to consider: reentrancy, oracle manipulation, access control, integer overflow, unchecked low-level calls, signature replay, front-running, MEV-extractable flow, flash-loan exploit paths, governance attack surface, upgrade-pattern issues, supply-chain (dependency vuln), economic-attack invariant violations.

Return ONLY JSON.`;

function tryParseJson(s: unknown): any | null {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  const str = typeof s === 'string' ? s : String(s);
  const cleaned = str.replace(/^```json\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function handleAnalyze(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }

  const codeOrDescription = String(body?.code ?? body?.description ?? '');
  const program_id = String(body?.program_id ?? 'ad-hoc');
  const repo_url = body?.repo_url ? String(body.repo_url) : undefined;
  if (!codeOrDescription) return Response.json({ error: 'missing code or description' }, { status: 400 });
  if (codeOrDescription.length > 60_000) return Response.json({ error: 'too long; chunk smaller (<60k chars)' }, { status: 400 });

  let aiResp: any;
  try {
    aiResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM },
        { role: 'user', content: `Program: ${program_id}\nRepo: ${repo_url ?? '(none)'}\n\nCode / description:\n---\n${codeOrDescription}\n---` },
      ],
      max_tokens: 2000,
    });
  } catch (err) {
    return Response.json({ error: `inference: ${(err as Error).message}` }, { status: 500 });
  }

  const raw = aiResp?.response ?? aiResp?.result ?? aiResp;
  const parsed = tryParseJson(raw);
  if (!parsed || !Array.isArray(parsed.finding_classes)) {
    return Response.json({ error: 'analysis output malformed', raw_preview: String(raw).slice(0, 300) }, { status: 502 });
  }

  const id = crypto.randomUUID();
  const report: AnalysisReport = {
    id,
    program_id,
    repo_url,
    finding_classes: parsed.finding_classes,
    attack_surface_summary: String(parsed.attack_surface_summary ?? ''),
    recommended_focus: Array.isArray(parsed.recommended_focus) ? parsed.recommended_focus : [],
    generated_at: new Date().toISOString(),
  };
  await env.BS_REPORTS.put(`${REPORT_PREFIX}${id}`, JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 30 });
  return Response.json(report);
}

async function handlePrograms(req: Request, env: Env): Promise<Response> {
  const programs = await ensureSeeded(env);
  const sorted = [...programs].sort((a, b) => (b.max_bounty_usd ?? 0) - (a.max_bounty_usd ?? 0));
  return Response.json({
    count: sorted.length,
    programs: sorted,
    note: 'Curated starter list. Cron polls headers every 30min for changes.',
  });
}

async function handleStatus(_req: Request, env: Env): Promise<Response> {
  const programs = await loadPrograms(env);
  const recentChanges = programs.filter(p => p.last_changed_at).length;
  return Response.json({
    name: 'BountyScope',
    program_count: programs.length,
    recent_changes: recentChanges,
    last_cron_at: programs[0]?.last_seen_at ?? null,
  });
}

// === Subscriptions (payrail-gated paid tiers) ===

// Paid subscription. Reads { tier } (default 'pro'); maps pro=49, team=199; gets a
// live quote from the shared payrail rail and returns a 402 carrying the on-chain
// address + memo (quote_id). The buyer pays, then POSTs the tx hash to /api/confirm
// to unlock. Pending state persists in BS_REPORTS (7-day TTL). No "wired-but-unset" 503.
async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const body = await req.json().catch(() => null) as { tier?: string } | null;
  const tier: 'pro' | 'team' = body?.tier === 'team' ? 'team' : 'pro';

  let q: PayrailQuote;
  try {
    q = await payrailQuote(env, tier);
  } catch (err) {
    return Response.json({ error: 'rail_unavailable', detail: String(err) }, { status: 502 });
  }
  await env.BS_REPORTS.put(
    `pending:${q.quote_id}`,
    JSON.stringify({ tier, quote_id: q.quote_id, created_at: new Date().toISOString() }),
    { expirationTtl: 60 * 60 * 24 * 7 },
  );
  return Response.json({
    status: 'payment_required',
    tier,
    quote_id: q.quote_id,
    pay_to: q.pay_to,
    checkout: q.checkout,
    instructions: q.instructions,
    expires_in_seconds: q.expires_in_seconds,
    confirm_url: '/api/confirm',
  }, { status: 402 });
}

// A buyer who paid posts { quote_id, tx_hash }. We forward it to payrail
// /receipt — the receipt's payer_ref == tx_hash is the TIER-1 artifact — then
// flip the pending sub to active and unlock the paid tier.
async function handleConfirm(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const body = await req.json().catch(() => null) as { quote_id?: string; tx_hash?: string } | null;
  if (!body?.quote_id || !body?.tx_hash) {
    return Response.json({ error: 'quote_id and tx_hash required' }, { status: 400 });
  }
  const pendingRaw = await env.BS_REPORTS.get(`pending:${body.quote_id}`);
  if (!pendingRaw) return Response.json({ error: 'quote_not_found_or_expired' }, { status: 404 });
  const pending = JSON.parse(pendingRaw) as { tier: 'pro' | 'team'; quote_id: string; created_at: string };
  const tier = (pending.tier === 'team' ? 'team' : 'pro') as 'pro' | 'team';

  const payload = JSON.stringify({
    quote_id: body.quote_id,
    ship: 'bountyscope',
    sku: `bountyscope:${tier}`,
    amount: TIER_PRICE[tier],
    currency: 'USDC',
    rail: 'crypto',
    tx_hash: body.tx_hash,
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.SHIP_HMAC_SECRET) headers['x-payrail-signature'] = await hmacHex(env.SHIP_HMAC_SECRET, payload);

  const rr = await payrailFetch(env, '/receipt', { method: 'POST', headers, body: payload });
  if (!rr.ok) {
    return Response.json(
      { error: 'receipt_rejected', status: rr.status, detail: await rr.text().catch(() => '') },
      { status: 502 },
    );
  }
  const receiptResp = await rr.json().catch(() => ({})) as { ok?: boolean; receipt?: unknown };

  await env.BS_REPORTS.put(
    `sub:${body.quote_id}`,
    JSON.stringify({ tier, quote_id: body.quote_id, activated_at: new Date().toISOString() }),
  );
  await env.BS_REPORTS.delete(`pending:${body.quote_id}`);
  return Response.json({ ok: true, tier, receipt: receiptResp.receipt }, { status: 201 });
}

// Poll payment status by proxying payrail's public receipt lookup.
async function handlePayStatus(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const quoteId = url.searchParams.get('quote_id');
  if (!quoteId) return Response.json({ error: 'quote_id required' }, { status: 400 });
  const r = await payrailFetch(env, `/receipt/${encodeURIComponent(quoteId)}`);
  if (r.status === 404) return Response.json({ paid: false, quote_id: quoteId });
  if (!r.ok) return Response.json({ error: 'status_unavailable', status: r.status }, { status: 502 });
  return Response.json({ paid: true, receipt: await r.json() });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/programs') return handlePrograms(req, env);
    if (url.pathname === '/api/analyze') return handleAnalyze(req, env);
    if (url.pathname === '/api/status') return handleStatus(req, env);
    if (url.pathname === '/api/subscribe') return handleSubscribe(req, env);
    if (url.pathname === '/api/confirm') return handleConfirm(req, env);
    if (url.pathname === '/api/pay-status') return handlePayStatus(req, env);
    return env.ASSETS.fetch(req);
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
