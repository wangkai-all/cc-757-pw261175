/**
 * Dataset validation shared by the browser (live feedback) and the server
 * (authoritative check before solving). Messages are written for the person
 * editing the matrix: they say which cell / cost is wrong and what to do.
 */
import { validateLocks } from './locks.js';
import { parseCostKey, unorderedKey, orderedKey } from './cost.js';

const RESERVED_STATE_CHARS = /[|<>]/;

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isMissingValue(v) {
  return v === null || v === undefined;
}

/**
 * @param {any} dataset
 * @returns {{ok:boolean, errors:Array, warnings:Array, locks:Array, stats:Object}}
 */
export function validateDataset(dataset) {
  const errors = [];
  const warnings = [];
  const err = (code, message, path = '') => errors.push({ code, message, path });
  const warn = (code, message, path = '') => warnings.push({ code, message, path });

  if (!isPlainObject(dataset)) {
    err('dataset-shape', '数据集必须是一个 JSON 对象。');
    return { ok: false, errors, warnings, locks: [], stats: {} };
  }

  const taxaRaw = dataset.taxa;
  if (!Array.isArray(taxaRaw) || taxaRaw.length === 0) {
    err('taxa-missing', '数据集需要 taxa 数组，至少要有一个样品。', 'taxa');
    return { ok: false, errors, warnings, locks: [], stats: {} };
  }

  const taxonIds = [];
  const taxa = [];
  taxaRaw.forEach((t, i) => {
    if (!isPlainObject(t)) {
      err('taxon-shape', `第 ${i + 1} 个样品不是对象。`, `taxa[${i}]`);
      return;
    }
    const id = typeof t.id === 'string' ? t.id.trim() : '';
    if (!id) {
      err('taxon-id', `第 ${i + 1} 个样品缺少非空 id。`, `taxa[${i}].id`);
      return;
    }
    if (taxonIds.includes(id)) {
      err('taxon-duplicate', `样品 id「${id}」重复；每个样品必须有唯一的 id。`, `taxa[${i}].id`);
      return;
    }
    if (RESERVED_STATE_CHARS.test(id)) {
      warn('taxon-special-chars', `样品 id「${id}」含有 | < > 字符，导出 Newick 时会被转义。`, `taxa[${i}].id`);
    }
    taxonIds.push(id);
    taxa.push({ id, label: typeof t.label === 'string' && t.label.trim() ? t.label.trim() : id });
  });

  if (taxonIds.length < 2) {
    err('taxa-too-few', '至少需要 2 个样品才能构成一棵树；要有分支信息则需要 3 个或更多。');
  }

  const featuresRaw = dataset.features;
  if (!Array.isArray(featuresRaw) || featuresRaw.length === 0) {
    err('features-missing', '数据集需要 features 数组，至少一个特征。', 'features');
  }
  const features = [];
  const featureIds = [];

  if (Array.isArray(featuresRaw)) {
    featuresRaw.forEach((f, fi) => {
      const path = `features[${fi}]`;
      if (!isPlainObject(f)) {
        err('feature-shape', `第 ${fi + 1} 个特征不是对象。`, path);
        return;
      }
      const id = typeof f.id === 'string' ? f.id.trim() : '';
      if (!id) {
        err('feature-id', `第 ${fi + 1} 个特征缺少非空 id。`, `${path}.id`);
        return;
      }
      if (featureIds.includes(id)) {
        err('feature-duplicate', `特征 id「${id}」重复；每个特征的代价表必须分开存放。`, `${path}.id`);
        return;
      }
      const name = typeof f.name === 'string' && f.name.trim() ? f.name.trim() : id;
      const ordered = f.ordered === true;
      if (f.ordered !== undefined && typeof f.ordered !== 'boolean') {
        err('feature-ordered', `特征「${name}」的 ordered 必须是 true 或 false。`, `${path}.ordered`);
      }
      const statesRaw = Array.isArray(f.states) ? f.states : null;
      if (!statesRaw || statesRaw.length < 2) {
        err('feature-states', `特征「${name}」需要至少两个观测状态（缺失不算状态）。`, `${path}.states`);
        return;
      }
      const states = [];
      let statesOk = true;
      statesRaw.forEach((s, si) => {
        if (typeof s !== 'string' || !s.trim()) {
          err('state-name', `特征「${name}」的第 ${si + 1} 个状态不是非空字符串。`, `${path}.states[${si}]`);
          statesOk = false;
          return;
        }
        const st = s.trim();
        if (RESERVED_STATE_CHARS.test(st)) {
          err(
            'state-reserved',
            `特征「${name}」的状态「${st}」不能包含 | < > 字符（这些字符用于存储转移代价的键）。`,
            `${path}.states[${si}]`,
          );
          statesOk = false;
          return;
        }
        if (states.includes(st)) {
          err('state-duplicate', `特征「${name}」的状态「${st}」重复。`, `${path}.states[${si}]`);
          statesOk = false;
          return;
        }
        states.push(st);
      });
      if (!statesOk) return;

      const costsIn = isPlainObject(f.costs) ? f.costs : {};
      if (!isPlainObject(f.costs)) {
        err('costs-missing', `特征「${name}」需要 costs 对象，键形如「${states[0]}|${states[1]}」。`, `${path}.costs`);
      }
      const costs = {};
      let costsOk = true;
      for (const [rawKey, value] of Object.entries(costsIn)) {
        const parsed = parseCostKey(rawKey, ordered);
        if (!parsed) {
          err('cost-key', `特征「${name}」的代价键「${rawKey}」无法解析；请写成 A|B（无序）或 A>B（有序）。`, `${path}.costs.${rawKey}`);
          costsOk = false;
          continue;
        }
        if (!states.includes(parsed.a) || !states.includes(parsed.b)) {
          err(
            'cost-unknown-state',
            `特征「${name}」的代价键「${rawKey}」引用了未声明的状态；已声明状态：${states.join('、')}。`,
            `${path}.costs.${rawKey}`,
          );
          costsOk = false;
          continue;
        }
        if (parsed.a === parsed.b) {
          if (value !== 0) {
            err('cost-self', `特征「${name}」的「${rawKey}」是同一状态之间的转移，必须是 0。`, `${path}.costs.${rawKey}`);
            costsOk = false;
          }
          continue;
        }
        if (ordered && parsed.separator === '|') {
          err(
            'cost-separator',
            `特征「${name}」是有序特征，代价键「${rawKey}」请改成有方向的 A>B，以便两个方向分别保存。`,
            `${path}.costs.${rawKey}`,
          );
          costsOk = false;
          continue;
        }
        if (!ordered && parsed.separator === '>') {
          err(
            'cost-separator',
            `特征「${name}」是无序特征，代价键「${rawKey}」请改成 A|B；无序特征两个方向共用一份代价。`,
            `${path}.costs.${rawKey}`,
          );
          costsOk = false;
          continue;
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          err('cost-value', `特征「${name}」的代价「${rawKey}」必须是非负有限数字。`, `${path}.costs.${rawKey}`);
          costsOk = false;
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(costs, parsed.key)) {
          const prev = costs[parsed.key];
          if (ordered) {
            err('cost-duplicate', `特征「${name}」的转移「${parsed.key}」被声明了两次。`, `${path}.costs.${rawKey}`);
            costsOk = false;
          } else if (prev !== value) {
            err(
              'cost-asymmetric',
              `特征「${name}」是无序特征，但「${rawKey}」的两个写法给出了不同代价（${prev} 与 ${value}）；无序特征的转移必须对称。`,
              `${path}.costs.${rawKey}`,
            );
            costsOk = false;
          }
          continue;
        }
        costs[parsed.key] = value;
      }
      if (!costsOk) return;

      for (const row of unorderedOrDirectedPairs(states, ordered)) {
        if (!Object.prototype.hasOwnProperty.call(costs, row.key)) {
          warn(
            'cost-undef',
            `特征「${name}」的转移 ${row.label} 没有代价；若某棵树需要它，该树将无法定价。`,
            `${path}.costs`,
          );
        }
      }

      features.push({ id, name, ordered, states, costs });
      featureIds.push(id);
    });
  }

  // Matrix
  const matrix = {};
  const stats = {
    taxa: taxonIds.length,
    features: features.length,
    missingCells: 0,
    perFeatureMissing: {},
    perFeatureObserved: {},
  };
  for (const f of features) {
    stats.perFeatureMissing[f.id] = 0;
    stats.perFeatureObserved[f.id] = 0;
  }
  const matrixIn = isPlainObject(dataset.matrix) ? dataset.matrix : null;
  if (!matrixIn) {
    err('matrix-missing', '数据集需要 matrix 对象，把每个样品映射到与特征顺序一致的状态数组。', 'matrix');
  } else {
    taxonIds.forEach((tid) => {
      const row = matrixIn[tid];
      if (!Array.isArray(row)) {
        err('matrix-row', `样品「${tid}」在 matrix 中缺少状态数组。`, `matrix.${tid}`);
        return;
      }
      const cleaned = [];
      features.forEach((f, fi) => {
        if (fi >= row.length) {
          err('matrix-short', `样品「${tid}」的状态数组缺少特征「${f.name}」的位置。`, `matrix.${tid}[${fi}]`);
          cleaned.push(null);
          return;
        }
        const v = row[fi];
        if (isMissingValue(v)) {
          cleaned.push(null);
          stats.missingCells++;
          stats.perFeatureMissing[f.id]++;
          return;
        }
        if (typeof v !== 'string' || !f.states.includes(v)) {
          err(
            'matrix-state',
            `样品「${tid}」在特征「${f.name}」上的值 ${JSON.stringify(v)} 不是已声明状态（${f.states.join('、')}）；缺失请写 null。`,
            `matrix.${tid}[${fi}]`,
          );
          cleaned.push(null);
          return;
        }
        cleaned.push(v);
        stats.perFeatureObserved[f.id]++;
      });
      matrix[tid] = cleaned;
    });
    for (const key of Object.keys(matrixIn)) {
      if (!taxonIds.includes(key)) {
        warn('matrix-extra-row', `matrix 中的「${key}」不对应任何样品，已忽略。`, `matrix.${key}`);
      }
    }
  }

  // Features without any observation cannot inform the tree.
  for (const f of features) {
    if (stats.perFeatureMissing[f.id] === taxonIds.length) {
      warn(
        'feature-all-missing',
        `特征「${f.name}」在所有样品上都未观测，不会改变任何树的代价，也无法支持任何分支。`,
        'matrix',
      );
    }
  }

  const lockCheck = validateLocks(Array.isArray(dataset.constraints) ? dataset.constraints : [], taxonIds);
  errors.push(...lockCheck.errors);
  warnings.push(...lockCheck.warnings);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    infos: lockCheck.infos || [],
    locks: lockCheck.locks,
    taxa,
    taxonIds,
    features,
    matrix,
    stats,
  };
}

/** Enumerate every pair the cost editor should cover, for missing-cost warnings. */
function unorderedOrDirectedPairs(states, ordered) {
  const rows = [];
  if (ordered) {
    for (const a of states) {
      for (const b of states) {
        if (a !== b) rows.push({ key: orderedKey(a, b), label: `${a}→${b}` });
      }
    }
  } else {
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        rows.push({ key: unorderedKey(states[i], states[j]), label: `{${states[i]},${states[j]}}` });
      }
    }
  }
  return rows;
}

/**
 * Convert a feature between ordered and unordered storage, preserving as much
 * of the user's cost table as possible. Returns { feature, note, lost }.
 */
export function convertOrdering(feature, nextOrdered) {
  if (feature.ordered === nextOrdered) return { feature, note: null, lost: [] };
  const { states } = feature;
  const costs = {};
  const lost = [];
  if (nextOrdered) {
    for (let i = 0; i < states.length; i++) {
      for (let j = 0; j < states.length; j++) {
        if (i === j) continue;
        const a = states[i];
        const b = states[j];
        const cost = feature.costs[unorderedKey(a, b)];
        if (typeof cost === 'number') costs[orderedKey(a, b)] = cost;
      }
    }
    return {
      feature: { ...feature, ordered: true, costs },
      note: '已改为有序特征：原来的一份无序代价复制到了两个方向，可以分别修改。',
      lost,
    };
  }
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const a = states[i];
      const b = states[j];
      const ab = feature.costs[orderedKey(a, b)];
      const ba = feature.costs[orderedKey(b, a)];
      if (typeof ab === 'number' && typeof ba === 'number' && ab !== ba) {
        lost.push(`${a}→${b}=${ab}, ${b}→${a}=${ba}`);
        costs[unorderedKey(a, b)] = Math.min(ab, ba);
      } else if (typeof ab === 'number') {
        costs[unorderedKey(a, b)] = ab;
      } else if (typeof ba === 'number') {
        costs[unorderedKey(a, b)] = ba;
      }
    }
  }
  return {
    feature: { ...feature, ordered: false, costs },
    note: lost.length
      ? `已改为无序特征：以下方向代价不对称，已保留较便宜的方向（${lost.join('；')}），另一方向被移除。`
      : '已改为无序特征：每个状态对共用一份代价。',
    lost,
  };
}
