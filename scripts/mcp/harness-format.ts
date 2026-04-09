// harness-format.ts — FormattedNumber and ComparedValueJSON serialization utilities

import type { ComparedValue } from "../../src/solver/analog/__tests__/harness/types.js";

export interface FormattedNumber {
  raw: number | null;
  display: string;
}

export interface ComparedValueJSON {
  ours: FormattedNumber;
  ngspice: FormattedNumber;
  delta: FormattedNumber;
  absDelta: FormattedNumber;
  relDelta: FormattedNumber;
  withinTol: boolean;
}

/**
 * Format a number in engineering notation with SI suffixes, 4 significant digits.
 * NaN → { raw: null, display: "—" }
 * Infinity → { raw: Infinity, display: "+Inf" or "-Inf" }
 */
export function formatNumber(value: number): FormattedNumber {
  if (Number.isNaN(value)) {
    return { raw: null, display: "—" };
  }
  if (!Number.isFinite(value)) {
    return { raw: value, display: value > 0 ? "+Inf" : "-Inf" };
  }
  if (value === 0) {
    return { raw: 0, display: "0.000" };
  }

  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  let suffix: string;
  let scaled: number;

  if (abs >= 1e12) {
    suffix = "T";
    scaled = abs / 1e12;
  } else if (abs >= 1e9) {
    suffix = "G";
    scaled = abs / 1e9;
  } else if (abs >= 1e6) {
    suffix = "M";
    scaled = abs / 1e6;
  } else if (abs >= 1e3) {
    suffix = "k";
    scaled = abs / 1e3;
  } else if (abs >= 1) {
    suffix = "";
    scaled = abs;
  } else if (abs >= 1e-3) {
    suffix = "m";
    scaled = abs / 1e-3;
  } else if (abs >= 1e-6) {
    suffix = "u";
    scaled = abs / 1e-6;
  } else if (abs >= 1e-9) {
    suffix = "n";
    scaled = abs / 1e-9;
  } else if (abs >= 1e-12) {
    suffix = "p";
    scaled = abs / 1e-12;
  } else {
    suffix = "f";
    scaled = abs / 1e-15;
  }

  const display = `${sign}${scaled.toPrecision(4)}${suffix}`;
  return { raw: value, display };
}

/**
 * Serialize a ComparedValue to ComparedValueJSON with all fields formatted.
 */
export function formatComparedValue(cv: ComparedValue): ComparedValueJSON {
  return {
    ours: formatNumber(cv.ours),
    ngspice: formatNumber(cv.ngspice),
    delta: formatNumber(cv.delta),
    absDelta: formatNumber(cv.absDelta),
    relDelta: formatNumber(cv.relDelta),
    withinTol: cv.withinTol,
  };
}

/**
 * Suggest up to 2 closest component labels for "did you mean" error messages.
 * Uses Levenshtein distance, case-insensitive comparison.
 */
export function suggestComponents(input: string, labels: string[]): string[] {
  const upper = input.toUpperCase();
  return labels
    .map((l) => ({ l, d: levenshtein(upper, l.toUpperCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map((x) => `"${x.l}"`);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}
