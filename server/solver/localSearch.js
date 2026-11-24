/**
 * Local search over rooted topologies, with an explicit, checkable lower bound.
 *
 * Moves are nearest-neighbour interchanges (NNI), plus a regraft move for leaf
 * positions under lock constraints. Every candidate is priced exactly, and
 * every generated candidate must satisfy the lock set; a move that would break
 * a lock is rejected before it is scored. The search is deterministic given the
 * seed.
 *
 * The result is explicitly *not* called globally optimal. It is reported as
 * "best found", together with the lower bound and the remaining gap. Only when
 * the gap is zero may the UI/statement say the value is proven optimal.
 */
import { priceTopology, isLeaf, topologySignature, leafTaxa } from './tree.js';
import { lowerBound, gapOf, certificate } from './bounds.js';
import { mulberry32, shuffleInPlace } from './util.js';

const EPS = 1e-9;

/** All clade masks of a topology. */
import { cladeMasks } from './tree.js';

export function feasibleUnderLocks(tree, ctx, lockMasks) {
  const sets = new Set(cladeMasks(tree, ctx.taxonIndex));
  for (const L of lockMasks) {
    if (!sets.has(L)) return false;
  }
  return true;
}

function cloneTree(t) {
  return isLeaf(t) ? t : [cloneTree(t[0]), cloneTree(t[1])];
}

function nodeAtPath(tree, path) {
  let node = tree;
  for (const dir of path) node = node[dir];
  return node;
}

/** Deep copy of `tree` with the node at `path` replaced by make(node). */
function replaceAtPath(tree, path, make) {
  if (path.length === 0) return make(tree);
  const [dir, ...rest] = path;
  const copy = [cloneTree(tree[0]), cloneTree(tree[1])];
  copy[dir] = replaceAtPath(tree[dir], rest, make);
  return copy;
}

/** Every internal node's path (root has path [], children get 0/1 suffixes). */
function internalPaths(tree, path = [], out = []) {
  if (isLeaf(tree)) return out;
  out.push({ path, node: tree });
  internalPaths(tree[0], [...path, 0], out);
  internalPaths(tree[1], [...path, 1], out);
  return out;
}

/**
 * NNI neighbours on rooted binary trees.
 *
 * For every internal node X at path P (P non-empty, so X has a parent and a
 * sibling Y), and for each child Z of X (the other child A stays in place),
 * exchange Z with Y:
 *
 *     parent(X=[A,Z], Y)  ->  parent([A,Y], Z)
 *
 * Both variants (Z = X[0] and Z = X[1]) are generated, then deduplicated by
 * canonical signature. Every result has the same leaf set as the input.
 */
export function nniNeighbours(tree) {
  const out = [];
  const internals = internalPaths(tree);
  for (const { path } of internals) {
    if (path.length === 0) continue; // root has no sibling
    const parentPath = path.slice(0, -1);
    const childDir = path[path.length - 1];
    const parent = nodeAtPath(tree, parentPath);
    const sibling = parent[1 - childDir];
    const node = nodeAtPath(tree, path);
    for (const zDir of [0, 1]) {
      const z = node[zDir];
      const a = node[1 - zDir];
      const replaced = replaceAtPath(tree, parentPath, () => [
        [cloneTree(a), cloneTree(sibling)],
        cloneTree(z),
      ]);
      out.push(replaced);
    }
  }
  return out;
}

/** All unrooted-visible NNI moves, deduped by signature. */
export function uniqueNni(tree) {
  const seen = new Set([topologySignature(tree)]);
  const out = [];
  for (const t of nniNeighbours(tree)) {
    const s = topologySignature(t);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(t);
  }
  return out;
}

/**
 * Leaf-regraft neighbours: detach one leaf and reattach it on any other edge.
 * This explores a slightly larger neighbourhood than NNI and helps when locks
 * make the topology space lumpy.
 */
export function regraftNeighbours(tree) {
  const taxa = leafTaxa(tree);
  const out = [];
  for (const taxon of taxa) {
    // remove leaf
    const removed = removeLeaf(tree, taxon);
    if (!removed) continue;
    const edges = [];
    collectEdges(removed, edges);
    for (const edgePath of edges) {
      const t = insertLeaf(removed, edgePath, taxon);
      if (t) out.push(t);
    }
  }
  return out;
}

function removeLeaf(tree, taxon) {
  if (isLeaf(tree)) return null;
  const rec = (node) => {
    if (isLeaf(node)) return { node, removed: false };
    if (isLeaf(node[0]) && node[0] === taxon) return { node: cloneTree(node[1]), removed: true };
    if (isLeaf(node[1]) && node[1] === taxon) return { node: cloneTree(node[0]), removed: true };
    const l = rec(node[0]);
    const r = rec(node[1]);
    if (!l.removed && !r.removed) return { node, removed: false };
    return { node: [l.node, r.node], removed: true };
  };
  const res = rec(tree);
  return res.removed ? res.node : null;
}

function collectEdges(tree, out, path = []) {
  if (isLeaf(tree)) return;
  out.push({ path: [...path] });
  if (!isLeaf(tree[0])) collectEdges(tree[0], out, [...path, 0]);
  if (!isLeaf(tree[1])) collectEdges(tree[1], out, [...path, 1]);
}

function insertLeaf(tree, { path }, taxon) {
  const rec = (node, depth) => {
    if (depth === path.length) {
      return [cloneTree(node), taxon];
    }
    if (isLeaf(node)) return node;
    const dir = path[depth];
    const copy = [cloneTree(node[0]), cloneTree(node[1])];
    copy[dir] = rec(node[dir], depth + 1);
    return copy;
  };
  return rec(tree, 0);
}

/**
 * Search. Starts from several deterministic starting trees (balanced ladder
 * plus random starts), then hill-climbs with NNI/regraft moves that respect
 * locks, keeping the best. Repeats with random restarts until the iteration
 * budget is spent or the lower bound is met.
 */
export function localSearch(ctx, taxonIds, lockMasks, opts = {}) {
  const {
    seed = 12345,
    restarts = 8,
    maxIterations = 4000,
    maxMillis = 3000,
    useRegraft = true,
  } = opts;
  const rng = mulberry32(seed);
  const started = Date.now();
  const bound = lowerBound(ctx);

  const priceCache = new Map();
  function evaluate(tree) {
    const s = topologySignature(tree);
    if (priceCache.has(s)) return priceCache.get(s);
    const priced = priceTopology(tree, ctx);
    const row = { sig: s, priced, cost: priced.valid ? priced.total : Infinity };
    priceCache.set(s, row);
    return row;
  }

  let best = null;
  let iterations = 0;
  let evaluations = 0;
  let restartsDone = 0;
  let stopReason = 'budget';

  const startPool = startingTrees(taxonIds, lockMasks, ctx, rng);

  for (let r = 0; r < restarts; r++) {
    if (Date.now() - started > maxMillis) {
      stopReason = 'time';
      break;
    }
    let current = startPool[r % startPool.length];
    if (!current) break;
    if (!feasibleUnderLocks(current, ctx, lockMasks)) {
      // The deterministic starts are not lock-aware; repair them by moving to
      // the nearest feasible neighbour before climbing.
      const repaired = repairToLocks(current, ctx, lockMasks, rng);
      if (!repaired) continue;
      current = repaired;
    }
    let currentEval = evaluate(current);
    if (!Number.isFinite(currentEval.cost)) {
      continue;
    }
    let improved = true;
    while (improved && iterations < maxIterations) {
      if (Date.now() - started > maxMillis) {
        stopReason = 'time';
        improved = false;
        break;
      }
      improved = false;
      const candidates = uniqueNni(current);
      if (useRegraft) candidates.push(...regraftNeighbours(current));
      shuffleInPlace(candidates, rng);
      let localBest = current;
      let localBestEval = currentEval;
      for (const cand of candidates) {
        if (iterations >= maxIterations) {
          stopReason = 'iterations';
          break;
        }
        iterations++;
        if (!feasibleUnderLocks(cand, ctx, lockMasks)) continue;
        const ev = evaluate(cand);
        evaluations++;
        if (ev.cost < localBestEval.cost - EPS) {
          localBest = cand;
          localBestEval = ev;
          break;
        }
      }
      if (localBest !== current) {
        current = localBest;
        currentEval = localBestEval;
        improved = true;
      }
    }
    restartsDone++;
    if (best === null || currentEval.cost < best.cost - EPS) {
      best = { tree: current, cost: currentEval.cost, priced: currentEval.priced };
    }
    if (bound.total !== null && certificate(best.cost, bound.total)) {
      stopReason = 'bound-met';
      break;
    }
    if (iterations >= maxIterations) {
      stopReason = 'iterations';
      break;
    }
  }

  const boundTotal = bound.total;
  const gap = gapOf(best ? best.cost : null, boundTotal);
  const proven = best ? certificate(best.cost, boundTotal) : false;

  return {
    status: 'best-found',
    best: best ? best.tree : null,
    bestCost: best ? best.cost : null,
    bestPriced: best ? best.priced : null,
    lowerBound: boundTotal,
    boundPerFeature: bound.perFeature,
    gap,
    provenOptimal: proven,
    iterations,
    evaluations,
    restarts: restartsDone,
    stopReason,
    elapsedMs: Date.now() - started,
    seed,
    note: proven
      ? '本次搜索的最好代价等于可核对下界，因此该代价在搜索空间内已被证明最优。'
      : '这是本次搜索找到的最好树，不是全局最优的声明；下界与差额见上。',
  };
}

/**
 * Greedy repair: repeatedly apply the cheapest-cost feasible neighbour until
 * the lock set holds. Returns null when no feasible neighbour exists (the
 * starting point is then skipped).
 */
function repairToLocks(tree, ctx, lockMasks, rng) {
  let current = tree;
  for (let step = 0; step < 200; step++) {
    if (feasibleUnderLocks(current, ctx, lockMasks)) return current;
    const candidates = uniqueNni(current);
    candidates.push(...regraftNeighbours(current));
    shuffleInPlace(candidates, rng);
    let progressed = false;
    for (const cand of candidates) {
      if (!feasibleUnderLocks(cand, ctx, lockMasks)) continue;
      const p = priceTopology(cand, ctx);
      if (!p.valid) continue;
      current = cand;
      progressed = true;
      break;
    }
    if (!progressed) return null;
  }
  return feasibleUnderLocks(current, ctx, lockMasks) ? current : null;
}

/**
 * Deterministic starting topologies: a caterpillar in taxon order, a balanced
 * tree, and random joins. Any start that cannot be priced is skipped later.
 */
function startingTrees(taxonIds, lockMasks, ctx, rng) {
  const list = [];
  // caterpillar
  let cat = taxonIds[0];
  for (let i = 1; i < taxonIds.length; i++) cat = [cat, taxonIds[i]];
  list.push(cat);
  // balanced
  list.push(balanced(taxonIds));
  // random
  for (let k = 0; k < 6; k++) {
    const shuffled = [...taxonIds];
    shuffleInPlace(shuffled, rng);
    list.push(randomJoin(shuffled, rng));
  }
  return list;
}

export function balanced(ids) {
  if (ids.length === 1) return ids[0];
  const mid = Math.floor(ids.length / 2);
  return [balanced(ids.slice(0, mid)), balanced(ids.slice(mid))];
}

function randomJoin(ids, rng) {
  const pool = [...ids];
  while (pool.length > 1) {
    const i = Math.floor(rng() * pool.length);
    const a = pool.splice(i, 1)[0];
    const j = Math.floor(rng() * pool.length);
    const b = pool.splice(j, 1)[0];
    pool.push([a, b]);
  }
  return pool[0];
}
