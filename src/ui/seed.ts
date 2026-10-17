/** A fresh 32-bit match seed from the platform's crypto RNG (Math.random if that is missing). */
export function randomSeed(): number {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  } catch {
    return Math.floor(Math.random() * 2 ** 32);
  }
}
