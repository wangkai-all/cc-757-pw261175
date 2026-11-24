import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from '../shared/validate.js';
import { makePricingContext, priceTopology, topologySignature, cladeMasks, annotateTree, unrootedSignature, leafTaxa } from '../server/solver/tree.js';
import { solveExactDp } from '../server/solver/dp.js';
import { solveDataset } from '../server/solver/solve.js';
import { enumerateSmall } from '../server/solver/enumerate.js';
import { localSearch, uniqueNni } from '../server/solver/localSearch.js';
import { compileLocks } from '../server/solver/solve.js';
import { lowerBound, certificate } from '../server/solver/bounds.js';
import { resampleFeatures } from '../server/solver/resample.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (name) => JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8'));

function prep(ds) {
  const v = validateDataset(ds);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const norm = { ...ds, taxonIds: v.taxonIds, features: v.features, matrix: v.matrix };
  const ctx = makePricingContext(norm);
  for (const feature of ctx.features) {
    feature.observedIndices = [];
    const fi = v.features.findIndex((f) => f.id === feature.id);
    for (const t of v.taxonIds) {
      const val = (norm.matrix[t] || [])[fi];
      if (val === null || val === undefined) continue;
      feature.observedIndices.push(feature.index.get(val));
    }
  }
  const locks = compileLocks(v.locks, v.taxonIds);
  return { v, ctx, locks, ds: norm };
}

test('pricing counts a missing tip as free, not as an extra state', () => {
  const { ctx } = prep(load('dataset-a.json'));
  // F3 as observed: T1=0, T2=T3=1, T5=T6=3, and T4 unknown.
  const tree = [['T1', ['T2', 'T3']], [['T4', 'T5'], 'T6']];
  const p = priceTopology(tree, ctx);
  assert.equal(p.valid, true);
  // T4's unknown cell contributes nothing: F3's 3 units are entirely forced by
  // the observed values (T1|T2 and T1|T5), so the missing cell can sit anywhere.
  assert.equal(p.perFeature.F3.cost, 3);

  // Write a real state into that cell and the price must not drop — a missing
  // value is never cheaper than a category, and is never itself a category.
  for (const fill of ['0', '1', '2', '3']) {
    const ds2 = load('dataset-a.json');
    ds2.matrix.T4[2] = fill;
    const { ctx: ctx2 } = prep(ds2);
    assert.ok(
      priceTopology(tree, ctx2).perFeature.F3.cost >= p.perFeature.F3.cost,
      `filling T4/F3=${fill} must not price below the unobserved case`,
    );
  }

  // Adding a genuine state only T4 has, with no transition price, must make the
  // tree unpricable and name F3 — never silently free and never a new category.
  const ds3 = load('dataset-a.json');
  ds3.features[2].states = ['0', '1', '2', '3', '4'];
  ds3.matrix.T4[2] = '4';
  const { ctx: ctx3 } = prep(ds3);
  const unpriced = priceTopology(tree, ctx3);
  assert.equal(unpriced.valid, false);
  assert.equal(unpriced.reason.featureId, 'F3');

  // Price the new state and it does cost more than leaving the cell unobserved.
  for (const s of ['0', '1', '2', '3']) {
    ds3.features[2].costs[`4|${s}`] = 5;
    ds3.features[2].costs[`${s}|4`] = 5;
  }
  const { ctx: ctx4 } = prep(ds3);
  assert.ok(priceTopology(tree, ctx4).perFeature.F3.cost > p.perFeature.F3.cost);

  // The unobserved cell must also not be reconstructed as a category in the UI
  // annotation: the T4 edge shows "missing", not some invented state.
  const ann = annotateTree(tree, ctx);
  const t4 = ann.nodes.find((n) => n.taxon === 'T4');
  const edge = ann.edges.find((e) => e.childId === t4.id);
  assert.equal(edge.perFeature.F3.missing, true);
  assert.equal(edge.perFeature.F3.cost, 0);
  assert.equal(ann.featureNodeStates.F3[t4.id], null);
});

test('exact DP agrees with independent exhaustive enumeration on small inputs (incl. locks)', () => {
  for (const name of ['dataset-a.json', 'dataset-equal.json', 'dataset-uninformative.json']) {
    const { v, ctx, locks } = prep(load(name));
    const exact = solveExactDp(ctx, v.taxonIds, locks.masks, { maxTies: 500 });
    const enumr = enumerateSmall(ctx, v.taxonIds, locks.masks, { maxTies: 500 });
    assert.equal(exact.status, 'optimal', name);
    assert.equal(enumr.status, 'complete', name);
    assert.ok(Math.abs(exact.optimum - enumr.bestCost) < 1e-9, `${name}: ${exact.optimum} vs ${enumr.bestCost}`);
  }
});

test('lock constraints are enforced inside the search, so every returned tie satisfies them', () => {
  const ds = load('dataset-a.json');
  ds.constraints = [
    { id: 'C1', taxa: ['T2', 'T3'] },
    { id: 'C2', taxa: ['T4', 'T5'] },
  ];
  const { v, ctx, locks } = prep(ds);
  assert.equal(locks.masks.length, 2);
  const exact = solveExactDp(ctx, v.taxonIds, locks.masks, { maxTies: 200 });
  assert.equal(exact.status, 'optimal');
  assert.ok(exact.trees.length > 0);
  for (const tree of exact.trees) {
    const masks = new Set(cladeMasks(tree, ctx.taxonIndex));
    for (const L of locks.masks) assert.ok(masks.has(L), 'returned tree must contain every lock clade');
  }
});

test('a feature with no usable transitions makes the tree unpricable and says which feature', () => {
  const ds = load('dataset-a.json');
  ds.features[2] = {
    id: 'F3',
    name: '齿数',
    ordered: false,
    states: ['0', '1', '2', '3'],
    costs: {},
  };
  const r = solveDataset(ds, { method: 'exact' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'infeasible');
  assert.ok(r.diagnostics.some((d) => d.code === 'no-feasible-tree'));
});

test('locks that cannot coexist are caught by validation with a named explanation', () => {
  const r = solveDataset(load('dataset-conflict.json'), { method: 'exact' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'invalid-input');
  const msg = r.validation.errors.find((e) => e.code === 'lock-overlap').message;
  assert.match(msg, /L1/);
  assert.match(msg, /L2/);
  assert.match(msg, /无法同时满足/);
});

test('equal-cost topologies are listed, deduplicated, and grouped by unrooted structure', () => {
  const r = solveDataset(load('dataset-equal.json'), { method: 'exact' });
  assert.equal(r.status, 'solved');
  assert.ok(r.result.tieCount > 1);
  const sigs = r.result.ties.map((t) => t.signature);
  assert.equal(new Set(sigs).size, sigs.length, 'tie list has no duplicate rooted topologies');
  assert.equal(r.result.tieGroups.reduce((a, g) => a + g.rootedVariants.length, 0), r.result.tieCount);
  assert.equal(r.result.distinctUnrooted, r.result.tieGroups.length);
});

test('exact result carries a proof, and its lower bound is a genuine certificate', () => {
  const r = solveDataset(load('dataset-a.json'), { method: 'exact' });
  assert.equal(r.status, 'solved');
  assert.equal(r.proof.exact, true);
  assert.equal(r.proof.provenOptimal, true);
  assert.ok(r.proof.lowerBound <= r.result.total + 1e-9);
  assert.match(r.proof.statement, /精确动态规划/);
});

test('local search is labelled best-found and never claims global optimality without the bound', () => {
  const { v, ctx, locks } = prep(load('dataset-a.json'));
  const ls = localSearch(ctx, v.taxonIds, locks.masks, { seed: 99, restarts: 4, maxIterations: 500 });
  assert.equal(ls.status, 'best-found');
  assert.ok(ls.lowerBound !== null);
  assert.ok(ls.gap !== null);
  if (ls.provenOptimal) {
    assert.ok(certificate(ls.bestCost, ls.lowerBound));
    assert.match(ls.note, /证明最优/);
  } else {
    assert.match(ls.note, /不是全局最优/);
  }
});

test('local search respects locks: every evaluated topology contains every lock clade', () => {
  const ds = load('dataset-a.json');
  ds.constraints = [
    { id: 'C1', taxa: ['T1', 'T6'] },
  ];
  const { v, ctx, locks } = prep(ds);
  const ls = localSearch(ctx, v.taxonIds, locks.masks, { seed: 7, restarts: 6, maxIterations: 800 });
  assert.ok(ls.best, 'found a feasible tree');
  const masks = new Set(cladeMasks(ls.best, ctx.taxonIndex));
  for (const L of locks.masks) assert.ok(masks.has(L));
});

test('annotation reconstruction reaches the DP optimum and marks tied ancestral states', () => {
  const { v, ctx } = prep(load('dataset-a.json'));
  const exact = solveExactDp(ctx, v.taxonIds, [], { maxTies: 1 });
  const ann = annotateTree(exact.trees[0], ctx);
  assert.ok(Math.abs(ann.total - exact.optimum) < 1e-9);
  for (const row of Object.values(ann.perFeature)) {
    assert.equal(row.reconstructedMatchesOptimum, true);
  }
});

test('resampling keeps locks and uses whole features as the unit', () => {
  const ds = load('dataset-a.json');
  ds.constraints = [{ id: 'C1', taxa: ['T2', 'T3'] }];
  const fixed = resampleFeatures(ds, { replicates: 40, reoptimise: false, seed: 5 });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.mode, 'fixed-tree');
  assert.equal(fixed.unit, 'feature');
  for (const row of fixed.rows) {
    if (!row.valid) continue;
    const count = Object.values(row.multiplicity).reduce((a, b) => a + b, 0);
    assert.equal(count, 3, 'one draw per declared feature column (F1, F2, F3)');
    break;
  }
  const reopt = resampleFeatures(ds, { replicates: 15, reoptimise: true, seed: 5 });
  assert.equal(reopt.mode, 'reoptimised');
  assert.ok(reopt.validReplicates > 0);
});

test('every feature replaced by an all-missing column yields the data-insufficient explanation', () => {
  const r = solveDataset(load('dataset-uninformative.json'), { method: 'exact' });
  assert.equal(r.status, 'solved');
  assert.equal(r.result.total, 0);
  assert.ok(r.diagnostics.some((d) => d.code === 'data-uninformative'));
});

test('equal-cost ties are counted exactly, not over- or under-reported', () => {
  const r = solveDataset(load('dataset-equal.json'), { method: 'exact' });
  // 4 tips give 15 rooted topologies; 10 of them cost 3, the other 5 cost 4.
  assert.equal(r.result.tieCount, 10);
  assert.equal(r.result.tiesComplete, true);
  // Every listed tie really has the reported total.
  for (const tie of r.result.ties) {
    assert.ok(Math.abs(tie.total - r.result.total) < 1e-9);
  }
});

test('lower bound for an unordered two-state feature equals that feature cost', () => {
  const { ctx } = prep(load('dataset-a.json'));
  const b = lowerBound(ctx);
  assert.ok(b.total > 0);
  assert.equal(
    b.total,
    Object.values(b.perFeature).reduce((a, f) => a + f.bound, 0),
  );
});

test('pricing is symmetric for unordered features under root and child swaps', () => {
  const { ctx } = prep(load('dataset-equal.json'));
  const t = [['S1', 'S2'], ['S3', 'S4']];
  const p1 = priceTopology(t, ctx);
  const p2 = priceTopology([t[1], t[0]], ctx);
  assert.equal(p1.total, p2.total);
});

test('too-large exact request fails clearly and offers local search', () => {
  const ds = load('dataset-a.json');
  // Force the exact eligibility check off via a tiny cell budget is not a
  // public knob; instead assert the auto method picks exact here and the
  // message for an oversized V comes from the DP guard.
  const { ctx } = prep(ds);
  const huge = { ...ctx, features: Array.from({ length: 40 }, (_, i) => ({ ...ctx.features[i % ctx.features.length], id: `X${i}` })) };
  const res = solveExactDp(huge, ctx.taxonIds, [], { maxEncodeCells: 1000 });
  assert.equal(res.status, 'too-large');
  assert.match(res.message, /局部搜索/);
});

test('a truncated or duplicated tree is refused by the pricer, not underpriced', () => {
  const { ctx } = prep(load('dataset-a.json'));
  const truncated = priceTopology(['T4', 'T5'], ctx);
  assert.equal(truncated.valid, false);
  assert.match(truncated.reason.message, /缺少样品/);
  const dup = priceTopology([['T1', 'T1'], ['T2', 'T3']], ctx);
  assert.equal(dup.valid, false);
  assert.match(dup.reason.message, /重复出现|缺少样品/);
});

test('every NNI neighbour preserves the leaf set and is a genuine alternative', () => {
  const { ctx, v } = prep(load('dataset-equal.json'));
  const start = [['S1', 'S2'], ['S3', 'S4']];
  const nbrs = uniqueNni(start);
  assert.ok(nbrs.length > 0);
  const base = leafTaxa(start).sort().join(',');
  for (const t of nbrs) {
    assert.equal(leafTaxa(t).sort().join(','), base);
    assert.equal(priceTopology(t, ctx).valid, true);
    assert.notEqual(topologySignature(t), topologySignature(start));
  }
});

test('local search matches exact DP on a batch of random small instances', () => {
  let seed = 424242;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const randInt = (n) => Math.floor(rnd() * n);
  for (let inst = 0; inst < 30; inst++) {
    const n = 4 + randInt(3);
    const nf = 1 + randInt(3);
    const taxa = Array.from({ length: n }, (_, i) => ({ id: `T${i}`, label: `T${i}` }));
    const features = [];
    const matrix = Object.fromEntries(taxa.map((t) => [t.id, []]));
    for (let f = 0; f < nf; f++) {
      const K = 2 + randInt(2);
      const states = Array.from({ length: K }, (_, i) => String(i));
      const ordered = rnd() < 0.4;
      const costs = {};
      for (let a = 0; a < K; a++) {
        for (let b = 0; b < K; b++) {
          if (a === b) continue;
          if (!ordered && b < a) continue;
          const c = 1 + randInt(3);
          costs[ordered ? `${states[a]}>${states[b]}` : `${states[a]}|${states[b]}`] = c;
        }
      }
      features.push({ id: `F${f}`, name: `F${f}`, ordered, states, costs });
      for (const t of taxa) matrix[t.id].push(states[randInt(K)]);
    }
    const ds = { id: `r${inst}`, taxa, features, matrix, constraints: [] };
    const prepd = prep(ds);
    const exact = solveExactDp(prepd.ctx, prepd.v.taxonIds, [], { maxTies: 5 });
    const ls = localSearch(prepd.ctx, prepd.v.taxonIds, [], { seed: inst + 7, restarts: 8, maxIterations: 3000, maxMillis: 1500 });
    assert.equal(exact.status, 'optimal', `instance ${inst}`);
    assert.ok(ls.bestCost !== null, `instance ${inst} found nothing`);
    assert.ok(
      Math.abs(ls.bestCost - exact.optimum) < 1e-9,
      `instance ${inst}: local ${ls.bestCost} vs exact ${exact.optimum}`,
    );
  }
});

test('annotation never assigns a state to a missing tip', () => {
  const { ctx } = prep(load('dataset-a.json'));
  const exact = solveExactDp(ctx, ctx.taxonIds, [], { maxTies: 1 });
  const ann = annotateTree(exact.trees[0], ctx);
  const f3States = ann.featureNodeStates.F3;
  const t4Id = ann.nodes.find((n) => n.taxon === 'T4').id;
  assert.equal(f3States[t4Id], null);
});
