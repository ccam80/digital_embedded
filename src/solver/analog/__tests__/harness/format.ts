/**
 * Formatting and serialization utilities for harness query results.
 */
import type { ComparedValue } from "./types.js";

/**
 * Rich formatted form with individual fields as strings.
 */
export interface FormattedComparedValue {
  ours: string;
  ngspice: string;
  delta: string;
  absDelta: string;
  relDelta: string;
  withinTol: boolean;
  summary: string;
}

function fmtNum(v: number, precision: number): string {
  if (isNaN(v)) return "NaN";
  if (!isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
  return v.toPrecision(precision);
}

/**
 * Format a single ComparedValue as a compact human-readable string.
 * Format: "ours=<val> ng=<val> Δ=<delta> [PASS|FAIL]"
 * Uses toPrecision with `precision` significant digits (default 6).
 * NaN values rendered as "NaN".
 */
export function formatComparedValue(cv: ComparedValue, precision = 6): string {
  const pass = cv.withinTol ? "PASS" : "FAIL";
  return `ours=${fmtNum(cv.ours, precision)} ng=${fmtNum(cv.ngspice, precision)} \u0394=${fmtNum(cv.delta, precision)} [${pass}]`;
}

/**
 * Rich formatted form with individual fields as strings.
 */
export function formatCV(cv: ComparedValue, precision = 6): FormattedComparedValue {
  return {
    ours: fmtNum(cv.ours, precision),
    ngspice: fmtNum(cv.ngspice, precision),
    delta: fmtNum(cv.delta, precision),
    absDelta: fmtNum(cv.absDelta, precision),
    relDelta: fmtNum(cv.relDelta, precision),
    withinTol: cv.withinTol,
    summary: formatComparedValue(cv, precision),
  };
}

/**
 * Format a Record<string, ComparedValue> as a multi-line table.
 * Columns: slot name, ours, ngspice, absDelta, PASS/FAIL.
 * Rows sorted by absDelta descending (worst first).
 */
export function formatComparedTable(
  entries: Record<string, ComparedValue>,
  precision = 6,
): string {
  const rows = Object.entries(entries).sort((a, b) => b[1].absDelta - a[1].absDelta);
  const lines: string[] = ["slot\tours\tngspice\tabsDelta\tstatus"];
  for (const [slot, cv] of rows) {
    const pass = cv.withinTol ? "PASS" : "FAIL";
    lines.push(
      `${slot}\t${fmtNum(cv.ours, precision)}\t${fmtNum(cv.ngspice, precision)}\t${fmtNum(cv.absDelta, precision)}\t${pass}`,
    );
  }
  return lines.join("\n");
}

/**
 * Convert a Map<K, V> to a plain Record<string, V> for JSON serialization.
 * Keys are converted via String(key).
 */
export function mapToRecord<V>(map: Map<number | string, V>): Record<string, V> {
  const result: Record<string, V> = {};
  for (const [k, v] of map) {
    result[String(k)] = v;
  }
  return result;
}

/**
 * Convert a Float64Array to a plain number[] for JSON serialization.
 * NaN → null, Infinity → null (via JSON-safe coercion).
 */
export function float64ToArray(arr: Float64Array): (number | null)[] {
  const out: (number | null)[] = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out[i] = isFinite(v) ? v : null;
  }
  return out;
}
