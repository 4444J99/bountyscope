import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.ts';

const BASE_URL = 'https://bountyscope.test';
const PROGRAMS_KEY = 'programs:list';
const CHANGES_KEY = 'changes:log';

class MemoryKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
    this.puts = [];
    this.deletes = [];
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async put(key, value, options) {
    const stringValue = String(value);
    this.store.set(key, stringValue);
    this.puts.push({ key, value: stringValue, options });
  }

  async delete(key) {
    this.store.delete(key);
    this.deletes.push(key);
  }

  async list(options = {}) {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const start = options.cursor ? Number(options.cursor) : 0;
    const matches = [...this.store.keys()]
      .filter(key => key.startsWith(prefix))
      .sort();
    const page = matches.slice(start, start + limit);
    const next = start + page.length;

    return {
      keys: page.map(name => ({ name })),
      list_complete: next >= matches.length,
      cursor: next >= matches.length ? undefined : String(next),
    };
  }

  json(key) {
    const value = this.store.get(key);
    return value == null ? null : JSON.parse(value);
  }

  keys(prefix = '') {
    return [...this.store.keys()].filter(key => key.startsWith(prefix));
  }
}

function analysisPayload() {
  return {
    finding_classes: [
      {
        class: 'reentrancy',
        locations: ['withdraw'],
        severity: 'high',
        rationale: 'External call happens before state is reduced.',
      },
    ],
    attack_surface_summary: 'The vault exposes an externally callable withdraw flow.',
    recommended_focus: ['withdraw'],
  };
}

function makePayrail() {
  const calls = [];

  return {
    calls,
    binding: {
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.clone().text().catch(() => '');
        calls.push({ method: req.method, url, headers: new Headers(req.headers), body });

        if (url.pathname === '/pay') {
          return Response.json({
            quote_id: 'quote_123',
            pay_to: {
              rail: 'crypto',
              chain: 'base',
              asset: 'USDC',
              address: '0x0000000000000000000000000000000000000049',
              amount: url.searchParams.get('amount'),
            },
            checkout: null,
            instructions: 'Send exact USDC amount with the quote id as memo.',
            expires_in_seconds: 900,
          });
        }

        if (url.pathname === '/receipt' && req.method === 'POST') {
          return Response.json({ ok: true, receipt: { id: 'receipt_123', accepted: true } });
        }

        if (url.pathname === '/receipt/quote_123') {
          return Response.json({ ok: true, quote_id: 'quote_123' });
        }

        return new Response('not found', { status: 404 });
      },
    },
  };
}

function makeEnv(overrides = {}) {
  const aiCalls = [];
  const payrail = makePayrail();
  const assetRequests = [];

  const env = {
    AI: {
      async run(model, input) {
        aiCalls.push({ model, input });
        return { response: `\`\`\`json\n${JSON.stringify(analysisPayload())}\n\`\`\`` };
      },
    },
    ASSETS: {
      async fetch(req) {
        assetRequests.push(req);
        return new Response('asset response', { status: 200, headers: { 'x-asset': 'hit' } });
      },
    },
    BS_PROGRAMS: new MemoryKV(),
    BS_REPORTS: new MemoryKV(),
    USER_AGENT: 'BountyScope test bot',
    PAYRAIL: payrail.binding,
    ...overrides,
  };

  return { env, aiCalls, assetRequests, payrailCalls: payrail.calls };
}

async function fetchWorker(env, path, init) {
  return worker.fetch(new Request(`${BASE_URL}${path}`, init), env);
}

async function fetchJson(env, path, init) {
  const response = await fetchWorker(env, path, init);
  return { response, body: await response.json() };
}

function jsonRequest(body, init = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  };
}

function changeEvent(index, ageHours) {
  return {
    program_id: `program-${index}`,
    name: `Program ${index}`,
    url: `https://example.test/program-${index}`,
    source: 'immunefi',
    max_bounty_usd: 100_000 + index,
    in_scope_repos: [`https://github.com/example/program-${index}`],
    changed_at: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
  };
}

async function runScheduled(env) {
  const waits = [];
  await worker.scheduled({}, env, {
    waitUntil(promise) {
      waits.push(promise);
    },
  });
  await Promise.all(waits);
}

test('GET /api/programs seeds the registry and returns programs sorted by bounty', async () => {
  const { env } = makeEnv();

  const { response, body } = await fetchJson(env, '/api/programs');

  assert.equal(response.status, 200);
  assert.equal(body.count, 10);
  assert.equal(body.programs[0].id, 'imm-uniswap');
  assert.deepEqual(
    body.programs.map(program => program.max_bounty_usd),
    [...body.programs.map(program => program.max_bounty_usd)].sort((a, b) => b - a),
  );

  const stored = env.BS_PROGRAMS.json(PROGRAMS_KEY);
  assert.equal(stored.length, 10);
  assert.ok(stored.every(program => program.last_seen_at));

  const status = await fetchJson(env, '/api/status');
  assert.equal(status.body.name, 'BountyScope');
  assert.equal(status.body.program_count, 10);
  assert.equal(status.body.recent_changes, 0);
});

test('GET /api/changes applies the free delay/cap and unlocks real-time repo detail for paid keys', async () => {
  const { env } = makeEnv();
  const changes = [
    changeEvent(0, 1),
    ...Array.from({ length: 7 }, (_, index) => changeEvent(index + 1, 48 + index)),
  ];
  await env.BS_PROGRAMS.put(CHANGES_KEY, JSON.stringify(changes));
  await env.BS_REPORTS.put('key:pro-key', JSON.stringify({
    tier: 'pro',
    quote_id: 'quote-pro',
    issued_at: '2026-06-19T00:00:00.000Z',
  }));

  const free = await fetchJson(env, '/api/changes');

  assert.equal(free.response.status, 200);
  assert.equal(free.body.tier, 'free');
  assert.equal(free.body.real_time, false);
  assert.equal(free.body.count, 5);
  assert.equal(free.body.total_visible, 7);
  assert.equal(free.body.hidden_by_delay, 1);
  assert.equal(free.body.capped, true);
  assert.equal(free.body.changes[0].program_id, 'program-1');
  assert.equal(free.body.changes[0].in_scope_repos, undefined);

  const paid = await fetchJson(env, '/api/changes', { headers: { 'x-api-key': 'pro-key' } });

  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.tier, 'pro');
  assert.equal(paid.body.real_time, true);
  assert.equal(paid.body.count, 8);
  assert.equal(paid.body.changes[0].program_id, 'program-0');
  assert.deepEqual(paid.body.changes[0].in_scope_repos, ['https://github.com/example/program-0']);
  assert.equal(paid.body.hidden_by_delay, undefined);
});

test('GET /api/status returns dashboard coverage and usage metrics', async () => {
  const { env } = makeEnv();
  await env.BS_PROGRAMS.put(PROGRAMS_KEY, JSON.stringify([
    {
      id: 'program-a',
      source: 'immunefi',
      name: 'Program A',
      url: 'https://example.test/a',
      max_bounty_usd: 100_000,
      ecosystem: 'ethereum',
      in_scope_repos: ['https://github.com/example/a'],
      status: 'live',
      last_seen_at: '2026-06-20T10:00:00.000Z',
      last_changed_at: '2026-06-20T11:00:00.000Z',
    },
    {
      id: 'program-b',
      source: 'sherlock',
      name: 'Program B',
      url: 'https://example.test/b',
      max_bounty_usd: 250_000,
      ecosystem: 'solana',
      in_scope_repos: ['https://github.com/example/b'],
      status: 'paused',
      last_seen_at: '2026-06-20T10:30:00.000Z',
    },
  ]));
  await env.BS_PROGRAMS.put(CHANGES_KEY, JSON.stringify([changeEvent(1, 2), changeEvent(2, 200)]));
  await env.BS_REPORTS.put('report:a', '{}');
  await env.BS_REPORTS.put('report:b', '{}');
  await env.BS_REPORTS.put('sub:quote-pro', JSON.stringify({ tier: 'pro' }));
  await env.BS_REPORTS.put('sub:quote-team', JSON.stringify({ tier: 'team' }));
  await env.BS_REPORTS.put('key:pro-key', JSON.stringify({ tier: 'pro' }));
  await env.BS_REPORTS.put('pending:quote-pending', JSON.stringify({ tier: 'pro' }));
  const today = new Date().toISOString().slice(0, 10);
  await env.BS_REPORTS.put(`quota:${today}:ip:203.0.113.1`, '3');
  await env.BS_REPORTS.put(`quota:${today}:ip:203.0.113.2`, '2');

  const { response, body } = await fetchJson(env, '/api/status');

  assert.equal(response.status, 200);
  assert.equal(body.name, 'BountyScope');
  assert.equal(body.program_count, 2);
  assert.equal(body.recent_changes, 1);
  assert.equal(body.logged_changes, 2);
  assert.equal(body.last_cron_at, '2026-06-20T10:30:00.000Z');
  assert.equal(body.programs.live, 1);
  assert.equal(body.programs.paused, 1);
  assert.equal(body.programs.total_max_bounty_usd, 350_000);
  assert.equal(body.programs.top_program.id, 'program-b');
  assert.deepEqual(body.programs.sources, { immunefi: 1, sherlock: 1 });
  assert.deepEqual(body.programs.ecosystems, { ethereum: 1, solana: 1 });
  assert.equal(body.programs.in_scope_repo_count, 2);
  assert.equal(body.changes.total_logged, 2);
  assert.equal(body.changes.last_24h, 1);
  assert.equal(body.changes.last_7d, 1);
  assert.equal(body.usage.analyzer_reports_30d, 2);
  assert.equal(body.usage.free_analyzer_calls_today, 5);
  assert.equal(body.usage.active_subscriptions, 2);
  assert.deepEqual(body.usage.active_subscription_tiers, { free: 0, pro: 1, team: 1 });
  assert.equal(body.usage.api_keys_issued, 1);
  assert.deepEqual(body.usage.api_key_tiers, { free: 0, pro: 1, team: 0 });
  assert.equal(body.usage.pending_checkouts, 1);
});

test('POST /api/analyze validates input, persists reports, and enforces the free daily quota', async () => {
  const { env, aiCalls } = makeEnv();
  const request = {
    ...jsonRequest({
      code: 'contract Vault { function withdraw() external {} }',
      program_id: 'vault',
      repo_url: 'https://github.com/example/vault',
    }),
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.7',
    },
  };

  const invalid = await fetchJson(env, '/api/analyze', jsonRequest({}));
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, 'missing code or description');

  const first = await fetchJson(env, '/api/analyze', request);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.program_id, 'vault');
  assert.equal(first.body.repo_url, 'https://github.com/example/vault');
  assert.equal(first.body.finding_classes[0].class, 'reentrancy');
  assert.match(first.body.id, /^[0-9a-f-]{36}$/i);

  const reportKeys = env.BS_REPORTS.keys('report:');
  assert.equal(reportKeys.length, 1);
  assert.deepEqual(env.BS_REPORTS.json(reportKeys[0]).recommended_focus, ['withdraw']);
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.match(aiCalls[0].input.messages[1].content, /Program: vault/);

  for (let i = 0; i < 4; i += 1) {
    const next = await fetchJson(env, '/api/analyze', request);
    assert.equal(next.response.status, 200);
  }

  const overQuota = await fetchJson(env, '/api/analyze', request);
  assert.equal(overQuota.response.status, 402);
  assert.equal(overQuota.body.error, 'quota_exceeded');
  assert.equal(overQuota.body.used, 5);
  assert.equal(overQuota.body.limit, 5);
  assert.equal(aiCalls.length, 5);
});

test('paid analyzer calls are authenticated by API key and are not free-quota limited', async () => {
  const { env, aiCalls } = makeEnv();
  await env.BS_REPORTS.put('key:team-key', JSON.stringify({
    tier: 'team',
    quote_id: 'quote-team',
    issued_at: '2026-06-19T00:00:00.000Z',
  }));

  for (let i = 0; i < 6; i += 1) {
    const result = await fetchJson(env, '/api/analyze', jsonRequest(
      { description: `protocol note ${i}` },
      { headers: { authorization: 'Bearer team-key' } },
    ));
    assert.equal(result.response.status, 200);
    assert.equal(result.body.program_id, 'ad-hoc');
  }

  assert.equal(aiCalls.length, 6);
  assert.equal(env.BS_REPORTS.keys('quota:').length, 0);

  const whoami = await fetchJson(env, '/api/whoami', { headers: { authorization: 'Bearer team-key' } });
  assert.equal(whoami.body.tier, 'team');
  assert.equal(whoami.body.authenticated, true);
  assert.equal(whoami.body.analyze_limit, null);
  assert.equal(whoami.body.changes_real_time, true);
});

test('subscription checkout confirms through payrail, mints an API key, and is idempotent', async () => {
  const { env, payrailCalls } = makeEnv({ SHIP_HMAC_SECRET: 'secret' });

  const subscribe = await fetchJson(env, '/api/subscribe', jsonRequest({ tier: 'team' }));

  assert.equal(subscribe.response.status, 402);
  assert.equal(subscribe.body.status, 'payment_required');
  assert.equal(subscribe.body.tier, 'team');
  assert.equal(subscribe.body.quote_id, 'quote_123');
  assert.equal(subscribe.body.pay_to.amount, '199');
  assert.equal(payrailCalls[0].url.pathname, '/pay');
  assert.equal(payrailCalls[0].url.searchParams.get('sku'), 'bountyscope:team');
  assert.ok(env.BS_REPORTS.json('pending:quote_123'));

  const missingFields = await fetchJson(env, '/api/confirm', jsonRequest({ quote_id: 'quote_123' }));
  assert.equal(missingFields.response.status, 400);
  assert.equal(missingFields.body.error, 'quote_id and tx_hash required');

  const confirm = await fetchJson(env, '/api/confirm', jsonRequest({
    quote_id: 'quote_123',
    tx_hash: '0xabc123',
  }));

  assert.equal(confirm.response.status, 201);
  assert.equal(confirm.body.ok, true);
  assert.equal(confirm.body.tier, 'team');
  assert.match(confirm.body.api_key, /^bsk_[0-9a-f]{48}$/);
  assert.deepEqual(confirm.body.receipt, { id: 'receipt_123', accepted: true });
  assert.equal(env.BS_REPORTS.store.has('pending:quote_123'), false);

  const receiptCall = payrailCalls.find(call => call.url.pathname === '/receipt');
  assert.ok(receiptCall);
  assert.equal(receiptCall.method, 'POST');
  assert.ok(receiptCall.headers.get('x-payrail-signature'));
  assert.match(receiptCall.body, /"sku":"bountyscope:team"/);

  const whoami = await fetchJson(env, '/api/whoami', {
    headers: { authorization: `Bearer ${confirm.body.api_key}` },
  });
  assert.equal(whoami.body.tier, 'team');
  assert.equal(whoami.body.authenticated, true);
  assert.equal(whoami.body.key_present, true);

  const repeat = await fetchJson(env, '/api/confirm', jsonRequest({
    quote_id: 'quote_123',
    tx_hash: '0xabc123',
  }));
  assert.equal(repeat.response.status, 200);
  assert.equal(repeat.body.already_active, true);
  assert.equal(repeat.body.api_key, confirm.body.api_key);
});

test('scheduled cron seeds programs, stores HEAD fingerprints, and logs later changes', async () => {
  const { env } = makeEnv();
  const originalFetch = globalThis.fetch;
  const etags = new Map();
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init?.method, userAgent: init?.headers?.['User-Agent'] });
    return new Response(null, {
      status: 200,
      headers: { etag: etags.get(url) ?? '"v1"' },
    });
  };

  try {
    await runScheduled(env);

    assert.equal(env.BS_PROGRAMS.json(PROGRAMS_KEY).length, 10);
    assert.equal(env.BS_PROGRAMS.json(CHANGES_KEY), null);
    assert.equal(env.BS_PROGRAMS.store.get('head:imm-aave'), '"v1"');
    assert.equal(calls.length, 10);
    assert.ok(calls.every(call => call.method === 'HEAD'));
    assert.ok(calls.every(call => call.userAgent === 'BountyScope test bot'));

    etags.set('https://immunefi.com/bounty/aave/', '"v2"');
    await runScheduled(env);

    const log = env.BS_PROGRAMS.json(CHANGES_KEY);
    assert.equal(log.length, 1);
    assert.equal(log[0].program_id, 'imm-aave');
    assert.equal(log[0].name, 'Aave Protocol');
    assert.deepEqual(log[0].in_scope_repos, ['https://github.com/aave-dao/aave-v3-origin']);

    const aave = env.BS_PROGRAMS.json(PROGRAMS_KEY).find(program => program.id === 'imm-aave');
    assert.ok(aave.last_changed_at);
    assert.equal(env.BS_PROGRAMS.store.get('head:imm-aave'), '"v2"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unknown routes fall through to the static asset binding', async () => {
  const { env } = makeEnv();

  const response = await fetchWorker(env, '/');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-asset'), 'hit');
  assert.equal(await response.text(), 'asset response');
});

test('GET /dashboard serves the static dashboard asset', async () => {
  const { env, assetRequests } = makeEnv();

  const response = await fetchWorker(env, '/dashboard');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-asset'), 'hit');
  assert.equal(new URL(assetRequests[0].url).pathname, '/dashboard.html');
});
