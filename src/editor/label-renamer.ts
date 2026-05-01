/**
 * Label renaming on copy- ports Digital's CopiedElementLabelRenamer.
 *
 * When copying components with numeric suffixes, auto-increment the suffix
 * to avoid duplicate labels. If the incremented label already exists in the
 * circuit, keep incrementing until a free label is found.
 *
 * Examples:
 *   "Reg1"  → "Reg2" (if "Reg2" is free)
 *   "Reg1"  → "Reg3" (if "Reg2" already exists)
 *   "Clock" → "Clock" (no numeric suffix- unchanged)
 */

import type { CircuitElement } from "@/core/element";

/** Property key used for component labels. */
const LABEL_KEY = "label";

/**
 * For each element in `newElements` that has a label property with a numeric
 * suffix, rename it to the next available label not already present in the
 * `allElements` list (which includes both existing and new elements).
 *
 * Mutates the label property on each element in-place.
 */
export function renameLabelsOnCopy(
  newElements: CircuitElement[],
  allElements: CircuitElement[],
): void {
  for (const element of newElements) {
    const props = element.getProperties();
    if (!props.has(LABEL_KEY)) {
      continue;
    }

    const currentLabel = String(props.get(LABEL_KEY));
    const parsed = parseNumericSuffix(currentLabel);
    if (parsed === undefined) {
      continue;
    }

    const { prefix, number } = parsed;
    const existingLabels = collectLabels(allElements);
    const newLabel = findNextFreeLabel(prefix, number + 1, existingLabels);

    props.set(LABEL_KEY, newLabel);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Parsed result from a label with a numeric suffix. */
interface ParsedLabel {
  prefix: string;
  number: number;
}

/**
 * Parse a label into a non-numeric prefix and a trailing integer.
 *
 * Returns undefined if the label has no numeric suffix.
 *
 * Examples:
 *   "Reg1"   → { prefix: "Reg",   number: 1 }
 *   "Reg12"  → { prefix: "Reg",   number: 12 }
 *   "Clock"  → undefined
 *   "1"      → { prefix: "",      number: 1 }
 */
function parseNumericSuffix(label: string): ParsedLabel | undefined {
  const match = /^(.*?)(\d+)$/.exec(label);
  if (match === null) {
    return undefined;
  }
  return { prefix: match[1]!, number: parseInt(match[2]!, 10) };
}

/**
 * Collect all label values from a list of elements into a Set.
 */
function collectLabels(elements: CircuitElement[]): Set<string> {
  const labels = new Set<string>();
  for (const element of elements) {
    const props = element.getProperties();
    if (props.has(LABEL_KEY)) {
      labels.add(String(props.get(LABEL_KEY)));
    }
  }
  return labels;
}

/**
 * Find the next free label for `prefix + n` where n starts at `startNumber`
 * and increments until the constructed label is not in `existingLabels`.
 */
function findNextFreeLabel(prefix: string, startNumber: number, existingLabels: Set<string>): string {
  let n = startNumber;
  while (existingLabels.has(prefix + n)) {
    n++;
  }
  return prefix + n;
}
