/**
 * Rooted binary tree representation, Sankoff-style pricing and annotation.
 *
 * Topology: a leaf is a taxon id string; an internal node is `[left, right]`.
 * Children are unordered. The root is a real node with exactly two children.
 *
 * Pricing is done independently per feature, so the total is the sum of
 * per-feature minima. A missing value is a wildcard: it imposes no state and
 * no edge cost, and is never reconstructed as a category.
 */
import { popcount } from './bitset.js';

export const INF = Number.POSITIVE_INFINITY;

export function isLeaf(node) {
  return typeof node === 'string';
}

export function leafTaxa(tree, out = []) {
  if (isLeaf(tree)) out.push(tree);
  else {
    leafTaxa(tree[0], out);
    leafTaxa(tree[1], out);
  }
  return out;
}

export function sizeOf(tree) {
  return isLeaf(tree) ? 1 : sizeOf(tree[0]) + sizeOf(tree[1]);
}

export function topologySignature(tree) {
  if (isLeaf(tree)) return tree;
  const a = topologySignature(tree[0]);
  const b = topologySignature(tree[1]);
  return a < b ? `(${a},${b})` : `(${b},${a})`;
}

/** Clade masks for every node, including the root. */
export function cladeMasks(tree, taxaIndex) {
  const masks = [];
  const walk = (node) => {
    if (isLeaf(node)) {
      const m = 1 << taxaIndex.get(node);
      masks.push(m);
      return m;
    }
    const m = walk(node[0]) | walk(node[1]);
    masks.push(m);
    return m;
  };
  walk(tree);
  return masks;
}

/** Internal clade masks excluding the root and singletons. */
export function internalCladeMasks(tree, taxaIndex) {
  const full = (1 << taxaIndex.size) - 1;
  const out = [];
  const walk = (node) => {
    if (isLeaf(node)) return 1 << taxaIndex.get(node);
    const m = walk(node[0]) | walk(node[1]);
    if (m !== full && popcount(m) >= 2) out.push(m);
    return m;
  };
  walk(tree);
  return out;
}

/**
 * Unrooted split signature, for grouping trees that differ only by root
 * placement. Pendant splits (one side a single taxon) are uninformative and
 * are omitted, so with 4 taxa the three unrooted arrangements get three
 * distinct signatures.
 */
export function unrootedSignature(tree, taxaIndex) {
  const fullMask = (1 << taxaIndex.size) - 1;
  const splits = new Set();
  const walk = (node) => {
    if (isLeaf(node)) return 1 << taxaIndex.get(node);
    const m = walk(node[0]) | walk(node[1]);
    const other = fullMask & ~m;
    if (popcount(m) >= 2 && popcount(other) >= 2) {
      splits.add(`${Math.min(m, other)}/${Math.max(m, other)}`);
    }
    return m;
  };
  walk(tree);
  return [...splits].sort().join(';');
}

export function maskToTaxa(mask, taxonIds) {
  const out = [];
  for (let i = 0; i < taxonIds.length; i++) if (mask & (1 << i)) out.push(taxonIds[i]);
  return out;
}

// ---------------------------------------------------------------------------
// pricing context

function canonicalPair(a, b) {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

export function makePricingContext(dataset, featureWeights = null) {
  const taxonIndex = new Map(dataset.taxonIds.map((t, i) => [t, i]));
  const features = dataset.features.map((f) => {
    const K = f.states.length;
    const index = new Map(f.states.map((s, i) => [s, i]));
    const cost = new Float64Array(K * K);
    let unpriced = 0;
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) {
        if (i === j) {
          cost[i * K + j] = 0;
          continue;
        }
        const key = f.ordered ? `${f.states[i]}>${f.states[j]}` : canonicalPair(f.states[i], f.states[j]);
        const c = f.costs[key];
        if (typeof c === 'number' && Number.isFinite(c)) {
          cost[i * K + j] = c;
        } else {
          cost[i * K + j] = INF;
          unpriced++;
        }
      }
    }
    return {
      id: f.id,
      name: f.name,
      ordered: !!f.ordered,
      states: f.states,
      index,
      K,
      cost,
      unpriced,
      weight: featureWeights && typeof featureWeights[f.id] === 'number' ? featureWeights[f.id] : 1,
    };
  });
  const values = new Map();
  for (const t of dataset.taxonIds) values.set(t, dataset.matrix[t] || []);
  return {
    features,
    taxonIds: dataset.taxonIds,
    taxonIndex,
    values,
    fullMask: (1 << dataset.taxonIds.length) - 1,
  };
}

export function stateIndexAt(ctx, taxon, featureIndex) {
  const row = ctx.values.get(taxon);
  const v = row ? row[featureIndex] : null;
  if (v === null || v === undefined) return -1;
  return ctx.features[featureIndex].index.get(v) ?? -1;
}

function leafVector(feature, observedIndex) {
  const v = new Float64Array(feature.K);
  if (observedIndex < 0) return v; // wildcard: all states at zero cost
  v.fill(INF);
  v[observedIndex] = 0;
  return v;
}

function combineFromChildren(feature, left, right, out) {
  const { K, cost } = feature;
  for (let s = 0; s < K; s++) {
    let bestL = INF;
    let bestR = INF;
    const row = s * K;
    for (let a = 0; a < K; a++) {
      const c = cost[row + a];
      if (c === INF) continue;
      const la = left[a];
      if (la !== INF) {
        const val = la + c;
        if (val < bestL) bestL = val;
      }
      const ra = right[a];
      if (ra !== INF) {
        const val = ra + c;
        if (val < bestR) bestR = val;
      }
    }
    out[s] = bestL === INF || bestR === INF ? INF : bestL + bestR;
  }
  return out;
}

/**
 * A priced tree must contain every declared taxon exactly once. Without this
 * guard a truncated tree would look cheap simply because it has fewer leaves.
 */
export function checkLeafSet(tree, taxonIds) {
  const seen = new Map();
  let count = 0;
  const walk = (node) => {
    if (isLeaf(node)) {
      count++;
      seen.set(node, (seen.get(node) || 0) + 1);
    } else {
      walk(node[0]);
      walk(node[1]);
    }
  };
  walk(tree);
  const expected = new Set(taxonIds);
  const unknown = [...seen.keys()].filter((t) => !expected.has(t));
  if (unknown.length) return { ok: false, message: `入树了未声明的样品 ${unknown.join('、')}` };
  const duplicated = [...seen.entries()].filter(([, c]) => c > 1).map(([t]) => t);
  if (duplicated.length) return { ok: false, message: `样品 ${duplicated.join('、')} 重复出现` };
  const missing = taxonIds.filter((t) => !seen.has(t));
  if (missing.length) return { ok: false, message: `缺少样品 ${missing.join('、')}` };
  if (count !== taxonIds.length) return { ok: false, message: `叶数 ${count} 与样品数 ${taxonIds.length} 不符` };
  return { ok: true };
}

/**
 * Minimum cost of a topology, summed over features.
 * @returns {{valid:true,total:number,perFeature:Object}|{valid:false,total:null,reason:Object}}
 */
export function priceTopology(tree, ctx) {
  const check = checkLeafSet(tree, ctx.taxonIds);
  if (!check.ok) {
    return {
      valid: false,
      total: null,
      reason: {
        featureId: null,
        featureName: null,
        message: `树形不完整：${check.message}。这样的树不会被计价，以免把漏掉的样品当成免费。`,
      },
    };
  }
  const perFeature = {};
  let total = 0;
  for (let fi = 0; fi < ctx.features.length; fi++) {
    const feature = ctx.features[fi];
    const walk = (node) => {
      if (isLeaf(node)) return leafVector(feature, stateIndexAt(ctx, node, fi));
      const out = new Float64Array(feature.K);
      return combineFromChildren(feature, walk(node[0]), walk(node[1]), out);
    };
    const rootDp = walk(tree);
    let best = INF;
    for (let s = 0; s < feature.K; s++) if (rootDp[s] < best) best = rootDp[s];
    if (best === INF) {
      return {
        valid: false,
        total: null,
        reason: {
          featureId: feature.id,
          featureName: feature.name,
          message: `特征「${feature.name}」无法为这棵树定价：它至少需要一个未声明的状态转移代价。请补全该特征的代价表，或把相关样品标为缺失。`,
        },
      };
    }
    const weighted = best * feature.weight;
    perFeature[feature.id] = {
      cost: best,
      weight: feature.weight,
      weightedCost: weighted,
    };
    total += weighted;
  }
  return { valid: true, total, perFeature };
}

// ---------------------------------------------------------------------------
// annotation for the UI

export function buildNodeTree(tree) {
  const nodes = [];
  let nextId = 0;
  const rec = (t, depth, parentId) => {
    const node = { id: nextId++, depth, parent: parentId, children: [] };
    nodes.push(node);
    if (isLeaf(t)) {
      node.kind = 'leaf';
      node.taxon = t;
    } else {
      node.kind = 'internal';
      node.children = [rec(t[0], depth + 1, node.id), rec(t[1], depth + 1, node.id)];
    }
    return node;
  };
  const root = rec(tree, 0, null);
  return { root, nodes };
}

/**
 * Optimal state reconstruction and per-edge costs.
 *
 * The reconstruction is a valid optimum (its total equals the DP optimum),
 * but where several ancestral states tie only one is shown. `tie` flags where
 * an alternative choice is equally cheap so the UI can say so rather than
 * presenting the choice as identified.
 */
export function annotateTree(tree, ctx) {
  const { root, nodes } = buildNodeTree(tree);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const postOrder = [...nodes].sort((a, b) => b.id - a.id);
  const edgeByKey = new Map();
  const edgeFor = (parentId, childId) => {
    const key = `${parentId}:${childId}`;
    let e = edgeByKey.get(key);
    if (!e) {
      e = { parentId, childId, perFeature: {}, totalCost: 0, totalWeighted: 0, ties: false };
      edgeByKey.set(key, e);
    }
    return e;
  };

  const perFeature = {};
  const featureNodeStates = {};

  for (let fi = 0; fi < ctx.features.length; fi++) {
    const feature = ctx.features[fi];
    const dp = new Array(nodes.length);
    for (const node of postOrder) {
      if (node.kind === 'leaf') {
        dp[node.id] = leafVector(feature, stateIndexAt(ctx, node.taxon, fi));
      } else {
        const out = new Float64Array(feature.K);
        combineFromChildren(feature, dp[node.children[0].id], dp[node.children[1].id], out);
        dp[node.id] = out;
      }
    }
    let best = INF;
    for (let s = 0; s < feature.K; s++) if (dp[root.id][s] < best) best = dp[root.id][s];
    if (best === INF) {
      perFeature[feature.id] = {
        cost: null,
        weight: feature.weight,
        weightedCost: null,
        message: `特征「${feature.name}」无法定价。`,
      };
      featureNodeStates[feature.id] = {};
      continue;
    }
    const rootTies = [];
    for (let s = 0; s < feature.K; s++) if (dp[root.id][s] === best) rootTies.push(s);

    const states = new Map();
    let internalTieCount = 0;
    const chooseChildState = (node, parentState) => {
      let bestVal = INF;
      let bestS = -1;
      let ties = 0;
      for (let s = 0; s < feature.K; s++) {
        const d = dp[node.id][s];
        if (d === INF) continue;
        const c = feature.cost[parentState * feature.K + s];
        if (c === INF) continue;
        const val = d + c;
        if (val < bestVal - 1e-12) {
          bestVal = val;
          bestS = s;
          ties = 1;
        } else if (Math.abs(val - bestVal) <= 1e-12) {
          ties++;
        }
      }
      if (ties > 1) internalTieCount++;
      return { state: bestS, tie: ties > 1 };
    };

    const assign = (node, parentState, parentNode) => {
      if (node.kind === 'leaf') {
        const observed = stateIndexAt(ctx, node.taxon, fi);
        if (observed < 0) {
          states.set(node.id, null);
          if (parentNode) {
            const e = edgeFor(parentNode.id, node.id);
            e.perFeature[feature.id] = {
              cost: 0,
              from: feature.states[parentState] ?? null,
              to: null,
              missing: true,
              stateFromIndex: parentState,
              stateToIndex: null,
              tie: false,
            };
          }
        } else {
          states.set(node.id, observed);
          if (parentNode) {
            const e = edgeFor(parentNode.id, node.id);
            const c = feature.cost[parentState * feature.K + observed];
            e.perFeature[feature.id] = {
              cost: c,
              from: feature.states[parentState],
              to: feature.states[observed],
              missing: false,
              stateFromIndex: parentState,
              stateToIndex: observed,
              tie: false,
            };
          }
        }
        return;
      }
      let s;
      let tie = false;
      if (parentNode === null) {
        s = rootTies[0];
        tie = rootTies.length > 1;
      } else {
        const picked = chooseChildState(node, parentState);
        s = picked.state;
        tie = picked.tie;
        if (s < 0) s = rootTies[0] ?? 0;
      }
      states.set(node.id, s);
      if (parentNode) {
        const e = edgeFor(parentNode.id, node.id);
        const c = feature.cost[parentState * feature.K + s];
        e.perFeature[feature.id] = {
          cost: c,
          from: feature.states[parentState],
          to: feature.states[s],
          missing: false,
          stateFromIndex: parentState,
          stateToIndex: s,
          tie,
        };
        e.ties = e.ties || tie;
      }
      for (const child of node.children) assign(child, s, node);
    };
    assign(root, null, null);

    let sum = 0;
    for (const e of edgeByKey.values()) {
      const info = e.perFeature[feature.id];
      if (info) sum += info.cost || 0;
    }
    perFeature[feature.id] = {
      cost: best,
      weight: feature.weight,
      weightedCost: best * feature.weight,
      rootStates: rootTies.map((s) => feature.states[s]),
      rootTies: rootTies.length > 1,
      reconstructedTotal: sum,
      reconstructedMatchesOptimum: Math.abs(sum - best) < 1e-9,
      internalTieCount,
    };
    featureNodeStates[feature.id] = Object.fromEntries(states);
  }

  const weightOf = new Map(ctx.features.map((f) => [f.id, f.weight]));
  const edges = [...edgeByKey.values()].map((e) => {
    let totalCost = 0;
    let totalWeighted = 0;
    for (const [fid, info] of Object.entries(e.perFeature)) {
      const w = weightOf.get(fid) ?? 1;
      totalCost += info.cost || 0;
      totalWeighted += (info.cost || 0) * w;
    }
    return { ...e, totalCost, totalWeighted };
  });

  return {
    tree,
    root,
    nodes: nodes.map((n) => ({
      ...n,
      childIds: n.children.map((c) => c.id),
      cladeMask: cladeMaskForNode(n, nodes, ctx.taxonIndex),
    })),
    edges,
    perFeature,
    featureNodeStates,
    total: Object.values(perFeature).reduce((acc, row) => acc + (row.weightedCost ?? 0), 0),
  };
}

function cladeMaskForNode(node, nodes, taxonIndex) {
  let mask = 0;
  const walk = (id) => {
    const n = nodes[id];
    if (n.kind === 'leaf') {
      mask |= 1 << taxonIndex.get(n.taxon);
      return;
    }
    walk(n.children[0].id);
    walk(n.children[1].id);
  };
  walk(node.id);
  return mask;
}

// ---------------------------------------------------------------------------
// Newick export

export function toNewick(tree, labels = {}) {
  const quote = (s) => {
    const label = labels[s] || s;
    return /[\s(),:;']/.test(label) ? `'${label.replace(/'/g, "''")}'` : label;
  };
  const rec = (node) => (isLeaf(node) ? quote(node) : `(${rec(node[0])},${rec(node[1])})`);
  return `${rec(tree)};`;
}
