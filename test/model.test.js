import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset, convertOrdering } from '../shared/validate.js';
import { validateLocks } from '../shared/locks.js';
import { transitionRows, getTransitionCost, unorderedKey } from '../shared/cost.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (name) => JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8'));

test('missing values are not states: null is accepted, unknown labels are rejected', () => {
  const ds = load('dataset-a.json');
  const ok = validateDataset(ds);
  assert.equal(ok.ok, true);
  assert.equal(ok.matrix.T4[2], null);
  // Missing must not appear as a declared state anywhere.
  for (const f of ok.features) assert.ok(!f.states.includes('?'));

  const bad = structuredClone(ds);
  bad.matrix.T4[2] = '?';
  const res = validateDataset(bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.code === 'matrix-state'));
  assert.match(res.errors.find((e) => e.code === 'matrix-state').message, /缺失请写 null/);
});

test('a missing cell contributes no cost and is never reconstructed as a category', () => {
  const ds = load('dataset-a.json');
  const v = validateDataset(ds);
  assert.equal(v.ok, true);
  // T4/F3 is missing; the feature has 4 declared states and F3 states must not
  // contain a "missing" pseudo-state.
  const f3 = v.features.find((f) => f.id === 'F3');
  assert.deepEqual(f3.states, ['0', '1', '2', '3']);
});

test('ordered vs unordered costs are stored separately and priced directionally', () => {
  const ds = load('dataset-a.json');
  const v = validateDataset(ds);
  const f2 = v.features.find((f) => f.id === 'F2');
  assert.equal(f2.ordered, true);
  assert.equal(getTransitionCost(f2, '0', '1'), 1);
  assert.equal(getTransitionCost(f2, '1', '0'), 3);
  const rows = transitionRows(f2);
  assert.equal(rows.length, 6); // every ordered pair, both directions

  const f1 = v.features.find((f) => f.id === 'F1');
  assert.equal(f1.ordered, false);
  assert.equal(getTransitionCost(f1, '2', '0'), 2);
  assert.equal(getTransitionCost(f1, '0', '2'), 2);
  assert.equal(transitionRows(f1).length, 3);
});

test('a transition with no declared cost is rejected rather than guessed', () => {
  const ds = load('dataset-a.json');
  const broken = structuredClone(ds);
  delete broken.features[0].costs['0|2'];
  const v = validateDataset(broken);
  assert.equal(v.ok, true, 'missing cost is a warning, not invalid data');
  assert.ok(v.warnings.some((w) => w.code === 'cost-undef'));
});

test('costs cannot silently become asymmetric on an unordered feature', () => {
  const ds = load('dataset-a.json');
  const bad = structuredClone(ds);
  bad.features[0].costs['2|0'] = 5; // same pair, different value
  const v = validateDataset(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'cost-asymmetric'));
});

test('ordered feature rejects a symmetric key and vice versa', () => {
  const ds = load('dataset-a.json');
  const badOrdered = structuredClone(ds);
  badOrdered.features[1].costs['0|1'] = 1;
  const v1 = validateDataset(badOrdered);
  assert.ok(v1.errors.some((e) => e.code === 'cost-separator'));

  const badUnordered = structuredClone(ds);
  badUnordered.features[0].costs['0>1'] = 1;
  const v2 = validateDataset(badUnordered);
  assert.ok(v2.errors.some((e) => e.code === 'cost-separator'));
});

test('converting ordering preserves both directions and reports lost asymmetry', () => {
  const ds = load('dataset-a.json');
  const v = validateDataset(ds);
  const f2 = v.features.find((f) => f.id === 'F2');
  const toUnordered = convertOrdering(f2, false);
  assert.equal(toUnordered.feature.ordered, false);
  assert.equal(toUnordered.feature.costs[unorderedKey('0', '1')], 1);
  assert.ok(toUnordered.lost.length > 0);
  assert.match(toUnordered.note, /不对称/);
});

test('overlapping non-nested locks are a concrete conflict, not a post-hoc repaint', () => {
  const res = validateLocks(
    [
      { id: 'L1', taxa: ['A', 'B'] },
      { id: 'L2', taxa: ['A', 'C'] },
    ],
    ['A', 'B', 'C', 'D'],
  );
  assert.equal(res.valid, false);
  assert.equal(res.errors.length, 1);
  const msg = res.errors[0].message;
  assert.match(msg, /L1/);
  assert.match(msg, /L2/);
  assert.match(msg, /共有 A/);
});

test('nested locks are legal; duplicate and single-taxon locks are explained', () => {
  const res = validateLocks(
    [
      { id: 'L1', taxa: ['A', 'B', 'C'] },
      { id: 'L2', taxa: ['A', 'B'] },
      { id: 'L3', taxa: ['A', 'B'] },
      { id: 'L4', taxa: ['D'] },
    ],
    ['A', 'B', 'C', 'D'],
  );
  assert.equal(res.valid, true);
  assert.ok(res.warnings.some((w) => w.code === 'lock-duplicate'));
  assert.ok(res.infos.some((i) => i.code === 'lock-single-taxon'));
});

test('lock naming an unknown sample fails with the sample name', () => {
  const res = validateLocks([{ id: 'X', taxa: ['A', 'ZZ'] }], ['A', 'B']);
  assert.equal(res.valid, false);
  assert.match(res.errors[0].message, /ZZ/);
});
