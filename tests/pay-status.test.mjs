import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.ts';

const BASE_URL = 'https://bountyscope.test';

function makePayrail(overrides = {}) {
  const calls = [];
  return {
    calls,
    binding: {
      async fetch(req) {
        const url = new URL(req.url);
        calls.push({ method: req.method, url: url.pathname });

        if (overrides.fetch) {
          return overrides.fetch(req, url);
        }

        if (url.pathname === '/receipt/quote_123') {
          return Response.json({ ok: true, quote_id: 'quote_123' });
        }

        if (url.pathname === '/receipt/quote_not_found') {
          return new Response('not found', { status: 404 });
        }
        
        if (url.pathname === '/receipt/quote_error') {
          return new Response('server error', { status: 500 });
        }

        return new Response('not found', { status: 404 });
      },
    },
  };
}

function makeEnv(overrides = {}) {
  const payrail = makePayrail(overrides.payrail);

  const env = {
    PAYRAIL: payrail.binding,
    ...overrides.env,
  };

  return { env, payrailCalls: payrail.calls };
}

async function fetchWorker(env, path, init) {
  return worker.fetch(new Request(`${BASE_URL}${path}`, init), env);
}

async function fetchJson(env, path, init) {
  const response = await fetchWorker(env, path, init);
  return { response, body: await response.json() };
}

test('GET /api/pay-status requires quote_id', async () => {
  const { env } = makeEnv();
  const { response, body } = await fetchJson(env, '/api/pay-status');
  assert.equal(response.status, 400);
  assert.equal(body.error, 'quote_id required');
});

test('GET /api/pay-status returns paid:false for 404', async () => {
  const { env } = makeEnv();
  const { response, body } = await fetchJson(env, '/api/pay-status?quote_id=quote_not_found');
  assert.equal(response.status, 200);
  assert.equal(body.paid, false);
  assert.equal(body.quote_id, 'quote_not_found');
});

test('GET /api/pay-status returns 502 for upstream error', async () => {
  const { env } = makeEnv();
  const { response, body } = await fetchJson(env, '/api/pay-status?quote_id=quote_error');
  assert.equal(response.status, 502);
  assert.equal(body.error, 'status_unavailable');
  assert.equal(body.status, 500);
});

test('GET /api/pay-status returns paid:true and receipt for 200', async () => {
  const { env } = makeEnv();
  const { response, body } = await fetchJson(env, '/api/pay-status?quote_id=quote_123');
  assert.equal(response.status, 200);
  assert.equal(body.paid, true);
  assert.deepEqual(body.receipt, { ok: true, quote_id: 'quote_123' });
});

test('payrailFetch fallback works when PAYRAIL binding is absent', async () => {
  // Mock global fetch to test fallback in payrailFetch
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, headers: new Headers(init?.headers) });
    if (input.endsWith('/receipt/quote_fallback')) {
      return new Response(JSON.stringify({ ok: true, fallback: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const env = {}; // No PAYRAIL binding
    const { response, body } = await fetchJson(env, '/api/pay-status?quote_id=quote_fallback');
    assert.equal(response.status, 200);
    assert.equal(body.paid, true);
    assert.equal(body.receipt.fallback, true);
    
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].headers.has('user-agent'));
    assert.match(fetchCalls[0].headers.get('user-agent'), /bountyscope\/1\.0/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
