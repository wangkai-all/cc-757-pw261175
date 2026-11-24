/**
 * Lock (共同分支) helpers shared by the browser and the solver.
 *
 * A lock names a set of samples that must form an exact clade in the tree:
 * there must be one branch whose descendant samples are exactly that set.
 * Locks therefore have to be laminar (any two are disjoint or nested);
 * otherwise no tree can satisfy them and the solver must say so up front.
 *
 * These helpers deliberately contain no inference logic, only structural
 * checks and human-readable explanations.
 */

export function sortedTaxa(taxa) {
  return [...taxa].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function cladeKey(taxa) {
  return sortedTaxa(taxa).join('|');
}

/**
 * Structural validation of the lock list.
 * @param {Array<{id?:string,taxa:string[],note?:string}>} constraints
 * @param {string[]} taxonIds
 * @returns {{errors:Array, warnings:Array, infos:Array, locks:Array, valid:boolean}}
 */
export function validateLocks(constraints, taxonIds) {
  const known = new Set(taxonIds);
  const errors = [];
  const warnings = [];
  const infos = [];
  const seen = new Map();
  const locks = [];

  const list = Array.isArray(constraints) ? constraints : [];
  list.forEach((raw, index) => {
    const id = raw && raw.id ? String(raw.id) : `L${index + 1}`;
    const taxaRaw = Array.isArray(raw && raw.taxa) ? raw.taxa.map(String) : [];
    const duplicates = taxaRaw.filter((t, i) => taxaRaw.indexOf(t) !== i);
    const unknown = taxaRaw.filter((t) => !known.has(t));
    const unique = [...new Set(taxaRaw)];
    const key = cladeKey(unique);
    const lock = {
      id,
      taxa: sortedTaxa(unique),
      key,
      note: raw && raw.note ? String(raw.note) : '',
      trivial: false,
      duplicateOf: null,
    };

    if (unique.length === 0) {
      errors.push({
        code: 'lock-empty',
        lockId: id,
        message: `锁定 ${id} 没有样品：至少要选两个样品才能形成共同分支。`,
      });
      return;
    }
    if (unknown.length) {
      errors.push({
        code: 'lock-unknown-taxa',
        lockId: id,
        message: `锁定 ${id} 引用了不存在的样品：${unknown.join('、')}。`,
      });
      return;
    }
    if (duplicates.length) {
      warnings.push({
        code: 'lock-duplicate-taxa',
        lockId: id,
        message: `锁定 ${id} 中重复列出了 ${[...new Set(duplicates)].join('、')}；重复项已合并。`,
      });
    }
    if (unique.length === 1) {
      lock.trivial = true;
      infos.push({
        code: 'lock-single-taxon',
        lockId: id,
        message: `锁定 ${id} 只有一个样品，任何树都满足；它不构成有意义的共同分支约束。`,
      });
      return;
    }
    if (unique.length === taxonIds.length) {
      lock.trivial = true;
      infos.push({
        code: 'lock-all-taxa',
        lockId: id,
        message: `锁定 ${id} 包含全部样品，根分支总是满足它；该锁定不缩小可行树集合。`,
      });
    }
    if (seen.has(key)) {
      lock.duplicateOf = seen.get(key);
      warnings.push({
        code: 'lock-duplicate',
        lockId: id,
        message: `锁定 ${id} 与 ${seen.get(key)} 的样品集合相同，只保留一次。`,
      });
      return;
    }
    seen.set(key, id);
    locks.push(lock);
  });

  // Pairwise laminarity: overlapping, mutually non-nested sets cannot both be
  // exact clades. This is the main "互相矛盾" case and deserves a concrete
  // explanation naming both locks and the offending samples.
  for (let i = 0; i < locks.length; i++) {
    for (let j = i + 1; j < locks.length; j++) {
      const a = locks[i];
      const b = locks[j];
      if (a.trivial || b.trivial) continue;
      const sa = new Set(a.taxa);
      const sb = new Set(b.taxa);
      const inter = a.taxa.filter((t) => sb.has(t));
      if (inter.length === 0) continue;
      const aInB = a.taxa.every((t) => sb.has(t));
      const bInA = b.taxa.every((t) => sa.has(t));
      if (aInB || bInA) continue;
      const onlyA = a.taxa.filter((t) => !sb.has(t));
      const onlyB = b.taxa.filter((t) => !sa.has(t));
      errors.push({
        code: 'lock-overlap',
        lockIds: [a.id, b.id],
        message:
          `锁定 ${a.id}={${a.taxa.join('、')}} 与 ${b.id}={${b.taxa.join('、')}} 相交但不互相包含` +
          `（共有 ${inter.join('、')}，${a.id} 独有 ${onlyA.join('、')}，${b.id} 独有 ${onlyB.join('、')}）。` +
          '一棵树的两个共同分支不可能这样相交，因此这些锁定无法同时满足。',
      });
    }
  }

  return { errors, warnings, infos, locks, valid: errors.length === 0 };
}

/**
 * Is `set` an exact clade of `clades` (each clade is a sorted taxon array)?
 * The root clade (all taxa) counts.
 */
export function isExactClade(set, clades) {
  const key = cladeKey(set);
  return clades.some((c) => cladeKey(c) === key);
}
