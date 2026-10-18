// Split a bill of `totalCents` between `n` people.
export function splitBill(totalCents, n) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new TypeError('totalCents must be a non-negative integer');
  if (!Number.isInteger(n) || n < 1) throw new TypeError('n must be a positive integer');
  const share = Math.round(totalCents / n);
  return Array.from({ length: n }, () => share);
}
