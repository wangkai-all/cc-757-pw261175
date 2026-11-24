export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data && (data.error?.message || data.error || data.message)) || `请求失败（HTTP ${res.status}）`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return data;
}

export function debounce(fn, wait = 250) {
  let t = null;
  const wrapped = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  return wrapped;
}

export const fmt = (x, digits = 2) => {
  if (x === null || x === undefined) return '—';
  if (!Number.isFinite(x)) return '∞';
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toFixed(digits)));
};

export function newick(tree, labels = {}) {
  const enc = (s) => {
    const v = labels[s] || s;
    return /[\s(),:;']/.test(v) ? `'${String(v).replace(/'/g, "''")}'` : v;
  };
  const rec = (n) => (typeof n === 'string' ? enc(n) : `(${rec(n[0])},${rec(n[1])})`);
  return `${rec(tree)};`;
}

export function leavesOf(tree, out = []) {
  if (typeof tree === 'string') out.push(tree);
  else {
    leavesOf(tree[0], out);
    leavesOf(tree[1], out);
  }
  return out;
}

export function cloneTree(tree) {
  return typeof tree === 'string' ? tree : [cloneTree(tree[0]), cloneTree(tree[1])];
}

export function cladeKeys(tree) {
  const keys = [];
  const walk = (n) => {
    if (typeof n === 'string') return [n];
    const a = walk(n[0]);
    const b = walk(n[1]);
    const all = [...a, ...b].sort();
    keys.push(all.join('|'));
    return all;
  };
  walk(tree);
  return keys;
}

/** Unrooted splits (nontrivial) of a tree, as canonical pair keys. */
export function splitKeys(tree) {
  const leaves = leavesOf(tree).slice().sort();
  const index = new Map(leaves.map((t, i) => [t, i]));
  const full = (1n << BigInt(leaves.length)) - 1n;
  const splits = new Set();
  const walk = (n) => {
    if (typeof n === 'string') return 1n << BigInt(index.get(n));
    const m = walk(n[0]) | walk(n[1]);
    const other = full & ~m;
    const size = popcountBig(m);
    if (size >= 2 && leaves.length - size >= 2) {
      const a = m < other ? m : other;
      const b = m < other ? other : m;
      splits.add(`${a}/${b}`);
    }
    return m;
  };
  walk(tree);
  return [...splits].sort();
}

function popcountBig(x) {
  let n = 0;
  let v = x;
  while (v) {
    v &= v - 1n;
    n++;
  }
  return n;
}

export function maskToTaxa(mask, taxonIds) {
  const out = [];
  for (let i = 0; i < taxonIds.length; i++) if (mask & (1 << i)) out.push(taxonIds[i]);
  return out;
}

export function uniqueId(prefix, existing) {
  let i = 1;
  const set = new Set(existing);
  while (set.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

export const MISSING_LABEL = '未观测';

/** Nontrivial clade keys (size >= 2, excluding the full set), e.g. for diffs. */
export function cladeKeySet(tree) {
  const leaves = leavesOf(tree);
  if (!leaves.length) return new Set();
  const full = leaves.slice().sort().join('|');
  return new Set(cladeKeys(tree).filter((k) => k !== full && k.split('|').length >= 2));
}

export function treeDiff(treeA, treeB) {
  const a = cladeKeySet(treeA);
  const b = cladeKeySet(treeB);
  const onlyA = [...a].filter((k) => !b.has(k)).sort();
  const onlyB = [...b].filter((k) => !a.has(k)).sort();
  return { onlyA, onlyB, same: onlyA.length === 0 && onlyB.length === 0 };
}

export function formatCladeKey(key) {
  return `{${key.split('|').join('、')}}`;
}

/** Format an unrooted split key "a/b" (BigInt masks) as taxon sets. */
export function formatSplitKey(key, taxonIds) {
  const [a, b] = key.split('/');
  const taxa = (m) => {
    const v = BigInt(m);
    const out = [];
    for (let i = 0; i < taxonIds.length; i++) {
      if ((v >> BigInt(i)) & 1n) out.push(taxonIds[i]);
    }
    return out;
  };
  const left = taxa(a);
  const right = taxa(b);
  return `${left.join('、')} ⟷ ${right.join('、')}`;
}

/** Compare two trees by unrooted splits, returning readable differences. */
export function splitDiff(treeA, treeB, taxonIds) {
  const a = splitKeys(treeA);
  const b = splitKeys(treeB);
  const onlyA = a.filter((k) => !b.includes(k)).map((k) => formatSplitKey(k, taxonIds));
  const onlyB = b.filter((k) => !a.includes(k)).map((k) => formatSplitKey(k, taxonIds));
  return { onlyA, onlyB, same: onlyA.length === 0 && onlyB.length === 0 };
}
