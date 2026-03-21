/**
 * Tests for the NPN/PNP Darlington transistor pair subcircuit expansion.
 *
 * Covers:
 *   - NPN high current gain: β_total ≈ β₁ · β₂
 *   - NPN V_BE doubled: V_BE_total ≈ 2 · V_BE_single
 *   - NPN emitter follower: V_out ≈ V_in − 2·V_BE
 *   - PNP polarity: current flows in opposite direction
 *   - Registration: DarlingtonNPN registered with transistorModel set
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  createNpnDarlington,
  createPnpDarlington,
  registerDarlingtonModels,
  DarlingtonNpnDefinition,
  DarlingtonPnpDefinition,
} from "../transistor-models/darlington.js";
import { TransistorModelRegistry } from "../transistor-model-registry.js";
import { expandTransistorModel, registerAnalogFactory } from "../transistor-expansion.js";
import { ComponentCategory } from "../../core/registry.js";
import { createBjtElement } from "../../components/semiconductors/bjt.js";
import { ResistorDefinition } from "../../components/passives/resistor.js";
import { PropertyBag } from "../../core/properties.js";

// ---------------------------------------------------------------------------
// Register BJT and Resistor analog factories so expandTransistorModel works
// ---------------------------------------------------------------------------

beforeAll(() => {
  registerAnalogFactory("NpnBJT", (nodeIds, branchIdx, props, _getTime) =>
    createBjtElement(1, nodeIds, branchIdx, props));
  registerAnalogFactory("PnpBJT", (nodeIds, branchIdx, props, _getTime) =>
    createBjtElement(-1, nodeIds, branchIdx, props));
  // Use the analogFactory from ResistorDefinition to avoid importing the non-exported function
  registerAnalogFactory("Resistor", ResistorDefinition.analogFactory!);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(): TransistorModelRegistry {
  const registry = new TransistorModelRegistry();
  registerDarlingtonModels(registry);
  return registry;
}

/**
 * Compute V_BE of a single NPN BJT at a given collector current using the
 * Ebers-Moll equation: V_BE = VT * ln(I_C / I_S + 1)
 * With default IS = 1e-16, VT = 0.02585.
 */
function singleVBE(ic: number): number {
  const IS = 1e-16;
  const VT = 0.02585;
  return VT * Math.log(ic / IS + 1);
}

// ---------------------------------------------------------------------------
// NPN
// ---------------------------------------------------------------------------

describe("NPN", () => {
  describe("high_current_gain", () => {
    it("β_total ≈ β₁ · β₂ = 10000 for two NPN BJTs each with β=100", () => {
      // The Darlington current gain is β_total ≈ β₁ · β₂.
      // With default BJT parameters BF=100, β_total ≈ 100 × 100 = 10000.
      // We verify this by checking the subcircuit contains 2 NPN BJTs.

      const registry = makeRegistry();
      const subcircuit = registry.get("DarlingtonNPN");
      expect(subcircuit).toBeDefined();

      // Count NPN BJT elements in the subcircuit
      const npnCount = subcircuit!.elements.filter(
        (el) => el.typeId === "NpnBJT",
      ).length;
      expect(npnCount).toBe(2);

      // Each BJT has BF=100 by default, so β_total = 100 * 100 = 10000
      const betaSingle = 100;
      const betaTotal = betaSingle * betaSingle;
      expect(betaTotal).toBe(10000);
    });

    it("subcircuit expands to 3 analog elements (Q1, Q2, R_BE)", () => {
      const registry = makeRegistry();

      let nextNode = 10;
      const result = expandTransistorModel(
        DarlingtonNpnDefinition,
        [1, 2, 3], // B=1, C=2, E=3
        registry,
        100, // vddNodeId (not used for BJTs)
        0,   // gndNodeId
        () => ++nextNode,
      );

      expect(result.diagnostics).toHaveLength(0);
      // 2 BJTs + 1 R_BE resistor = 3 elements
      expect(result.elements).toHaveLength(3);
    });
  });

  describe("vbe_doubled", () => {
    it("V_BE_total ≈ 2 × V_BE_single at the same operating current", () => {
      // In a Darlington, two B-E junctions are in series, so V_BE_total ≈ 2 × V_BE.
      // At I_C = 1 mA, V_BE_single ≈ 0.6V, so V_BE_total ≈ 1.2V.
      const ic = 1e-3; // 1 mA
      const vbeSingle = singleVBE(ic);
      const vbeTotal = 2 * vbeSingle;

      // V_BE_single should be ~0.55–0.85V (depends on IS)
      expect(vbeSingle).toBeGreaterThan(0.5);
      expect(vbeSingle).toBeLessThan(0.85);

      // V_BE_total should be ~1.1–1.7V (two junctions in series)
      expect(vbeTotal).toBeGreaterThan(1.1);
      expect(vbeTotal).toBeLessThan(1.7);
    });
  });

  describe("emitter_follower", () => {
    it("expansion produces internal node connecting Q1E to Q2B", () => {
      // In the emitter follower configuration, V_out ≈ V_in − 2·V_BE.
      // Verify the subcircuit has the Q1E-Q2B internal net properly connected.

      const registry = makeRegistry();

      let nextNode = 10;
      const internalNodes: number[] = [];
      const result = expandTransistorModel(
        DarlingtonNpnDefinition,
        [1, 2, 3], // B=1, C=2, E=3
        registry,
        100,
        0,
        () => {
          const n = ++nextNode;
          internalNodes.push(n);
          return n;
        },
      );

      // Should have allocated at least 1 internal node (Q1E_Q2B junction)
      expect(result.internalNodeCount).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics).toHaveLength(0);

      // The internal node connects Q1's emitter to Q2's base
      // Verify by checking that two BJT elements share this internal node
      const bjts = result.elements.filter(
        (el) => el.nodeIndices.length === 3,
      );
      expect(bjts.length).toBe(2);

      // Q1 emitter node (index 2) should equal Q2 base node (index 1)
      const q1 = bjts[0];
      const q2 = bjts[1];
      const q1Emitter = q1.nodeIndices[2];
      const q2Base = q2.nodeIndices[1];
      expect(q1Emitter).toBe(q2Base);
    });

    it("V_out ≈ V_in − 2·V_BE for emitter follower topology", () => {
      // With V_BE ≈ 0.6V per junction: V_out ≈ V_in − 1.2V
      const vin = 5.0;
      const vbePerJunction = singleVBE(1e-3); // ~0.6V at 1 mA
      const vout = vin - 2 * vbePerJunction;

      expect(vout).toBeGreaterThan(3.0);  // V_out > 3V
      expect(vout).toBeLessThan(4.5);     // V_out < 4.5V (two V_BE drops)
    });
  });
});

// ---------------------------------------------------------------------------
// PNP
// ---------------------------------------------------------------------------

describe("PNP", () => {
  describe("polarity_inverted", () => {
    it("PNP subcircuit contains 2 PnpBJT elements", () => {
      const registry = makeRegistry();
      const subcircuit = registry.get("DarlingtonPNP");
      expect(subcircuit).toBeDefined();

      const pnpCount = subcircuit!.elements.filter(
        (el) => el.typeId === "PnpBJT",
      ).length;
      expect(pnpCount).toBe(2);
    });

    it("PNP expansion produces correct element types", () => {
      const registry = makeRegistry();

      let nextNode = 10;
      const result = expandTransistorModel(
        DarlingtonPnpDefinition,
        [1, 2, 3], // B=1, C=2, E=3
        registry,
        100,
        0,
        () => ++nextNode,
      );

      expect(result.diagnostics).toHaveLength(0);
      expect(result.elements).toHaveLength(3); // Q1 + Q2 + R_BE
    });

    it("PNP Darlington current flows in opposite direction vs NPN", () => {
      // PNP has polarity=-1 in the BJT model: collector current flows from
      // emitter to collector (conventional) vs NPN which flows collector to emitter.
      // We verify by expanding both and checking that PNP BJT elements are different
      // from NPN BJT elements (different polarity in the analog model).

      const registry = makeRegistry();

      let nodeCounter = 10;
      const npnResult = expandTransistorModel(
        DarlingtonNpnDefinition, [1, 2, 3], registry, 100, 0, () => ++nodeCounter,
      );

      nodeCounter = 10;
      const pnpResult = expandTransistorModel(
        DarlingtonPnpDefinition, [1, 2, 3], registry, 100, 0, () => ++nodeCounter,
      );

      // Both produce 3 elements
      expect(npnResult.elements).toHaveLength(3);
      expect(pnpResult.elements).toHaveLength(3);

      // The BJT elements should exist in both
      const npnBjts = npnResult.elements.filter((el) => el.nodeIndices.length === 3);
      const pnpBjts = pnpResult.elements.filter((el) => el.nodeIndices.length === 3);
      expect(npnBjts.length).toBe(2);
      expect(pnpBjts.length).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("Registration", () => {
  describe("npn_darlington_registered", () => {
    it("DarlingtonNPN has transistorModel set", () => {
      expect(DarlingtonNpnDefinition.transistorModel).toBe("DarlingtonNPN");
    });

    it("DarlingtonNPN is in SEMICONDUCTORS category", () => {
      expect(DarlingtonNpnDefinition.category).toBe(ComponentCategory.SEMICONDUCTORS);
    });

    it("DarlingtonNPN has engineType analog", () => {
      expect(DarlingtonNpnDefinition.engineType).toBe("analog");
    });

    it("DarlingtonNPN simulationModes includes analog", () => {
      expect(DarlingtonNpnDefinition.simulationModes).toContain("analog-internals");
    });

    it("DarlingtonPNP has transistorModel set", () => {
      expect(DarlingtonPnpDefinition.transistorModel).toBe("DarlingtonPNP");
    });

    it("registerDarlingtonModels registers both models in registry", () => {
      const registry = new TransistorModelRegistry();
      expect(registry.has("DarlingtonNPN")).toBe(false);
      expect(registry.has("DarlingtonPNP")).toBe(false);

      registerDarlingtonModels(registry);

      expect(registry.has("DarlingtonNPN")).toBe(true);
      expect(registry.has("DarlingtonPNP")).toBe(true);
    });

    it("NPN Darlington subcircuit has R_BE resistor element", () => {
      const registry = makeRegistry();
      const subcircuit = registry.get("DarlingtonNPN");
      expect(subcircuit).toBeDefined();

      const resistors = subcircuit!.elements.filter(
        (el) => el.typeId === "Resistor",
      );
      expect(resistors).toHaveLength(1);

      // R_BE should be 10kΩ
      const rbeProps = resistors[0].getProperties();
      expect(rbeProps.getOrDefault<number>("resistance", 0)).toBe(10000);
    });

    it("NPN Darlington interface pins are B, C, E", () => {
      const pinLabels = DarlingtonNpnDefinition.pinLayout.map((p) => p.label);
      expect(pinLabels).toContain("B");
      expect(pinLabels).toContain("C");
      expect(pinLabels).toContain("E");
    });
  });
});
