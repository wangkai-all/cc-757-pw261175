export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Deterministic PRNG so every run with the same seed is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function formatNumber(x) {
  if (x === null || x === undefined) return '—';
  if (!Number.isFinite(x)) return '∞';
  if (Number.isInteger(x)) return String(x);
  return String(Math.round(x * 1000) / 1000);
}

export function nowIso() {
  return new Date().toISOString();
}
