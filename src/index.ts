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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/programs') return handlePrograms(req, env);
    if (url.pathname === '/api/analyze') return handleAnalyze(req, env);
    if (url.pathname === '/api/status') return handleStatus(req, env);
    return env.ASSETS.fetch(req);
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
