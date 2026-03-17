/**
 * SI prefix formatting for analog electrical values.
 *
 * Formats a number with the appropriate SI prefix for compact display in
 * tooltips, scope axis labels, measurement cursors, and power labels.
 * Always produces 3 significant figures.
 *
 * Prefixes supported: f (1e-15), p (1e-12), n (1e-9), µ (1e-6), m (1e-3),
 * (none, 1e0), k (1e3), M (1e6), G (1e9), T (1e12).
 */

const SI_PREFIXES: { prefix: string; exponent: number }[] = [
  { prefix: "T", exponent: 12 },
  { prefix: "G", exponent: 9 },
  { prefix: "M", exponent: 6 },
  { prefix: "k", exponent: 3 },
  { prefix: "", exponent: 0 },
  { prefix: "m", exponent: -3 },
  { prefix: "µ", exponent: -6 },
  { prefix: "n", exponent: -9 },
  { prefix: "p", exponent: -12 },
  { prefix: "f", exponent: -15 },
];

/**
 * Format a number with the appropriate SI prefix and 3 significant figures.
 *
 * @param value - The numeric value to format (may be negative).
 * @param unit  - The base unit string (e.g. "A", "V", "Ω", "F", "W").
 * @param precision - Number of significant figures. Defaults to 3.
 * @returns Formatted string, e.g. "4.70 mA", "2.20 kΩ", "1.00 µF".
 *
 * @example
 * formatSI(0.0047, "A")   → "4.70 mA"
 * formatSI(2200, "Ω")     → "2.20 kΩ"
 * formatSI(1e-6, "F")     → "1.00 µF"
 * formatSI(0, "V")        → "0.00 V"
 * formatSI(-3.3, "V")     → "-3.30 V"
 * formatSI(1e-14, "A")    → "10.0 fA"
 */
export function formatSI(value: number, unit: string, precision: number = 3): string {
  if (value === 0) {
    return `0.00 ${unit}`;
  }

  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  // Find the best SI prefix: the largest prefix whose exponent ≤ log10(abs)
  const log10abs = Math.log10(abs);

  let chosen = SI_PREFIXES[SI_PREFIXES.length - 1]; // default to femto
  for (const entry of SI_PREFIXES) {
    if (log10abs >= entry.exponent - 0.001) {
      chosen = entry;
      break;
    }
  }

  const scaled = abs / Math.pow(10, chosen.exponent);

  // Format to `precision` significant figures
  const formatted = _toSignificantFigures(scaled, precision);

  if (chosen.prefix === "") {
    return `${sign}${formatted} ${unit}`;
  }
  return `${sign}${formatted} ${chosen.prefix}${unit}`;
}

/**
 * Format a positive number to a given number of significant figures,
 * without trailing zeros in integer portion but with enough decimal places
 * to reach `sigFigs` significant figures.
 */
function _toSignificantFigures(value: number, sigFigs: number): string {
  if (value === 0) return "0.00";

  const magnitude = Math.floor(Math.log10(value));
  const decimalPlaces = sigFigs - 1 - magnitude;

  if (decimalPlaces <= 0) {
    // Round to nearest integer (or tens)
    const factor = Math.pow(10, -decimalPlaces);
    return String(Math.round(value / factor) * factor);
  }

  return value.toFixed(decimalPlaces);
}
