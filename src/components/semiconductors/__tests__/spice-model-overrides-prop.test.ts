/**
 * Tests that each semiconductor component declares a modelRegistry with a
 * "behavioral" entry of kind "inline", and that the removed legacy model
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
    it(`${def.name}: has modelRegistry with behavioral entry`, () => {
      expect(def.modelRegistry).toBeDefined();
      expect(def.modelRegistry!["behavioral"]).toBeDefined();
    });

    it(`${def.name}: behavioral entry has kind "inline"`, () => {
      expect(def.modelRegistry!["behavioral"]!.kind).toBe("inline");
    });

    it(`${def.name}: behavioral entry has a factory function`, () => {
      expect(typeof def.modelRegistry!["behavioral"]!.factory).toBe("function");
    });

    it(`${def.name}: behavioral entry has params record`, () => {
      expect(def.modelRegistry!["behavioral"]!.params).toBeDefined();
      expect(typeof def.modelRegistry!["behavioral"]!.params).toBe("object");
    });

    it(`${def.name}: legacy model override property does not appear in propertyDefs`, () => {
      const legacyKey = ["_spice", "Model", "Overrides"].join("");
      const found = def.propertyDefs.find((pd) => pd.key === legacyKey);
      expect(found).toBeUndefined();
    });
  }
});
