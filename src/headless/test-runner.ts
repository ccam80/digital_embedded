/**
 * Test data extraction- collect embedded test vectors from Testcase components.
 *
 * This module has no browser dependencies and runs in Node.js.
 */

import type { Circuit } from "../core/circuit.js";
import { TestcaseElement } from "../components/misc/testcase.js";

// ---------------------------------------------------------------------------
// extractEmbeddedTestData- collect test data from all Testcase elements
// ---------------------------------------------------------------------------

/**
 * Extract and concatenate test data from all Testcase components in the circuit.
 *
 * Multiple Testcase components are supported. Their test data strings are
 * concatenated with a newline separator. If the combined result is empty,
 * returns null.
 *
 * @param circuit  Circuit to search for Testcase elements.
 * @returns        Combined test data string, or null if none found.
 */
export function extractEmbeddedTestData(circuit: Circuit): string | null {
  const parts: string[] = [];

  for (const element of circuit.elements) {
    if (element instanceof TestcaseElement) {
      const data = element.testData.trim();
      if (data.length > 0) {
        parts.push(data);
      }
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join("\n");
}
