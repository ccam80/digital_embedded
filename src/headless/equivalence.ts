/**
 * Behavioral equivalence testing for two circuits.
 *
 * Exhaustively tests all input combinations up to a configurable bit limit
 * and reports whether the two circuits produce identical outputs.
 */

import type { Circuit } from "../core/circuit.js";
import type { ComponentRegistry } from "../core/registry.js";
import { DefaultSimulatorFacade } from "./default-facade.js";

export interface EquivalenceResult {
  equivalent: boolean;
  totalCombinations: number;
  inputLabels: string[];
  outputLabels: string[];
  mismatches: number;
  firstMismatch?: string;
}

export function testEquivalence(
  circuitA: Circuit,
  circuitB: Circuit,
  registry: ComponentRegistry,
  maxInputBits?: number,
): EquivalenceResult {
  const facadeA = new DefaultSimulatorFacade(registry);
  const facadeB = new DefaultSimulatorFacade(registry);
  const engineA = facadeA.compile(circuitA);
  const engineB = facadeB.compile(circuitB);

  // Discover In/Out labels from circuit A
  const inputLabels: string[] = [];
  const inputWidths: number[] = [];
  const outputLabels: string[] = [];

  for (const el of circuitA.elements) {
    const def = registry.get(el.typeId);
    if (!def) continue;
    const label = el.getAttribute("label") as string;
    if (!label) continue;
    if (def.name === "In" || def.name === "Clock") {
      const bits = (el.getAttribute("bitWidth") as number) || 1;
      inputLabels.push(label);
      inputWidths.push(bits);
    } else if (def.name === "Out") {
      outputLabels.push(label);
    }
  }

  const totalBits = inputWidths.reduce((a, b) => a + b, 0);
  const limit = Math.min(maxInputBits ?? 16, 20);

  if (totalBits > limit) {
    throw new Error(
      `Total input bits (${totalBits}) exceeds limit (${limit}). ` +
        `Exhaustive equivalence testing is impractical. Use test vectors instead.`,
    );
  }

  const totalCombinations = 1 << totalBits;
  let mismatches = 0;
  let firstMismatch: string | undefined;

  for (let combo = 0; combo < totalCombinations; combo++) {
    let bitPos = 0;
    for (let i = 0; i < inputLabels.length; i++) {
      const mask = (1 << inputWidths[i]!) - 1;
      const value = (combo >> bitPos) & mask;
      facadeA.setInput(engineA, inputLabels[i]!, value);
      facadeB.setInput(engineB, inputLabels[i]!, value);
      bitPos += inputWidths[i]!;
    }

    facadeA.runToStable(engineA);
    facadeB.runToStable(engineB);

    for (const label of outputLabels) {
      const outA = facadeA.readOutput(engineA, label);
      const outB = facadeB.readOutput(engineB, label);
      if (outA !== outB) {
        mismatches++;
        if (!firstMismatch) {
          const inputState: Record<string, number> = {};
          let bp = 0;
          for (let i = 0; i < inputLabels.length; i++) {
            const mask = (1 << inputWidths[i]!) - 1;
            inputState[inputLabels[i]!] = (combo >> bp) & mask;
            bp += inputWidths[i]!;
          }
          firstMismatch = `Output "${label}": A=${outA}, B=${outB} for inputs ${JSON.stringify(inputState)}`;
        }
      }
    }
  }

  const result: EquivalenceResult = {
    equivalent: mismatches === 0,
    totalCombinations,
    inputLabels,
    outputLabels,
    mismatches,
  };
  if (firstMismatch !== undefined) result.firstMismatch = firstMismatch;
  return result;
}
