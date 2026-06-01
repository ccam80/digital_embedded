import type { ComponentRegistry } from "../../core/registry.js";
import {
  TYPE_ID_TO_NGSPICE_LOAD_ORDER,
  TYPE_ID_TO_DEVICE_FAMILY,
  TYPE_ID_TO_DECK_PIN_LABEL_ORDER,
  MULTI_LINE_COMPOSITES,
  type DeviceFamily,
} from "./ngspice-load-order.js";

const DECK_EMITTING_FAMILIES: ReadonlySet<DeviceFamily> = new Set<DeviceFamily>([
  "RES",
  "CAP",
  "IND",
  "VSRC",
  "ISRC",
  "DIO",
  "BJT",
  "MOS",
  "JFET",
  "TRA",
  // Controlled sources emit F/H/E/G primitive cards via netlist-generator's
  // emitPrimitive. Their pin-label-order entries gate compiler node-allocation
  // walk parity with ngspice's INPpas2 first-encounter rule.
  "CCCS",
  "CCVS",
  "VCCS",
  "VCVS",
  // Single-card switch / coupling: CSW emits `W out+ out- VSENSE model` (two output
  // node tokens); MUT emits `K L1 L2 k`, referencing inductors by name and minting
  // no nodes (its deck-pin row is the empty []). Both are genuine single-card
  // deck-emitting devices, so they carry a row.
  "CSW",
  "MUT",
]);

// MULTI_LINE_COMPOSITES now lives in ngspice-load-order.ts (single source of truth,
// shared with auditDeckPinOrderCoverage) and is imported above.

export function auditNgspiceLoadOrderTables(registry: ComponentRegistry): void {
  const inLoadOrder = new Set(Object.keys(TYPE_ID_TO_NGSPICE_LOAD_ORDER));
  const inFamily = new Set(Object.keys(TYPE_ID_TO_DEVICE_FAMILY));
  const inDeckPins = new Set(Object.keys(TYPE_ID_TO_DECK_PIN_LABEL_ORDER));
  const union = new Set<string>([...inLoadOrder, ...inFamily, ...inDeckPins]);

  const errors: string[] = [];

  for (const typeId of union) {
    if (!inLoadOrder.has(typeId)) {
      errors.push(`typeId "${typeId}" missing from TYPE_ID_TO_NGSPICE_LOAD_ORDER`);
    }
    if (!inFamily.has(typeId)) {
      errors.push(`typeId "${typeId}" missing from TYPE_ID_TO_DEVICE_FAMILY`);
    }

    const family = TYPE_ID_TO_DEVICE_FAMILY[typeId];
    const isDeckEmitting = family !== undefined && DECK_EMITTING_FAMILIES.has(family);
    const isMultiLineComposite = MULTI_LINE_COMPOSITES.has(typeId);

    if (isDeckEmitting && !isMultiLineComposite && !inDeckPins.has(typeId)) {
      errors.push(
        `typeId "${typeId}" (family "${family}") missing from TYPE_ID_TO_DECK_PIN_LABEL_ORDER`,
      );
    }
    if (!isDeckEmitting && inDeckPins.has(typeId)) {
      errors.push(
        `typeId "${typeId}" is in TYPE_ID_TO_DECK_PIN_LABEL_ORDER but family "${family ?? "<unset>"}" is not deck-emitting`,
      );
    }
    if (isMultiLineComposite && inDeckPins.has(typeId)) {
      errors.push(
        `typeId "${typeId}" is a multi-line composite but appears in TYPE_ID_TO_DECK_PIN_LABEL_ORDER; remove it (sub-elements supply their own pin order)`,
      );
    }

    if (registry.get(typeId) === undefined) {
      errors.push(
        `typeId "${typeId}" appears in ngspice-load-order tables but is not a registered component`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `ngspice-load-order audit failed:\n  - ${errors.join("\n  - ")}\n` +
        `Fix the affected keys in src/solver/analog/ngspice-load-order.ts.`,
    );
  }
}
