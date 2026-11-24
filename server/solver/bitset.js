/** Small bitset helpers over JS numbers (<= 30 taxa) and BigInt fallback. */
export const popcount = (x) => {
  let n = 0;
  let v = x;
  while (v) {
    v &= v - 1;
    n++;
  }
  return n;
};

export const lowBitIndex = (x) => {
  // x is a positive integer
  return 31 - Math.clz32(x & -x);
};

export function subsetMasks(mask, minSize = 1) {
  const out = [];
  const bits = [];
  for (let i = 0; i < 32; i++) if (mask & (1 << i)) bits.push(1 << i);
  const n = bits.length;
  for (let sub = 1; sub < 1 << n; sub++) {
    let m = 0;
    let size = 0;
    for (let i = 0; i < n; i++) {
      if (sub & (1 << i)) {
        m |= bits[i];
        size++;
      }
    }
    if (size >= minSize) out.push(m);
  }
  return out;
}

