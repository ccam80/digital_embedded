/**
 * CircuitSearch — find elements matching a text query.
 *
 * Matches against component label (from properties), type name (typeId),
 * and tunnel name (also from properties under "label" for tunnel components).
 * All matching is case-insensitive.
 */

import type { Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { Viewport } from "./viewport.js";

// ---------------------------------------------------------------------------
// SearchResult
// ---------------------------------------------------------------------------

export interface SearchResult {
  element: CircuitElement;
  /** Which field produced the match: "label", "typeName", or "tunnelName". */
  matchType: string;
  /** The matched text (the value of the field that matched). */
  matchText: string;
}

// ---------------------------------------------------------------------------
// CircuitSearch
// ---------------------------------------------------------------------------

export class CircuitSearch {
  /**
   * Search all elements in the circuit for matches against the given query.
   *
   * Checks (in order for each element):
   *   1. label property — stored under key "label" in the element's PropertyBag
   *   2. typeId — the component type name (e.g. "And", "FlipflopD")
   *   3. tunnel name — for Tunnel components the name is also in "label"
   *
   * An element may produce more than one result if multiple fields match.
   * Matching is case-insensitive substring search.
   */
  search(circuit: Circuit, query: string): SearchResult[] {
    if (query === "") return [];

    const lowerQuery = query.toLowerCase();
    const results: SearchResult[] = [];

    for (const element of circuit.elements) {
      // Check label property
      const bag = element.getProperties();
      if (bag.has("label")) {
        const label = String(bag.get("label"));
        if (label.toLowerCase().includes(lowerQuery)) {
          results.push({
            element,
            matchType: "label",
            matchText: label,
          });
          continue;
        }
      }

      // Check type name
      if (element.typeId.toLowerCase().includes(lowerQuery)) {
        results.push({
          element,
          matchType: "typeName",
          matchText: element.typeId,
        });
        continue;
      }

      // Check tunnel name — tunnels store their net name in "net" or "label"
      if (element.typeId === "Tunnel" && bag.has("net")) {
        const tunnelName = String(bag.get("net"));
        if (tunnelName.toLowerCase().includes(lowerQuery)) {
          results.push({
            element,
            matchType: "tunnelName",
            matchText: tunnelName,
          });
        }
      }
    }

    return results;
  }

  /**
   * Center the viewport on the element in the given search result.
   *
   * Uses fitToContent with a single-element array so the viewport pans to
   * the result and applies a readable zoom level.
   */
  navigateTo(result: SearchResult, viewport: Viewport): void {
    viewport.fitToContent([result.element], { width: 800, height: 600 });
  }
}
