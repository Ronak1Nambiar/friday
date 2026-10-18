// Reference solution: only used to check that accept.mjs is right (bench --check).
export function splitBill(totalCents, n) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new TypeError('totalCents must be a non-negative integer');
  if (!Number.isInteger(n) || n < 1) throw new TypeError('n must be a positive integer');
  const base = Math.floor(totalCents / n);
  const extra = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}
