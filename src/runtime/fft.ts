/**
 * FFT utilities- Cooley-Tukey radix-2 in-place FFT, windowing, and spectrum
 * computation for the analog oscilloscope's frequency-domain view.
 */

/**
 * Returns the smallest power of 2 that is >= n.
 */
export function nextPow2(n: number): number {
  if (n <= 1) return 1;
  // Bit-manipulation trick: clz32 counts leading zeros in a 32-bit integer.
  // For n > 1, the next power of 2 is 1 << (32 - clz32(n - 1)).
  return 1 << (32 - Math.clz32(n - 1));
}

/**
 * Returns the largest power of 2 that is <= n.
 * Used by the scope panel to select the FFT window size.
 */
export function floorPow2(n: number): number {
  if (n <= 0) return 1;
  return 1 << (31 - Math.clz32(n));
}

/**
 * In-place radix-2 Cooley-Tukey FFT.
 *
 * Both `re` and `im` must have the same power-of-2 length N.
 * After the call the arrays contain the DFT coefficients X[0..N-1].
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const N = re.length;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      // Swap re
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      // Swap im
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  // Butterfly stages
  for (let len = 2; len <= N; len <<= 1) {
    const halfLen = len >> 1;
    const wRe = Math.cos((2 * Math.PI) / len);
    const wIm = -Math.sin((2 * Math.PI) / len);
    for (let i = 0; i < N; i += len) {
      let uRe = 1.0;
      let uIm = 0.0;
      for (let k = 0; k < halfLen; k++) {
        const evenRe = re[i + k];
        const evenIm = im[i + k];
        const oddRe = re[i + k + halfLen];
        const oddIm = im[i + k + halfLen];

        const tRe = uRe * oddRe - uIm * oddIm;
        const tIm = uRe * oddIm + uIm * oddRe;

        re[i + k] = evenRe + tRe;
        im[i + k] = evenIm + tIm;
        re[i + k + halfLen] = evenRe - tRe;
        im[i + k + halfLen] = evenIm - tIm;

        const newURe = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = newURe;
      }
    }
  }
}

/**
 * Applies a Hann window to `samples`.
 *
 * w[n] = 0.5 - 0.5 * cos(2πn / N)
 *
 * Returns a new Float64Array; the input is not mutated.
 */
export function hannWindow(samples: Float64Array): Float64Array {
  const N = samples.length;
  const out = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);
    out[n] = samples[n] * w;
  }
  return out;
}

/**
 * Computes the one-sided magnitude spectrum from FFT output arrays.
 *
 * Returns frequency bins 0..N/2 (inclusive) and their linear magnitudes.
 * The frequency of bin k is k * sampleRate / N.
 */
export function magnitudeSpectrum(
  re: Float64Array,
  im: Float64Array,
  sampleRate: number,
): { frequency: Float64Array; magnitude: Float64Array } {
  const N = re.length;
  const half = Math.floor(N / 2) + 1;
  const frequency = new Float64Array(half);
  const magnitude = new Float64Array(half);

  for (let k = 0; k < half; k++) {
    frequency[k] = (k * sampleRate) / N;
    magnitude[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }

  return { frequency, magnitude };
}

/**
 * Converts linear magnitude values to decibels.
 *
 * dB[k] = 20 * log10(magnitude[k] / reference)
 *
 * When `reference` is not supplied, uses the maximum value in the array.
 * Returns a new Float64Array; input is not mutated.
 * Values where magnitude <= 0 are set to -Infinity.
 */
export function magnitudeToDb(magnitude: Float64Array, reference?: number): Float64Array {
  const out = new Float64Array(magnitude.length);
  let ref = reference;
  if (ref === undefined) {
    ref = 0;
    for (let i = 0; i < magnitude.length; i++) {
      if (magnitude[i] > ref) ref = magnitude[i];
    }
  }
  if (ref === 0) {
    // All zeros- return -Infinity for all bins
    out.fill(-Infinity);
    return out;
  }
  for (let i = 0; i < magnitude.length; i++) {
    const m = magnitude[i];
    out[i] = m > 0 ? 20 * Math.log10(m / ref) : -Infinity;
  }
  return out;
}
