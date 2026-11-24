/**
 * Resampling in units of whole features, keeping the lock set fixed.
 *
 * Each replicate draws F feature columns with replacement (whole columns, not
 * cells). Two modes:
 *   - fixed tree: re-price the tree you are looking at on each replicate, so
 *     the spread is pure feature-sampling variation around that tree;
 *   - re-optimise: solve each replicate exactly under the same locks, and report
 *     how often each topology remains (co-)optimal.
 *
 * Locks are compiled once and passed unchanged into every replicate's solve, so
 * a replicate can never silently produce a tree that violates a lock.
 */
import { validateDataset } from '../../shared/validate.js';
import { makePricingContext, priceTopology, topologySignature } from './tree.js';
import { solveExactDp } from './dp.js';
import { compileLocks, exactEligible } from './solve.js';
import { mulberry32 } from './util.js';

function defaultCaterpillar(taxonIds) {
  let t = taxonIds[taxonIds.length - 1];
  for (let i = taxonIds.length - 2; i >= 0; i--) t = [t, taxonIds[i]];
  return t;
}

export function resampleFeatures(dataset, options = {}) {
  const {
    seed = 20260101,
    replicates = 200,
    reoptimise = false,
    fixedTree = null,
    maxMillis = 5000,
  } = options;
  const validation = validateDataset(dataset);
  if (!validation.ok) {
    return {
      ok: false,
      status: 'invalid-input',
      message: '数据集没有通过校验，不能重采样。',
      errors: validation.errors,
    };
  }
  const base = {
    ...dataset,
    taxonIds: validation.taxonIds,
    features: validation.features,
    matrix: validation.matrix,
  };
  const ctx = makePricingContext(base);
  for (const feature of ctx.features) {
    feature.observedIndices = [];
    const fi = validation.features.findIndex((f) => f.id === feature.id);
    for (const taxon of validation.taxonIds) {
      const v = (base.matrix[taxon] || [])[fi];
      if (v === null || v === undefined) continue;
      const idx = feature.index.get(v);
      if (idx !== undefined) feature.observedIndices.push(idx);
    }
  }
  const locks = compileLocks(validation.locks, validation.taxonIds);
  const rng = mulberry32(seed);
  const F = ctx.features.length;
  const n = ctx.taxonIds.length;
  const tree = fixedTree || defaultCaterpillar(ctx.taxonIds);
  const canReoptimise = reoptimise && exactEligible(base, ctx.features.reduce((a, f) => a * f.K, 1)).ok;
  const started = Date.now();
  const rows = [];
  const topologyCounts = new Map();
  let truncated = false;
  let infeasibleReplicates = 0;
  let invalidReplicates = 0;
  const reoptNote = reoptimise && !canReoptimise
    ? '当前规模超出精确求解上限，重采样只对给定树重新计价，不重新搜索拓扑。'
    : null;

  for (let r = 0; r < replicates; r++) {
    if (Date.now() - started > maxMillis) {
      truncated = true;
      break;
    }
    const picks = new Array(F);
    for (let i = 0; i < F; i++) picks[i] = Math.floor(rng() * F);
    const multiplicity = {};
    for (const p of picks) {
      const id = ctx.features[p].id;
      multiplicity[id] = (multiplicity[id] || 0) + 1;
    }

    // Each draw is its own feature slot; duplicates each contribute their cost.
    // Values must be rebuilt in the resampled column order.
    const repValues = new Map();
    for (const taxon of ctx.taxonIds) {
      const row = ctx.values.get(taxon) || [];
      repValues.set(taxon, picks.map((p) => row[p]));
    }
    const repCtx = {
      features: picks.map((p) => ctx.features[p]),
      taxonIds: ctx.taxonIds,
      taxonIndex: ctx.taxonIndex,
      values: repValues,
      fullMask: ctx.fullMask,
    };

    if (canReoptimise) {
      const exact = solveExactDp(repCtx, ctx.taxonIds, locks.masks, { maxTies: 1, maxTieNodes: 20000 });
      if (exact.status !== 'optimal') {
        if (exact.status === 'infeasible') infeasibleReplicates++;
        else invalidReplicates++;
        rows.push({ replicate: r, valid: false, reason: exact.status });
        continue;
      }
      const topo = exact.trees[0] || null;
      const sig = topo ? topologySignature(topo) : null;
      if (sig) topologyCounts.set(sig, (topologyCounts.get(sig) || 0) + 1);
      rows.push({
        replicate: r,
        valid: true,
        mode: 'reoptimised',
        total: exact.optimum,
        topologySignature: sig,
        multiplicity,
      });
    } else {
      const priced = priceTopology(tree, repCtx);
      if (!priced.valid) {
        invalidReplicates++;
        rows.push({ replicate: r, valid: false, reason: 'missing-transition-cost' });
        continue;
      }
      rows.push({
        replicate: r,
        valid: true,
        mode: 'fixed-tree',
        total: priced.total,
        multiplicity,
      });
    }
  }

  const valid = rows.filter((x) => x.valid);
  const totals = valid.map((x) => x.total).sort((a, b) => a - b);
  const quantile = (q) => {
    if (!totals.length) return null;
    const idx = Math.min(totals.length - 1, Math.max(0, Math.round(q * (totals.length - 1))));
    return totals[idx];
  };
  const mean = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;

  let topologySummary = null;
  if (canReoptimise) {
    const total = [...topologyCounts.values()].reduce((a, b) => a + b, 0);
    topologySummary = [...topologyCounts.entries()]
      .map(([sig, count]) => ({ signature: sig, count, share: total ? count / total : 0 }))
      .sort((a, b) => b.count - a.count || (a.signature < b.signature ? -1 : 1));
  }

  return {
    ok: true,
    status: 'complete',
    limited: truncated,
    replicatesRequested: replicates,
    replicatesDone: rows.length,
    validReplicates: valid.length,
    invalidReplicates,
    infeasibleReplicates,
    seed,
    unit: 'feature',
    mode: canReoptimise ? 'reoptimised' : 'fixed-tree',
    reoptNote,
    fixedTree: canReoptimise ? null : tree,
    summary: {
      min: totals.length ? totals[0] : null,
      max: totals.length ? totals[totals.length - 1] : null,
      median: quantile(0.5),
      mean,
      q025: quantile(0.025),
      q975: quantile(0.975),
    },
    topologySummary,
    samples: valid.map((x) => x.total),
    rows,
    note:
      '重采样以整列特征为单位（不是逐格）；锁定约束在每个重复中保持生效。' +
      '这只反映特征抽样的波动，不是置信区间，也不代表真实亲缘关系。',
  };
}
