/**
 * Lightweight .dig pin scanner — extracts external pin declarations from
 * a .dig XML file without building the full circuit.
 *
 * Scans for In/Out visual elements and converts them to PinDeclaration[].
 * Used to populate subcircuit registry stubs with real pin metadata
 * at registration time, avoiding the cost of full circuit construction.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { parseDigXml } from "./dig-parser.js";
import { PinDirection } from "../core/pin.js";
import type { PinDeclaration } from "../core/pin.js";
import type { DigValue } from "./dig-schema.js";
import { LIBRARY_74XX } from "../components/library-74xx.js";

/** Extract a string from a DigValue if it is a string type. */
function digString(v: DigValue): string | undefined {
  return v.type === "string" || v.type === "testData" || v.type === "data"
    ? v.value
    : undefined;
}

/** Extract a number from a DigValue if it is a numeric type. */
function digNumber(v: DigValue): number | undefined {
  if (v.type === "int") return v.value;
  if (v.type === "long") return Number(v.value);
  return undefined;
}

/**
 * Scan a .dig XML string and return the external pin declarations.
 *
 * Extracts In/Out elements, reads their Label, Bits, and pinNumber
 * attributes, and returns a PinDeclaration[] suitable for use in a
 * ComponentDefinition.pinLayout.
 *
 * This is much cheaper than loadWithSubcircuits() — no wire resolution,
 * no nested subcircuit loading, no element instantiation.
 */
export function scanDigPins(xml: string): PinDeclaration[] {
  const dig = parseDigXml(xml);
  const pins: PinDeclaration[] = [];

  for (const ve of dig.visualElements) {
    const isIn = ve.elementName === "In";
    const isOut = ve.elementName === "Out";
    if (!isIn && !isOut) continue;

    // Extract attributes from the DigValue tagged union
    let label = "";
    let bits = 1;

    for (const attr of ve.elementAttributes) {
      switch (attr.key) {
        case "Label": {
          const s = digString(attr.value);
          if (s !== undefined) label = s;
          break;
        }
        case "Bits": {
          const n = digNumber(attr.value);
          if (n !== undefined) bits = n;
          break;
        }
      }
    }

    pins.push({
      kind: "signal",
      direction: isIn ? PinDirection.INPUT : PinDirection.OUTPUT,
      label: label || (isIn ? `in_${pins.length}` : `out_${pins.length}`),
      defaultBitWidth: bits,
      position: { x: 0, y: 0 }, // Actual positions computed by SubcircuitElement
      isNegatable: false,
      isClockCapable: false,
    });
  }

  return pins;
}

/**
 * Build a file index mapping filenames to full paths by recursively
 * scanning a directory tree for .dig files.
 */
function buildFileIndex(dir: string): Map<string, string> {
  const index = new Map<string, string>();
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          for (const [k, v] of buildFileIndex(full)) {
            if (!index.has(k)) index.set(k, v);
          }
        } else if (entry.endsWith(".dig")) {
          index.set(entry, full);
        }
      } catch { /* skip inaccessible entries */ }
    }
  } catch { /* dir not readable */ }
  return index;
}

/**
 * Scan all 74xx .dig files from the reference library and return a
 * Map<name, PinDeclaration[]> suitable for passing to
 * `createDefaultRegistry()`.
 *
 * @param libDir - Path to the 74xx library directory, e.g.
 *   `"ref/Digital/src/main/dig/lib/DIL Chips/74xx"`.
 *   The function recursively searches all subdirectories for .dig files.
 * @returns Map from IC name (e.g. "7400") to its scanned pin declarations.
 *   Entries whose .dig file cannot be found or parsed are silently skipped.
 */
export function scan74xxPinMap(
  libDir: string,
): Map<string, PinDeclaration[]> {
  const index = buildFileIndex(libDir);
  const result = new Map<string, PinDeclaration[]>();

  for (const entry of LIBRARY_74XX) {
    const filePath = index.get(entry.file);
    if (!filePath) continue;

    try {
      const xml = readFileSync(filePath, "utf-8");
      const pins = scanDigPins(xml);
      if (pins.length > 0) {
        result.set(entry.name, pins);
      }
    } catch { /* skip unparseable files */ }
  }

  return result;
}
