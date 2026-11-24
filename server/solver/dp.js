/**
 * Exact solver: dynamic programming over tip subsets, jointly over all features.
 *
 * All features must share one topology, so a node carries a *vector* of
 * ancestral states (one per feature), encoded as a mixed-radix integer v.
 * With V such vectors:
 *
 *   G[S][v] = min cost of a rooted binary tree on tip set S whose root is v
 *   H[S][v] = min_u ( G[S][u] + join(v,u) )     // S attached below state v
 *   G[S][v] = min over splits A|B of  H[A][v] + H[B][v]
 *
 * Every split is canonicalised by putting the lowest tip of S into A, so each
 * unordered split is visited once. Lock masks are tested *inside* the split
 * loop: a split of S is rejected unless every lock strictly inside S lies
 * wholly in one side. The optimum is therefore proven over the constrained
 * tree space, not repaired afterwards.
 *
 * Missing tip values are wildcards (all states equally free, no edge cost);
 * they are never assigned a category.
 */
import { popcount } from './bitset.js';

export const EPS = 1e-9;
const tol = (x) => EPS * Math.max(1, Math.abs(x));

export function buildEncoding(features) {
  const V = features.reduce((acc, f) => acc * f.K, 1);
  const parts = new Array(V);
  for (let v = 0; v < V; v++) {
    const arr = new Array(features.length);
    let rest = v;
    for (let i = features.length - 1; i >= 0; i--) {
      const K = features[i].K;
      arr[i] = rest % K;
      rest = Math.floor(rest / K);
    }
    parts[v] = arr;
  }
  return { V, parts };
}

export function buildJoin(features, V, parts) {
  const join = new Float64Array(V * V);
  for (let v = 0; v < V; v++) {
    const pv = parts[v];
    for (let u = 0; u < V; u++) {
      const pu = parts[u];
      let sum = 0;
      for (let f = 0; f < features.length; f++) {
        const feature = features[f];
        const c = feature.cost[pv[f] * feature.K + pu[f]];
        if (c === Infinity) {
          sum = Infinity;
          break;
        }
        sum += c * feature.weight;
      }
      join[v * V + u] = sum;
    }
  }
  return join;
}

/** All state-vector ids compatible with one taxon's observations. */
export function allowedVectors(ctx, taxon, fixture) {
  const { features } = ctx;
  const out = [];
  const rec = (fi, acc) => {
    if (fi === features.length) {
      out.push(acc);
      return;
    }
    const feature = features[fi];
    const obs = fixture ? fixture[fi] : null;
    if (obs === null || obs === undefined) {
      for (let s = 0; s < feature.K; s++) rec(fi + 1, acc * feature.K + s);
    } else {
      const idx = feature.index.get(obs);
      if (idx === undefined) return;
      rec(fi + 1, acc * feature.K + idx);
    }
  };
  rec(0, 0);
  return out;
}

/**
 * Main exact solve.
 *
 * @param {object} ctx pricing context
 * @param {string[]} taxonIds order used for bit positions
 * @param {number[]} lockMasks lock clades as masks (proper subsets, size >= 2)
 * @param {object} opts
 */
export function solveExactDp(ctx, taxonIds, lockMasks, opts = {}) {
  const { maxTies = 400, maxTieNodes = 400000, maxEncodeCells = 6_000_000 } = opts;
  const minTies = opts.minTies ?? maxTies;
  const n = taxonIds.length;
  const full = (1 << n) - 1;
  const totalSets = 1 << n;
  // Count V before allocating anything, so an absurd state-vector count fails
  // with a readable message instead of a RangeError.
  let Vcount = 1;
  for (const f of ctx.features) {
    Vcount *= f.K;
    if (Vcount > 50_000_000) break;
  }
  if (Vcount > 2_000_000 || totalSets * Vcount > maxEncodeCells) {
    return {
      status: 'too-large',
      message: `精确动态规划需要 ${totalSets} 个子集 × ${Vcount} 个状态向量，超过本机上限；请改用局部搜索。`,
      V: Vcount,
    };
  }
  const { V, parts } = buildEncoding(ctx.features);
  if (totalSets * V > maxEncodeCells) {
    return {
      status: 'too-large',
      message: `精确动态规划需要 ${totalSets} 个子集 × ${V} 个状态向量，超过本机上限；请改用局部搜索。`,
      V,
    };
  }
  const join = buildJoin(ctx.features, V, parts);

  const bitToTaxon = new Map();
  const atomIndex = new Map();
  for (let i = 0; i < n; i++) {
    bitToTaxon.set(1 << i, taxonIds[i]);
    atomIndex.set(taxonIds[i], i);
  }

  const allowed = new Array(totalSets);
  for (let i = 0; i < n; i++) {
    allowed[1 << i] = allowedVectors(ctx, taxonIds[i], ctx.values.get(taxonIds[i]));
  }

  // Pre-resolve locks that are proper subsets of each set lazily.
  const G = new Array(totalSets);
  const H = new Array(totalSets);
  const splitAllowedCache = new Map();
  function splitAllowed(S, A, B) {
    const key = `${S}:${A}`;
    const cached = splitAllowedCache.get(key);
    if (cached !== undefined) return cached;
    let ok = true;
    for (let li = 0; li < lockMasks.length; li++) {
      const L = lockMasks[li];
      if ((L & S) !== L) continue;
      if (L === S) continue;
      if ((A & L) !== L && (B & L) !== L) {
        ok = false;
        break;
      }
    }
    splitAllowedCache.set(key, ok);
    return ok;
  }

  for (let S = 1; S <= full; S++) {
    const g = new Float64Array(V);
    g.fill(Infinity);
    if (popcount(S) === 1) {
      const av = allowed[S];
      for (const v of av) g[v] = 0;
      G[S] = g;
      const h = new Float64Array(V);
      for (let v = 0; v < V; v++) {
        let best = Infinity;
        for (let ai = 0; ai < av.length; ai++) {
          const c = join[v * V + av[ai]];
          if (c < best) best = c;
        }
        h[v] = best;
      }
      H[S] = h;
      continue;
    }
    if (popcount(S) === 2) {
      // fast path: exactly one split
      const a = S & -S;
      const b = S ^ a;
      if (splitAllowed(S, a, b)) {
        const ha = H[a];
        const hb = H[b];
        for (let v = 0; v < V; v++) {
          const val = ha[v] + hb[v];
          if (val < g[v]) g[v] = val;
        }
      }
    } else {
      const anchor = S & -S;
      const rest = S ^ anchor;
      for (let sub = (rest - 1) & rest; ; sub = (sub - 1) & rest) {
        const A = sub | anchor;
        const B = S ^ A;
        if (B !== 0 && A !== S && splitAllowed(S, A, B)) {
          const ha = H[A];
          const hb = H[B];
          for (let v = 0; v < V; v++) {
            const val = ha[v] + hb[v];
            if (val < g[v]) g[v] = val;
          }
        }
        if (sub === 0) break;
      }
    }
    G[S] = g;
    if (S === full) break; // H[full] is never used
    const h = new Float64Array(V);
    for (let v = 0; v < V; v++) {
      let best = Infinity;
      const base = v * V;
      for (let u = 0; u < V; u++) {
        const gu = g[u];
        if (gu === Infinity) continue;
        const c = join[base + u];
        if (c === Infinity) continue;
        const val = gu + c;
        if (val < best) best = val;
      }
      h[v] = best;
    }
    H[S] = h;
  }

  const gFull = G[full];
  let optimum = Infinity;
  for (let v = 0; v < V; v++) if (gFull[v] < optimum) optimum = gFull[v];

  if (!Number.isFinite(optimum)) {
    return {
      status: 'infeasible',
      message: '在给定的状态代价和锁定约束下，没有任何树可以被完整定价。请检查代价表或锁定组合。',
      V,
      lockFeasible: false,
    };
  }

  // ---- enumerate every optimal rooted topology (guided, capped)
  const childStateCache = new Map();
  function childStates(A, v) {
    const key = A * V + v;
    const hit = childStateCache.get(key);
    if (hit) return hit;
    const target = H[A][v];
    const arr = [];
    if (Number.isFinite(target)) {
      const base = v * V;
      const g = G[A];
      for (let u = 0; u < V; u++) {
        const gu = g[u];
        if (gu === Infinity) continue;
        const c = join[base + u];
        if (c === Infinity) continue;
        if (Math.abs(gu + c - target) <= tol(target)) arr.push(u);
      }
    }
    childStateCache.set(key, arr);
    return arr;
  }

  // Enumerate optimal topologies. Each subproblem returns at most `maxTies`
  // distinct shapes; a subproblem that hits that cap sets `truncatedAny`.
  // Deduplication is by canonical signature at every level, so root placement
  // variants that produce the same shape are collapsed honestly and reported
  // via `unrootedSignature` later.
  const topoMemo = new Map();
  let visitedNodes = 0;
  let truncatedAny = false;

  const sig = (t) => (typeof t === 'string' ? t : `(${sig(t[0])},${sig(t[1])})`);

  function topologiesAt(S, v) {
    if (popcount(S) === 1) return [bitToTaxon.get(S)];
    const key = S * V + v;
    const memo = topoMemo.get(key);
    if (memo) return memo;
    visitedNodes++;
    const g = G[S][v];
    const out = [];
    const seen = new Set();
    if (Number.isFinite(g)) {
      const anchor = S & -S;
      const rest = S ^ anchor;
      for (let sub = (rest - 1) & rest; ; sub = (sub - 1) & rest) {
        const A = sub | anchor;
        const B = S ^ A;
        if (B !== 0 && A !== S && splitAllowed(S, A, B)) {
          const ha = H[A][v];
          const hb = H[B][v];
          if (Number.isFinite(ha) && Number.isFinite(hb) && Math.abs(ha + hb - g) <= tol(g)) {
            const us = childStates(A, v);
            const ws = childStates(B, v);
            for (const u of us) {
              const lefts = topologiesAt(A, u);
              for (const w of ws) {
                const rights = topologiesAt(B, w);
                for (const L of lefts) {
                  for (const R of rights) {
                    const t = [L, R];
                    const sg = sig(t);
                    if (seen.has(sg)) continue;
                    seen.add(sg);
                    out.push(t);
                    if (out.length >= maxTies) {
                      truncatedAny = true;
                      break;
                    }
                  }
                  if (out.length >= maxTies) break;
                }
                if (out.length >= maxTies) break;
              }
              if (out.length >= maxTies) break;
            }
          }
        }
        if (sub === 0) break;
        if (out.length >= maxTies) break;
      }
    }
    topoMemo.set(key, out);
    return out;
  }

  const trees = [];
  const seenGlobal = new Set();
  for (let v = 0; v < V; v++) {
    if (Math.abs(gFull[v] - optimum) > tol(optimum)) continue;
    for (const t of topologiesAt(full, v)) {
      const sg = sig(t);
      if (seenGlobal.has(sg)) continue;
      seenGlobal.add(sg);
      trees.push(t);
      if (trees.length >= maxTies) {
        truncatedAny = true;
        break;
      }
    }
    if (trees.length >= maxTies) break;
  }
  return {
    status: 'optimal',
    optimum,
    trees,
    tiesComplete: !truncatedAny,
    tieNodeVisits: visitedNodes,
    V,
    rootStates: (() => {
      const rs = [];
      for (let v = 0; v < V; v++) if (Math.abs(gFull[v] - optimum) <= tol(optimum)) rs.push(parts[v]);
      return rs;
    })(),
    lockFeasible: true,
  };
}
