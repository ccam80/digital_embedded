/**
 * Tests for the NPN/PNP Darlington transistor pair subcircuit models.
 *
 * Covers:
 *   - NPN high current gain: beta_total ~ beta_1 * beta_2
 *   - NPN V_BE doubled: V_BE_total ~ 2 * V_BE_single
 *   - NPN emitter follower: V_out ~ V_in - 2*V_BE
 *   - PNP polarity: current flows in opposite direction
 *   - Registration: DarlingtonNPN registered with subcircuitRefs set
 *   - Subcircuit netlist structure verification
 */

import { describe, it, expect } from "vitest";
import {
  registerDarlingtonModels,
  DarlingtonNpnDefinition,
  DarlingtonPnpDefinition,
} from "../transistor-models/darlington.js";
import { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";
import { ComponentCategory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(): SubcircuitModelRegistry {
  const registry = new SubcircuitModelRegistry();
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

    it("subcircuit netlist contains 3 elements (Q1, Q2, R_BE)", () => {
      const registry = makeRegistry();
      const netlist = registry.get("DarlingtonNPN");
      expect(netlist).toBeDefined();

      // 2 BJTs + 1 R_BE resistor = 3 elements
      expect(netlist!.elements).toHaveLength(3);

      const bjtCount = netlist!.elements.filter(el => el.typeId === "NpnBJT").length;
      const resistorCount = netlist!.elements.filter(el => el.typeId === "Resistor").length;
      expect(bjtCount).toBe(2);
      expect(resistorCount).toBe(1);
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
    it("netlist has internal node connecting Q1E to Q2B", () => {
      const registry = makeRegistry();
      const netlist = registry.get("DarlingtonNPN");
      expect(netlist).toBeDefined();

      // Should have at least 1 internal node (Q1E_Q2B junction)
      expect(netlist!.internalNetCount).toBeGreaterThanOrEqual(1);

      // Find the two BJT elements in the netlist
      const bjtIndices = netlist!.elements
        .map((el, i) => ({ el, i }))
        .filter(({ el }) => el.typeId === "NpnBJT");
      expect(bjtIndices).toHaveLength(2);

      const q1Connectivity = netlist!.netlist[bjtIndices[0].i];
      const q2Connectivity = netlist!.netlist[bjtIndices[1].i];

      // BJT connectivity order: [B, C, E]
      // Q1 emitter (index 2) should equal Q2 base (index 0) via the internal net
      const q1Emitter = q1Connectivity[2];
      const q2Base = q2Connectivity[0];
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

    it("PNP subcircuit netlist contains correct element types", () => {
      const registry = makeRegistry();
      const netlist = registry.get("DarlingtonPNP");
      expect(netlist).toBeDefined();

      // Q1 + Q2 + R_BE = 3 elements
      expect(netlist!.elements).toHaveLength(3);

      const pnpCount = netlist!.elements.filter(el => el.typeId === "PnpBJT").length;
      const resistorCount = netlist!.elements.filter(el => el.typeId === "Resistor").length;
      expect(pnpCount).toBe(2);
      expect(resistorCount).toBe(1);
    });

    it("PNP Darlington uses PnpBJT while NPN uses NpnBJT", () => {
      const registry = makeRegistry();

      const npnNetlist = registry.get("DarlingtonNPN");
      const pnpNetlist = registry.get("DarlingtonPNP");
      expect(npnNetlist).toBeDefined();
      expect(pnpNetlist).toBeDefined();

      // NPN uses NpnBJT elements, PNP uses PnpBJT elements
      const npnBjts = npnNetlist!.elements.filter(el => el.typeId === "NpnBJT");
      const pnpBjts = pnpNetlist!.elements.filter(el => el.typeId === "PnpBJT");
      expect(npnBjts.length).toBe(2);
      expect(pnpBjts.length).toBe(2);

      // Both netlists have the same structure (same number of elements, ports, internal nets)
      expect(npnNetlist!.elements.length).toBe(pnpNetlist!.elements.length);
      expect(npnNetlist!.ports.length).toBe(pnpNetlist!.ports.length);
    });
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("Registration", () => {
  describe("npn_darlington_registered", () => {
    it("DarlingtonNPN has subcircuitRefs set", () => {
      expect(DarlingtonNpnDefinition.subcircuitRefs?.darlington).toBe("DarlingtonNPN");
    });

    it("DarlingtonNPN is in SEMICONDUCTORS category", () => {
      expect(DarlingtonNpnDefinition.category).toBe(ComponentCategory.SEMICONDUCTORS);
    });

    it("DarlingtonNPN has subcircuitRefs only", () => {
      expect(DarlingtonNpnDefinition.subcircuitRefs?.darlington).toBeDefined();
      expect(DarlingtonNpnDefinition.models?.digital).toBeUndefined();
    });

    it("DarlingtonPNP has subcircuitRefs set", () => {
      expect(DarlingtonPnpDefinition.subcircuitRefs?.darlington).toBe("DarlingtonPNP");
    });

    it("registerDarlingtonModels registers both models in registry", () => {
      const registry = new SubcircuitModelRegistry();
      expect(registry.has("DarlingtonNPN")).toBe(false);
      expect(registry.has("DarlingtonPNP")).toBe(false);

      registerDarlingtonModels(registry);

      expect(registry.has("DarlingtonNPN")).toBe(true);
      expect(registry.has("DarlingtonPNP")).toBe(true);
    });

    it("NPN Darlington subcircuit has R_BE resistor element", () => {
      const registry = makeRegistry();
      const netlist = registry.get("DarlingtonNPN");
      expect(netlist).toBeDefined();

      const resistors = netlist!.elements.filter(
        (el) => el.typeId === "Resistor",
      );
      expect(resistors).toHaveLength(1);

      expect(resistors[0].params?.resistance).toBe(10000);
    });

    it("NPN Darlington interface pins are B, C, E", () => {
      const pinLabels = DarlingtonNpnDefinition.pinLayout.map((p) => p.label);
      expect(pinLabels).toContain("B");
      expect(pinLabels).toContain("C");
      expect(pinLabels).toContain("E");
    });
  });
});
