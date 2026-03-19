import type { Circuit } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';

/**
 * Determine inputCount for parseTestData by matching header signal names
 * against the circuit's In/Clock component labels (inputs) vs Out labels (outputs).
 * Returns the number of leading header names that are circuit inputs.
 */
export function detectInputCount(
  circuit: Circuit,
  registry: ComponentRegistry,
  testDataStr: string,
): number | undefined {
  // Collect circuit input labels (In, Clock components)
  const inputLabels = new Set<string>();
  const outputLabels = new Set<string>();
  for (const el of circuit.elements) {
    const def = registry.get(el.typeId);
    if (!def) continue;
    if (def.name === 'In' || def.name === 'Clock') {
      const label = el.getProperties().get('label') as string | undefined;
      if (label) inputLabels.add(label);
    }
    if (def.name === 'Out') {
      const label = el.getProperties().get('label') as string | undefined;
      if (label) outputLabels.add(label);
    }
  }

  // If we can't identify any labeled components, fall back
  if (inputLabels.size === 0 && outputLabels.size === 0) return undefined;

  // Parse signal names from header (whitespace-separated, skip comments)
  const hdrLine = testDataStr.split('\n').find(
    (l) => l.trim().length > 0 && !l.trim().startsWith('#'),
  ) ?? '';
  const names = hdrLine.trim().split(/\s+/).filter((n) => n.length > 0 && n !== '#');

  // Count leading names that are circuit inputs
  let count = 0;
  for (const name of names) {
    if (inputLabels.has(name)) {
      count++;
    } else {
      break; // First non-input name marks the boundary
    }
  }

  // If no inputs found but we have outputs, all columns are outputs
  return count > 0 ? count : (outputLabels.size > 0 ? 0 : undefined);
}
