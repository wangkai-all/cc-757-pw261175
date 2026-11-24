/**
 * Discrete character transition costs.
 *
 * A state is an observed, user-declared category. A missing entry is NOT a
 * state: it never appears in feature.states, never gets a cost row, and never
 * labels an ancestral node. It means "unobserved" and contributes no cost.
 *
 * Costs belong to one feature. Unordered features store one canonical pair key
 * ("0|2"); ordered features store a direction ("0>2") so the two directions can
 * be priced differently.
 */

export const MISSING = null;
export const INF = Number.POSITIVE_INFINITY;

const EPS = 1e-9;

export function approxEqual(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Canonical (lexicographically sorted) unordered pair key. */
export function unorderedKey(a, b) {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/** Directed key for ordered features. */
export function orderedKey(a, b) {
  return `${a}>${b}`;
}

/**
 * Parse a stored cost key. Returns null when the key is malformed.
 * Both separators are accepted; `ordered` decides which canonical form wins.
 */
export function parseCostKey(raw, ordered) {
  if (typeof raw !== 'string') return null;
  const sep = raw.includes('>') ? '>' : raw.includes('|') ? '|' : null;
  if (!sep) return null;
  const parts = raw.split(sep).map((s) => s.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [a, b] = parts;
  return { a, b, separator: sep, ordered, key: ordered ? orderedKey(a, b) : unorderedKey(a, b) };
}

/** Cost of one direct transition, or null when the transition is not priced. */
export function getTransitionCost(feature, from, to) {
  if (from === MISSING || to === MISSING) return 0;
  if (from === to) return 0;
  const key = feature.ordered ? orderedKey(from, to) : unorderedKey(from, to);
  const value = feature.costs[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** True when a missing value is being handled as absence, not as a category. */
export function isMissing(value) {
  return value === MISSING || value === undefined || value === '';
}

/**
 * All transition rows the editor should show. Missing never appears.
 * Ordered features list both directions; unordered list each pair once.
 */
export function transitionRows(feature) {
  const rows = [];
  const { states, ordered } = feature;
  if (ordered) {
    for (const a of states) {
      for (const b of states) {
        if (a === b) continue;
        rows.push({ from: a, to: b, key: orderedKey(a, b) });
      }
    }
  } else {
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        const a = states[i];
        const b = states[j];
        rows.push({ from: a, to: b, key: unorderedKey(a, b) });
      }
    }
  }
  return rows;
}

/**
 * Compact state-transition matrix for dynamic programming.
 * matrix[i][j] is the cost of state i -> state j for this feature.
 * Unpriced transitions are INF (forbidden), self transitions are 0.
 */
export function costMatrix(feature) {
  const { states } = feature;
  const matrix = states.map(() => states.map(() => INF));
  for (let i = 0; i < states.length; i++) {
    for (let j = 0; j < states.length; j++) {
      if (i === j) {
        matrix[i][j] = 0;
      } else {
        const c = getTransitionCost(feature, states[i], states[j]);
        matrix[i][j] = c === null ? INF : c;
      }
    }
  }
  return matrix;
}

/**
 * Undirected edge weight used for lower bounds: the cheaper declared direction.
 * Returns INF when neither direction is priced.
 */
export function undirectedStateWeight(feature, a, b) {
  if (a === b) return 0;
  const fwd = getTransitionCost(feature, a, b);
  const rev = getTransitionCost(feature, b, a);
  const vals = [fwd, rev].filter((v) => typeof v === 'number');
  return vals.length ? Math.min(...vals) : INF;
}

/** Sum of per-feature costs for a priced tree. */
export function totalTreeCost(tree, features) {
  let total = 0;
  for (const f of features) total += tree.perFeature?.[f.id]?.cost ?? 0;
  return total;
}
