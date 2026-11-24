/**
 * Independent exhaustive enumeration for small samples.
 *
 * Deliberately written differently from the DP: it generates every rooted
 * binary topology by recursive bipartition with memoised sub-results, prices
 * each topology with the shared pricer, and filters by locks. It is used to
 * cross-check the DP on small inputs and by the UI's "核对" button. It is not
 * the interactive solver.
 */
import { priceTopology, topologySignature, leafTaxa, cladeMasks, isLeaf } from './tree.js';
import { EPS } from './dp.js';

const MAX_TIPS = 8;

export function enumerateTopologies(n, taxonIds) {
  const memo = new Map();
  const ids = taxonIds.slice(0, n);
  const result = new Map();

  function build(tipsKey) {
    const tips = tipsKey.split(',');
    const key = tips.join(',');
    if (memo.has(key)) return memo.get(key);
    let out;
    if (tips.length === 1) {
      out = [tips[0]];
    } else if (tips.length === 2) {
      out = [[tips[0], tips[1]]];
    } else {
      const anchor = tips[0];
      const rest = tips.slice(1);
      const seen = new Set();
      out = [];
      for (let mask = 0; mask < 1 << rest.length; mask++) {
        const side = [anchor];
        for (let i = 0; i < rest.length; i++) if (mask & (1 << i)) side.push(rest[i]);
        if (side.length === rest.length + 1) continue;
        const other = tips.filter((t) => !side.includes(t));
        const splitKey = [side.join(','), other.join(',')].sort().join('/');
        if (seen.has(splitKey)) continue;
        seen.add(splitKey);
        for (const L of build(side.join(','))) {
          for (const R of build(other.join(','))) {
            out.push([L, R]);
          }
        }
      }
    }
    memo.set(key, out);
    return out;
  }

  for (const t of build(ids.join(','))) {
    const s = topologySignature(t);
    if (!result.has(s)) result.set(s, t);
  }
  return [...result.values()];
}

export function testAllLocks(tree, ctx, lockMasks) {
  const masks = new Set(cladeMasks(tree, ctx.taxonIndex));
  return lockMasks.every((L) => masks.has(L));
}

export function enumerateSmall(ctx, taxonIds, lockMasks, opts = {}) {
  const { maxTies = 2000 } = opts;
  const n = taxonIds.length;
  if (n > MAX_TIPS) {
    return { status: 'too-large', message: `枚举只用于 ${MAX_TIPS} 个样品以内；当前 ${n} 个。` };
  }
  const topologies = enumerateTopologies(n, taxonIds);
  const priced = [];
  let pricedCount = 0;
  for (const t of topologies) {
    if (!testAllLocks(t, ctx, lockMasks)) continue;
    const p = priceTopology(t, ctx);
    if (!p.valid) continue;
    pricedCount++;
    priced.push({ tree: t, cost: p.total, perFeature: p.perFeature });
  }
  if (!priced.length) {
    return {
      status: 'infeasible',
      message: '在锁定约束下没有可定价的树。',
      enumerated: topologies.length,
    };
  }
  let best = Infinity;
  for (const row of priced) if (row.cost < best) best = row.cost;
  const ties = priced.filter((r) => Math.abs(r.cost - best) <= EPS * Math.max(1, Math.abs(best)));
  return {
    status: 'complete',
    enumerated: topologies.length,
    priced: pricedCount,
    bestCost: best,
    tieCount: ties.length,
    ties: ties.slice(0, maxTies),
    tiesComplete: ties.length <= maxTies,
    all: priced,
  };
}

export { leafTaxa, isLeaf };
