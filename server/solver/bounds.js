/**
 * A checkable lower bound.
 *
 * For each feature take the distinct observed states and the shortest-path
 * distance in that feature's state graph, symmetrised (min of the two
 * directions). Any tree must connect every distinct observed state, so its
 * cost for that feature is at least the weight of a minimum spanning tree on
 * those states. Summing over features gives a valid lower bound on the total,
 * because features are priced independently.
 *
 * The bound is a relaxation: if a search's best cost meets it, the best cost
 * is proven optimal. If the gap is positive, the search result is only the
 * best found so far and is labelled that way.
 */
import { EPS } from './dp.js';

export function featureMstBound(feature) {
  const K = feature.K;
  // shortest directed path distances
  const dist = new Array(K);
  for (let i = 0; i < K; i++) {
    dist[i] = new Float64Array(K);
    for (let j = 0; j < K; j++) {
      dist[i][j] = i === j ? 0 : feature.cost[i * K + j];
    }
  }
  for (let k = 0; k < K; k++) {
    for (let i = 0; i < K; i++) {
      const dik = dist[i][k];
      if (dik === Infinity) continue;
      for (let j = 0; j < K; j++) {
        const dkj = dist[k][j];
        if (dkj === Infinity) continue;
        const via = dik + dkj;
        if (via < dist[i][j]) dist[i][j] = via;
      }
    }
  }
  // seen states per taxon are supplied by caller via feature.observedIndices
  const observed = feature.observedIndices || [];
  const seen = [...new Set(observed)].filter((s) => s >= 0);
  if (seen.length <= 1) {
    return { bound: 0, states: seen.map((s) => feature.states[s]), connected: true };
  }
  // Prim over distinct states with symmetrised shortest-path weights
  const inTree = new Set([seen[0]]);
  let total = 0;
  while (inTree.size < seen.length) {
    let best = Infinity;
    let bestNode = -1;
    for (const a of inTree) {
      for (const b of seen) {
        if (inTree.has(b)) continue;
        const d = Math.min(dist[a][b], dist[b][a]);
        if (d < best) {
          best = d;
          bestNode = b;
        }
      }
    }
    if (bestNode < 0 || !Number.isFinite(best)) {
      return {
        bound: null,
        states: seen.map((s) => feature.states[s]),
        connected: false,
        message: `特征「${feature.name}」的状态图不连通，无法给出有限下界。`,
      };
    }
    inTree.add(bestNode);
    total += best;
  }
  return {
    bound: total * feature.weight,
    rawBound: total,
    states: seen.map((s) => feature.states[s]),
    connected: true,
  };
}

export function lowerBound(ctx) {
  let total = 0;
  const perFeature = {};
  let connected = true;
  for (const feature of ctx.features) {
    const r = featureMstBound(feature);
    perFeature[feature.id] = r;
    if (r.bound === null) connected = false;
    else total += r.bound;
  }
  return { total: connected ? total : null, perFeature, connected };
}

export function gapOf(best, bound) {
  if (!Number.isFinite(best) || !Number.isFinite(bound)) return null;
  return Math.max(0, best - bound);
}

export function certificate(best, bound) {
  if (!Number.isFinite(best) || !Number.isFinite(bound)) return false;
  return Math.abs(best - bound) <= EPS * Math.max(1, Math.abs(best));
}
