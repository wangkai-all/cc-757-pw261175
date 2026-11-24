/**
 * Solve orchestrator: validation, lock compilation, exact vs local search,
 * equal-cost structure grouping, independent cross-check and diagnostics.
 *
 * Nothing here claims a biological relationship. All reporting is about the
 * cost of a character matrix on a tree-shaped grouping.
 */
import { validateDataset } from '../../shared/validate.js';
import { makePricingContext, priceTopology, annotateTree, topologySignature, unrootedSignature, maskToTaxa, cladeMasks } from './tree.js';
import { solveExactDp, EPS } from './dp.js';
import { localSearch } from './localSearch.js';
import { enumerateSmall } from './enumerate.js';
import { lowerBound, gapOf, certificate } from './bounds.js';
import { popcount } from './bitset.js';

const tol = (x) => EPS * Math.max(1, Math.abs(x));

function attachObserved(ctx, dataset) {
  for (const feature of ctx.features) {
    feature.observedIndices = [];
    const fi = dataset.features.findIndex((f) => f.id === feature.id);
    for (const taxon of ctx.taxonIds) {
      const row = dataset.matrix[taxon] || [];
      const v = row[fi];
      if (v === null || v === undefined) continue;
      const idx = feature.index.get(v);
      if (idx !== undefined) feature.observedIndices.push(idx);
    }
  }
}

/** Compile validated locks to masks; returns proper-subset lock masks only. */
export function compileLocks(locks, taxonIds) {
  const index = new Map(taxonIds.map((t, i) => [t, i]));
  const masks = [];
  const details = [];
  for (const lock of locks) {
    let mask = 0;
    for (const t of lock.taxa) mask |= 1 << index.get(t);
    if (mask === (1 << taxonIds.length) - 1) {
      details.push({ id: lock.id, mask, trivial: true, reason: '整个样品集合，根分支已满足' });
      continue;
    }
    if (popcount(mask) < 2) {
      details.push({ id: lock.id, mask, trivial: true, reason: '单个样品，任意树都满足' });
      continue;
    }
    masks.push(mask);
    details.push({ id: lock.id, mask, taxa: lock.taxa, trivial: false });
  }
  return { masks, details };
}

function sizeEstimate(dataset, V) {
  const n = dataset.taxonIds.length;
  const sets = 2 ** n;
  return { n, V, cells: sets * V, splits: 3 ** n };
}

export function exactEligible(dataset, V) {
  const n = dataset.taxonIds.length;
  if (n > 14) return { ok: false, reason: `样品数 ${n} 超过精确动态规划上限（14）。` };
  const cells = 2 ** n * V;
  if (cells > 4_000_000) {
    return { ok: false, reason: `精确表规模 ${cells.toLocaleString()} 个格子超过上限 4,000,000。` };
  }
  const work = 3 ** n * V;
  if (work > 3e8) {
    return { ok: false, reason: `精确求解预计运算量 ${(work / 1e6).toFixed(1)}M 超过上限。` };
  }
  return { ok: true };
}

function groupTies(ties, ctx, dataset, maxAnnotate = 40) {
  const groups = new Map();
  const rows = [];
  for (let i = 0; i < ties.length; i++) {
    const tree = ties[i];
    const sig = topoKey(tree);
    const usig = unrootedSignature(tree, ctx.taxonIndex);
    const row = {
      index: i,
      signature: sig,
      unrootedSignature: usig,
      total: null,
      perFeature: null,
      tree,
      annotation: null,
    };
    if (i < maxAnnotate) {
      const ann = annotateTree(tree, ctx);
      row.total = ann.total;
      row.perFeature = ann.perFeature;
      row.annotation = ann;
    } else {
      const p = priceTopology(tree, ctx);
      row.total = p.valid ? p.total : null;
      row.perFeature = p.valid ? p.perFeature : null;
    }
    if (!groups.has(usig)) {
      groups.set(usig, { unrootedSignature: usig, rootedVariants: [], indices: [], cost: row.total });
    }
    const g = groups.get(usig);
    g.rootedVariants.push(i);
    g.indices.push(i);
    rows.push(row);
  }
  return {
    rows,
    groups: [...groups.values()],
    annotatedCount: Math.min(ties.length, maxAnnotate),
  };
}

function topoKey(tree) {
  return topologySignature(tree);
}

/**
 * @param {object} dataset raw dataset
 * @param {object} options { method: 'auto'|'exact'|'local', seed, maxTies, ... }
 */
export function solveDataset(dataset, options = {}) {
  const started = Date.now();
  const validation = validateDataset(dataset);
  const base = {
    requestId: options.requestId || null,
    datasetId: dataset && dataset.id ? dataset.id : null,
    validation: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      infos: validation.infos || [],
    },
  };
  if (!validation.ok) {
    return { ...base, ok: false, status: 'invalid-input', diagnostics: diagnosticsFor(validation, dataset) };
  }

  const normalized = {
    ...dataset,
    taxonIds: validation.taxonIds,
    features: validation.features,
    matrix: validation.matrix,
  };
  const ctx = makePricingContext(normalized);
  attachObserved(ctx, normalized);
  const locks = compileLocks(validation.locks, validation.taxonIds);
  const lockMasks = locks.masks;
  const n = validation.taxonIds.length;
  const V = ctx.features.reduce((a, f) => a * f.K, 1);
  const estimate = sizeEstimate(normalized, V);
  const eligibility = exactEligible(normalized, V);

  let method = options.method || 'auto';
  if (method === 'auto') method = eligibility.ok ? 'exact' : 'local';
  if (method === 'exact' && !eligibility.ok) {
    return {
      ...base,
      ok: false,
      status: 'too-large',
      message: `无法按要求用精确方法求解：${eligibility.reason}`,
      estimate,
      diagnostics: [
        {
          level: 'error',
          code: 'exact-too-large',
          message: `精确方法不可用：${eligibility.reason} 请改用局部搜索；局部搜索的结果会标注为“找到的最好树”，并附可核对下界。`,
        },
      ],
    };
  }

  const bound = lowerBound(ctx);

  let search;
  let ties = [];
  let tiesComplete = true;
  let tieNote = '';
  if (method === 'exact') {
    const t0 = Date.now();
    const exact = solveExactDp(ctx, validation.taxonIds, lockMasks, {
      maxTies: options.maxTies ?? 400,
      maxTieNodes: options.maxTieNodes ?? 500000,
    });
    if (exact.status === 'too-large') {
      return {
        ...base,
        ok: false,
        status: 'too-large',
        message: exact.message,
        diagnostics: [{ level: 'error', code: 'exact-too-large', message: exact.message }],
      };
    }
    if (exact.status === 'infeasible') {
      return {
        ...base,
        ok: true,
        status: 'infeasible',
        message: exact.message,
        locks: locks.details,
        diagnostics: [
          {
            level: 'error',
            code: 'no-feasible-tree',
            message:
              exact.message +
              ' 常见的具体原因：某些锁定组合在数据/代价表下无法同时成立，或某个特征缺少把观测状态连起来的转移代价。',
          },
        ],
        estimate,
      };
    }
    search = {
      method: 'exact',
      status: 'optimal',
      optimum: exact.optimum,
      elapsedMs: Date.now() - t0,
      tieNodeVisits: exact.tieNodeVisits,
      tiesComplete: exact.tiesComplete,
      V,
      rootStates: exact.rootStates,
    };
    ties = exact.trees;
    tiesComplete = exact.tiesComplete;
    if (!exact.tiesComplete) {
      tieNote = `最优拓扑可能多于已列出的 ${ties.length} 个；为避免界面卡死已在 ${exact.tieNodeVisits.toLocaleString()} 次回溯后截断。`;
    }
  } else {
    const ls = localSearch(ctx, validation.taxonIds, lockMasks, {
      seed: options.seed ?? 12345,
      restarts: options.restarts ?? 10,
      maxIterations: options.maxIterations ?? 5000,
      maxMillis: options.maxMillis ?? 3500,
    });
    search = {
      method: 'local',
      status: 'best-found',
      bestCost: ls.bestCost,
      lowerBound: ls.lowerBound,
      gap: ls.gap,
      provenOptimal: ls.provenOptimal,
      iterations: ls.iterations,
      evaluations: ls.evaluations,
      restarts: ls.restarts,
      stopReason: ls.stopReason,
      elapsedMs: ls.elapsedMs,
      seed: ls.seed,
      note: ls.note,
      V,
    };
    if (ls.best) ties = [ls.best];
    tiesComplete = false;
    tieNote =
      '局部搜索只返回找到的最好树，未枚举其余等代价结构；要列出等代价结构，请在可枚举规模内改用精确方法。';
  }

  if (!ties.length) {
    return {
      ...base,
      ok: true,
      status: 'infeasible',
      message: '没有找到满足锁定约束且可完整定价的树。',
      locks: locks.details,
      diagnostics: [
        {
          level: 'error',
          code: 'no-tree',
          message: '锁定约束与代价表组合下没有可行树；请查看锁定说明与缺失代价。',
        },
      ],
      estimate,
    };
  }

  const bestTree = ties[0];
  const annotation = annotateTree(bestTree, ctx);
  const tieInfo = groupTies(ties, ctx, normalized, options.maxAnnotate ?? 40);

  // Independent cross-check on small samples, with the same lock masks.
  let crossCheck = null;
  if (n <= 7) {
    const enumResult = enumerateSmall(ctx, validation.taxonIds, lockMasks, { maxTies: 2000 });
    if (enumResult.status === 'complete') {
      const agrees = Math.abs(enumResult.bestCost - annotation.total) <= tol(annotation.total);
      crossCheck = {
        method: 'exhaustive-enumeration',
        enumeratedTopologies: enumResult.enumerated,
        pricedTopologies: enumResult.priced,
        bestCost: enumResult.bestCost,
        tieCount: enumResult.tieCount,
        agrees,
        note: agrees
          ? `独立枚举 ${enumResult.enumerated.toLocaleString()} 个树形，最好代价与主导求解器一致（${enumResult.bestCost}）。`
          : `独立枚举得到的最好代价 ${enumResult.bestCost} 与主导求解器 ${annotation.total} 不一致，请把这组输入保留为问题样例。`,
      };
    } else if (enumResult.status === 'infeasible') {
      crossCheck = {
        method: 'exhaustive-enumeration',
        status: 'infeasible',
        agrees: false,
        note: '独立枚举在锁定约束下找不到可定价的树。',
      };
    }
  }

  const lower = bound.total;
  const provenByBound = certificate(annotation.total, lower);
  const proof = {
    exact: search.method === 'exact',
    lowerBound: lower,
    boundPerFeature: bound.perFeature,
    gap: gapOf(annotation.total, lower),
    provenOptimal: search.method === 'exact' ? true : provenByBound,
    statement:
      search.method === 'exact'
        ? '最优性来自对全部拓扑的精确动态规划（锁定约束在搜索内生效），不是局部搜索结果。'
        : provenByBound
          ? '局部搜索的最好代价达到可核对下界，因此在该松弛下已证明最优。'
          : '这只是本次局部搜索找到的最好树，不是全局最优声明；下界与差额列在上方。',
  };

  const diagnostics = diagnosticsFor(validation, dataset, {
    annotation,
    lockDetails: locks.details,
    n,
    ctx,
    crossCheck,
    search,
    tiesComplete,
    tieCount: ties.length,
    tieGroups: tieInfo.groups,
  });

  return {
    ...base,
    ok: true,
    status: 'solved',
    estimate,
    method: search.method,
    search,
    locks: locks.details,
    taxa: validation.taxa,
    features: validation.features.map((f) => ({
      id: f.id,
      name: f.name,
      ordered: f.ordered,
      states: f.states,
    })),
    result: {
      total: annotation.total,
      tree: bestTree,
      annotation,
      perFeature: annotation.perFeature,
      ties: tieInfo.rows,
      tieGroups: tieInfo.groups,
      tieCount: ties.length,
      tiesComplete,
      tieNote,
      distinctUnrooted: tieInfo.groups.length,
    },
    proof,
    crossCheck,
    diagnostics,
    stats: validation.stats,
    elapsedMs: Date.now() - started,
  };
}

function diagnosticsFor(validation, dataset, extra) {
  const out = [];
  for (const e of validation.errors || []) out.push({ level: 'error', ...e });
  for (const w of validation.warnings || []) out.push({ level: 'warning', ...w });
  for (const i of validation.infos || []) out.push({ level: 'info', ...i });
  if (!extra) return out;

  const { n, ctx, annotation, lockDetails, crossCheck, search, tiesComplete, tieCount, tieGroups } = extra;

  if (n === 2) {
    out.push({
      level: 'info',
      code: 'two-taxa',
      message: '只有两个样品，只有一种（无根）树形；任何“分支关系”都只是把这两个样品连起来，没有额外结构可比较。',
    });
  }
  if (n === 3) {
    out.push({
      level: 'info',
      code: 'three-taxa',
      message: '三个样品时无根树形只有一种；不同根位置会产生不同的有根表示，但未根化结构相同。',
    });
  }

  for (const d of lockDetails || []) {
    if (d.trivial) {
      out.push({
        level: 'info',
        code: 'lock-trivial',
        message: `锁定 ${d.id} 不缩小可行树集合：${d.reason}。`,
      });
    }
  }

  if (ctx) {
    for (const f of ctx.features) {
      const observed = new Set(f.observedIndices);
      if (observed.size === 0) {
        out.push({
          level: 'warning',
          code: 'feature-no-data',
          message: `特征「${f.name}」没有任何观测值，对任何树的代价都是 0，不能支持分支。`,
        });
      } else if (observed.size === 1) {
        out.push({
          level: 'info',
          code: 'feature-one-state',
          message: `特征「${f.name}」在所有样品上只有一种观测状态，对树形没有区分作用，代价恒为 0。`,
        });
      }
    }
    if (ctx.features.length > 0 && ctx.features.every((f) => new Set(f.observedIndices).size <= 1)) {
      out.push({
        level: 'warning',
        code: 'data-uninformative',
        message:
          '所有特征在所有样品上都没有变化：每一棵树的代价都为 0，等代价结构是全部可能树形，数据不足以区分任何分支。',
      });
    }
  }

  if (annotation) {
    for (const [fid, row] of Object.entries(annotation.perFeature)) {
      if (row.cost === null) {
        out.push({
          level: 'error',
          code: 'feature-unpriced',
          featureId: fid,
          message: row.message || `特征 ${fid} 无法定价。`,
        });
      }
    }
    const missingCount = Object.values(annotation.featureNodeStates || {}).reduce(
      (acc, map) => acc + Object.values(map).filter((v) => v === null).length,
      0,
    );
    if (missingCount > 0) {
      out.push({
        level: 'info',
        code: 'missing-wildcard',
        message: `这棵树上有 ${missingCount} 个样品/特征格子是缺失值；它们按“未观测”处理，不参与状态标注、也不产生代价，没有当作新类别。`,
      });
    }
  }

  if (search && search.method === 'local' && !search.provenOptimal) {
    out.push({
      level: 'warning',
      code: 'local-not-global',
      message: `求解器用的是局部搜索：当前最好代价 ${search.bestCost}，可核对下界 ${search.lowerBound ?? '—'}，差额 ${
        search.gap ?? '—'
      }。请把它读作“找到的最好树”，不是全局最优。`,
    });
  }

  if (crossCheck && crossCheck.agrees === false) {
    out.push({
      level: 'error',
      code: 'crosscheck-mismatch',
      message: crossCheck.note,
    });
  }

  if (tieCount > 1) {
    const groupCount = tieGroups ? tieGroups.length : 0;
    out.push({
      level: 'info',
      code: 'ties',
      message:
        `共有 ${tieCount} 个有根树形取得相同总代价` +
        (groupCount ? `，它们归为 ${groupCount} 个不同的未根化结构（其余差异只是根的位置）` : '') +
        (tiesComplete ? '。' : '（列表已截断，可能还有更多）。'),
    });
  }

  return out;
}

export { maskToTaxa, cladeMasks, gapOf };
