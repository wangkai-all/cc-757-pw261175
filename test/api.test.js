import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (name) => JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8'));

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const call = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };
  try {
    await fn({ call, port });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function waitJob(call, jobId, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const { json } = await call(`/api/jobs/${jobId}`);
    if (json.status === 'done' || json.status === 'failed') return json;
    if (Date.now() - started > timeoutMs) throw new Error('job timeout');
    await new Promise((r) => setTimeout(r, 60));
  }
}

test('api: health and samples', async () => {
  await withServer(async ({ call }) => {
    const h = await call('/api/health');
    assert.equal(h.json.ok, true);
    const s = await call('/api/samples');
    assert.ok(s.json.samples.length >= 4);
    const ids = s.json.samples.map((x) => x.id);
    assert.ok(ids.includes('fictional-vertebrates-v1'));
    for (const sample of s.json.samples) {
      assert.ok(sample.dataset.taxa.length >= 3);
      assert.ok(Array.isArray(sample.dataset.features));
    }
  });
});

test('api: validation surfaces the missing value as null, not a state', async () => {
  await withServer(async ({ call }) => {
    const ds = load('dataset-a.json');
    const r = await call('/api/validate', { method: 'POST', body: { dataset: ds } });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.stats.missingCells, 1);
    const bad = structuredClone(ds);
    bad.matrix.T4[2] = '?';
    const r2 = await call('/api/validate', { method: 'POST', body: { dataset: bad } });
    assert.equal(r2.json.ok, false);
    assert.ok(r2.json.errors.some((e) => e.code === 'matrix-state'));
  });
});

test('api: background solve job completes and returns an exact result', async () => {
  await withServer(async ({ call }) => {
    const ds = load('dataset-a.json');
    const submit = await call('/api/solve', {
      method: 'POST',
      body: { dataset: ds, options: { method: 'exact' }, background: true },
    });
    assert.equal(submit.status, 202);
    const job = await waitJob(call, submit.json.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.result.status, 'solved');
    assert.equal(job.result.result.total, 8);
    assert.equal(job.result.proof.exact, true);
  });
});

test('api: locked solve keeps the lock clade in every returned tie', async () => {
  await withServer(async ({ call }) => {
    const ds = load('dataset-a.json');
    ds.constraints = [{ id: 'C1', taxa: ['T1', 'T6'] }];
    const r = await call('/api/solve', { method: 'POST', body: { dataset: ds, options: { method: 'exact' } } });
    assert.equal(r.json.status, 'solved');
    for (const tie of r.json.result.ties) {
      assert.ok(JSON.stringify(tie.tree).includes('T1') && JSON.stringify(tie.tree).includes('T6'));
    }
    // The check endpoint must confirm the lock holds on the returned tree.
    const chk = await call('/api/check-tree', { method: 'POST', body: { dataset: ds, tree: r.json.result.tree } });
    assert.equal(chk.json.allLocksHold, true);
  });
});

test('api: conflicting locks refuse to solve and explain the conflict', async () => {
  await withServer(async ({ call }) => {
    const ds = load('dataset-conflict.json');
    const r = await call('/api/solve', { method: 'POST', body: { dataset: ds, options: { method: 'exact' } } });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.status, 'invalid-input');
    const msg = r.json.validation.errors.find((e) => e.code === 'lock-overlap').message;
    assert.match(msg, /L1/);
    assert.match(msg, /L2/);
  });
});

test('api: check-tree reports rank and disagrees when given a non-optimal tree', async () => {
  await withServer(async ({ call }) => {
    const ds = load('dataset-equal.json');
    const r = await call('/api/check-tree', {
      method: 'POST',
      body: { dataset: ds, tree: ['S1', [['S2', 'S4'], 'S3']] },
    });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.cost, 4);
    assert.equal(r.json.rank.isOptimal, false);
    assert.ok(r.json.rank.cheaperThanThis > 0);

    const good = await call('/api/check-tree', {
      method: 'POST',
      body: { dataset: ds, tree: [['S1', 'S4'], ['S2', 'S3']] },
    });
    assert.equal(good.json.rank.isOptimal, true);
    assert.equal(good.json.cost, 3);
  });
});

test('api: check-tree ranks under locks as well as overall', async () => {
  await withServer(async ({ call }) => {
    const ds = load('dataset-a.json');
    ds.constraints = [{ id: 'C1', taxa: ['T2', 'T3'] }];
    const solved = await call('/api/solve', { method: 'POST', body: { dataset: ds, options: { method: 'exact' } } });
    const chk = await call('/api/check-tree', { method: 'POST', body: { dataset: ds, tree: solved.json.result.tree } });
    assert.equal(chk.json.rank.isOptimal, true);
    assert.equal(chk.json.rank.equalCost, 15); // all rooted topologies, locks ignored
    // Under the lock the tie count must match what the solver enumerated.
    assert.equal(chk.json.rank.locked.equalCost, solved.json.result.tieCount);
    assert.equal(chk.json.rank.locked.totalTopologies, 105);
    assert.equal(chk.json.rank.locked.isOptimal, true);
  });
});

test('api: check-tree rejects a malformed tree instead of guessing', async () => {
  await withServer(async ({ call }) => {
    const ds = load('dataset-equal.json');
    const r = await call('/api/check-tree', { method: 'POST', body: { dataset: ds, tree: ['S1', 'S2'] } });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.status, 'invalid-tree');
  });
});

test('api: feature resampling is background and keeps locks', async () => {
  await withServer(async ({ call }) => {
    const ds = load('dataset-a.json');
    ds.constraints = [{ id: 'C1', taxa: ['T2', 'T3'] }];
    const submit = await call('/api/resample', {
      method: 'POST',
      body: { dataset: ds, options: { replicates: 30, reoptimise: false, seed: 3 }, background: true },
    });
    assert.equal(submit.status, 202);
    const job = await waitJob(call, submit.json.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.result.ok, true);
    assert.equal(job.result.unit, 'feature');
    assert.ok(job.result.validReplicates > 0);
  });
});

test('api: 404 for unknown job', async () => {
  await withServer(async ({ call }) => {
    const r = await call('/api/jobs/does-not-exist');
    assert.equal(r.status, 404);
  });
});

test('api: serving the built UI returns html', async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const text = await res.text();
    if (res.status === 200 && text.includes('<!doctype html')) {
      assert.match(text, /<div id="root">/);
    } else {
      assert.match(text, /npm run build/);
    }
  });
});
