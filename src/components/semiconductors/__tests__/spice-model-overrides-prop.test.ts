/**
 * Tests that each semiconductor component with a deviceType declares
 * _spiceModelOverrides as a hidden PropertyDef with the correct shape.
 *
 * Also verifies that the hidden flag suppresses the property from the
 * visible panel by confirming it is excluded from the non-hidden defs.
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
import { PropertyType } from "../../../core/properties.js";
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

describe("_spiceModelOverrides PropertyDef on semiconductor components", () => {
  for (const def of SEMICONDUCTOR_DEFS) {
    it(`${def.name}: has _spiceModelOverrides in propertyDefs`, () => {
      const overridesDef = def.propertyDefs.find(
        (pd) => pd.key === "_spiceModelOverrides",
      );
      expect(overridesDef).toBeDefined();
    });

    it(`${def.name}: _spiceModelOverrides is type STRING`, () => {
      const overridesDef = def.propertyDefs.find(
        (pd) => pd.key === "_spiceModelOverrides",
      );
      expect(overridesDef!.type).toBe(PropertyType.STRING);
    });

    it(`${def.name}: _spiceModelOverrides has empty string default`, () => {
      const overridesDef = def.propertyDefs.find(
        (pd) => pd.key === "_spiceModelOverrides",
      );
      expect(overridesDef!.defaultValue).toBe("");
    });

    it(`${def.name}: _spiceModelOverrides is marked hidden`, () => {
      const overridesDef = def.propertyDefs.find(
        (pd) => pd.key === "_spiceModelOverrides",
      );
      expect(overridesDef!.hidden).toBe(true);
    });

    it(`${def.name}: _spiceModelOverrides does not appear in non-hidden defs`, () => {
      const visibleDefs = def.propertyDefs.filter((pd) => !pd.hidden);
      const found = visibleDefs.find((pd) => pd.key === "_spiceModelOverrides");
      expect(found).toBeUndefined();
    });
  }
});
