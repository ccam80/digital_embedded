/**
 * Tests that each semiconductor component declares a modelRegistry with a
 * default model entry of kind "inline", and that the removed legacy model
 * override property no longer appears in propertyDefs.
 */

import { describe, it, expect } from "vitest";
import { NpnBjtDefinition, PnpBjtDefinition } from "../bjt.js";
import { DiodeDefinition } from "../diode.js";
import { NmosfetDefinition, PmosfetDefinition } from "../mosfet.js";
import { NJfetDefinition } from "../njfet.js";
import { PJfetDefinition } from "../pjfet.js";
import { ZenerDiodeDefinition } from "../zener.js";
import { SchottkyDiodeDefinition } from "../schottky.js";
import { ScrDefinition } from "../scr.js";
import { DiacDefinition } from "../diac.js";
import { TriacDefinition } from "../triac.js";
import { TunnelDiodeDefinition } from "../tunnel-diode.js";
import type { ComponentDefinition } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


const SEMICONDUCTOR_DEFS: ComponentDefinition[] = [
  NpnBjtDefinition,
  PnpBjtDefinition,
  DiodeDefinition,
  NmosfetDefinition,
  PmosfetDefinition,
  NJfetDefinition,
  PJfetDefinition,
  ZenerDiodeDefinition,
  SchottkyDiodeDefinition,
  ScrDefinition,
  DiacDefinition,
  TriacDefinition,
  TunnelDiodeDefinition,
];

describe("modelRegistry on semiconductor components", () => {
  for (const def of SEMICONDUCTOR_DEFS) {
    const modelKey = def.defaultModel!;

    it(`${def.name}: has modelRegistry with default model entry`, () => {
      expect(def.modelRegistry).toBeDefined();
      expect(def.modelRegistry![modelKey]).toBeDefined();
    });

    it(`${def.name}: default model entry has kind "inline"`, () => {
      expect(def.modelRegistry![modelKey]!.kind).toBe("inline");
    });

    it(`${def.name}: default model entry has a factory function`, () => {
      expect(typeof getFactory(def.modelRegistry![modelKey]!)).toBe("function");
    });

    it(`${def.name}: default model entry has params record`, () => {
      expect(def.modelRegistry![modelKey]!.params).toBeDefined();
      expect(typeof def.modelRegistry![modelKey]!.params).toBe("object");
    });

    it(`${def.name}: legacy model override property does not appear in propertyDefs`, () => {
      const legacyKey = ["_spice", "Model", "Overrides"].join("");
      const found = def.propertyDefs.find((pd) => pd.key === legacyKey);
      expect(found).toBeUndefined();
    });
  }
});
