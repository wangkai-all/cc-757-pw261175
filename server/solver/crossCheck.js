/**
 * Verify one concrete tree against a dataset, independently of the solver that
 * produced it. Used by the UI's "核对这棵树" action and by tests.
 *
 * Returns: cost, per-feature costs, which locks hold/fail, which transitions
 * have no declared cost, and — on small inputs — the tree's rank among all
 * topologies.
 */
import { validateDataset } from '../../shared/validate.js';
import { makePricingContext, priceTopology, annotateTree, leafTaxa, cladeMasks, maskToTaxa } from './tree.js';
import { compileLocks } from './solve.js';
import { enumerateSmall } from './enumerate.js';
import { popcount } from './bitset.js';

function validateTreeShape(tree, taxonIds) {
  const leaves = leafTaxa(tree);
  if (leaves.length !== taxonIds.length) {
    return { ok: false, message: `树有 ${leaves.length} 个叶，但数据有 ${taxonIds.length} 个样品。` };
  }
  const seen = new Set();
  for (const t of leaves) {
    if (!taxonIds.includes(t)) return { ok: false, message: `树里出现了数据中不存在的样品「${t}」。` };
    if (seen.has(t)) return { ok: false, message: `样品「${t}」在树里出现不止一次。` };
    seen.add(t);
  }
  return { ok: true };
}

export function crossCheckTree(dataset, tree, options = {}) {
  const validation = validateDataset(dataset);
  if (!validation.ok) {
    return { ok: false, status: 'invalid-input', errors: validation.errors };
  }
  const shape = validateTreeShape(tree, validation.taxonIds);
  if (!shape.ok) return { ok: false, status: 'invalid-tree', message: shape.message };

  const norm = { ...dataset, taxonIds: validation.taxonIds, features: validation.features, matrix: validation.matrix };
  const ctx = makePricingContext(norm);
  for (const feature of ctx.features) {
    feature.observedIndices = [];
    const fi = validation.features.findIndex((f) => f.id === feature.id);
    for (const t of validation.taxonIds) {
      const v = (norm.matrix[t] || [])[fi];
      if (v === null || v === undefined) continue;
      const idx = feature.index.get(v);
      if (idx !== undefined) feature.observedIndices.push(idx);
    }
  }
  const priced = priceTopology(tree, ctx);
  const locks = compileLocks(validation.locks, validation.taxonIds);
  const masks = new Set(cladeMasks(tree, ctx.taxonIndex));
  const lockReport = locks.details.map((d) => ({
    id: d.id,
    taxa: d.taxa,
    holds: d.trivial ? true : masks.has(d.mask),
    trivial: d.trivial,
    reason: d.trivial ? d.reason : undefined,
  }));

  const annotation = priced.valid ? annotateTree(tree, ctx) : null;

  // Unpriced features (missing transition costs) are named precisely.
  const unpricedFeatures = [];
  if (!priced.valid) {
    unpricedFeatures.push({ featureId: priced.reason.featureId, message: priced.reason.message });
  } else {
    for (const feature of ctx.features) {
      const K = feature.K;
      const observed = new Set(feature.observedIndices);
      let ok = true;
      for (let i = 0; i < K && ok; i++) {
        for (let j = 0; j < K && ok; j++) {
          if (i !== j && feature.cost[i * K + j] === Infinity) {
            // only a problem if both states are observed
            if (observed.has(i) && observed.has(j)) ok = false;
          }
        }
      }
      if (!ok) unpricedFeatures.push({ featureId: feature.id, message: `特征「${feature.name}」存在未定价的转移。` });
    }
  }

  let rank = null;
  const n = validation.taxonIds.length;
  if (n <= 8) {
    const all = enumerateSmall(ctx, validation.taxonIds, [], { maxTies: 100000 });
    if (all.status === 'complete') {
      const target = priced.valid ? priced.total : null;
      const target_tree_ok = priced.valid;
      const rankWithin = (rows) => {
        const cheaper = rows.filter((r) => target !== null && r.cost < target - 1e-9).length;
        const equal = rows.filter((r) => target !== null && Math.abs(r.cost - target) <= 1e-9).length;
        return { totalTopologies: rows.length, cheaperThanThis: cheaper, equalCost: equal };
      };
      const free = rankWithin(all.all);
      // The solve respected the locks; ranking against every topology without
      // them would show a larger tie count and look like a contradiction.
      // Report the lock-constrained ranking too, whenever locks exist.
      let locked = null;
      if (validation.locks.length) {
        const withLocks = enumerateSmall(ctx, validation.taxonIds, locks.masks, { maxTies: 100000 });
        if (withLocks.status === 'complete') {
          const rows = withLocks.all;
          const within = rankWithin(rows);
          locked = {
            ...within,
            bestCost: withLocks.bestCost,
            isOptimal: target !== null && Math.abs(target - withLocks.bestCost) <= 1e-9,
            treeSatisfiesLocks: lockReport.every((l) => l.holds),
          };
        } else if (withLocks.status === 'infeasible') {
          locked = { totalTopologies: 0, infeasible: true, message: withLocks.message };
        }
      }
      rank = {
        ...free,
        bestCost: all.bestCost,
        isOptimal: target_tree_ok && Math.abs(target - all.bestCost) <= 1e-9,
        locked,
      };
    }
  }

  return {
    ok: true,
    status: 'checked',
    valid: priced.valid,
    cost: priced.valid ? priced.total : null,
    perFeature: priced.valid ? priced.perFeature : null,
    message: priced.valid ? null : priced.reason.message,
    locks: lockReport,
    allLocksHold: lockReport.every((l) => l.holds),
    unpricedFeatures,
    leafCount: leafTaxa(tree).length,
    annotation,
    rank,
    note:
      '这是对给定树形的独立计价与锁定核对，不代表该树反映真实亲缘关系，也不等同于全局最优搜索。',
  };
}
