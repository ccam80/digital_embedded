/**
 * Tests for the Potentiometer component.
 *
 * Covers:
 *   - Conductance stamp computation for both top and bottom resistors
 *   - Position-based resistance splitting
 *   - Edge cases (position 0 and 1)
 *   - Clamping to minimum resistance
 *   - Component definition completeness
 *   - Voltage divider integration test
 */

import { describe, it, expect } from "vitest";
import {
  PotentiometerDefinition,
  POTENTIOMETER_ATTRIBUTE_MAPPINGS,
} from "../potentiometer.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { makeLoadCtx, makeTestSetupContext } from "../../../solver/analog/__tests__/test-helpers.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";


// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { vi } from "vitest";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

function makeCaptureSolver(): { solver: SparseSolverType; stamps: [number, number, number][] } {
  const stamps: [number, number, number][] = [];
  const solver = {
    allocElement: vi.fn((row: number, col: number) => {
      stamps.push([row, col, 0]);
      return stamps.length - 1;
    }),
    stampElement: vi.fn((h: number, v: number) => {
      stamps[h][2] += v;
    }),
    stampRHS: vi.fn((_row: number, _v: number) => {}),
  } as unknown as SparseSolverType;
  return { solver, stamps };
}

// ---------------------------------------------------------------------------
// stamps_two_conductance_pairs tests
// ---------------------------------------------------------------------------

describe("Potentiometer", () => {
  describe("stamps_two_conductance_pairs", () => {
    it("stamps 8 conductance entries for position 0.5", () => {
      const props = new PropertyBag();
      props.setModelParam("resistance", 10000);
      props.setModelParam("position", 0.5);

      const analogElement = getFactory(PotentiometerDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2], ["W", 3]]),
        props,
        () => 0,
      );

      const { solver, stamps } = makeCaptureSolver();
      const setupCtx = makeTestSetupContext({ solver });
      analogElement.setup(setupCtx);
      const ctx = makeLoadCtx({ solver });
      analogElement.load(ctx);

      expect(stamps.length).toBe(8);

      // Nodes are 1-based: A=1, B=2, W=3. The capture solver records raw node IDs.
      // Top resistor: A(1) ↔ W(3) (A↔W)
      const topStamps = stamps.filter((s) => (s[0] === 1 || s[0] === 3) && (s[1] === 1 || s[1] === 3));
      expect(topStamps.some((s) => Math.abs(s[2] - 0.0002) < 1e-6)).toBe(true);

      // Bottom resistor: W(3) ↔ B(2) (W↔B)
      const bottomStamps = stamps.filter((s) => (s[0] === 3 || s[0] === 2) && (s[1] === 3 || s[1] === 2));
      expect(bottomStamps.some((s) => Math.abs(s[2] - 0.0002) < 1e-6)).toBe(true);
    });
  });

  describe("position_0_gives_full_resistance_on_bottom", () => {
    it("position=0 clamps R_top to minimum and R_bottom to full", () => {
      const props = new PropertyBag();
      props.setModelParam("resistance", 10000);
      props.setModelParam("position", 0);

      const analogElement = getFactory(PotentiometerDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2], ["W", 3]]),
        props,
        () => 0,
      );

      const { solver, stamps } = makeCaptureSolver();
      const setupCtx = makeTestSetupContext({ solver });
      analogElement.setup(setupCtx);
      const ctx = makeLoadCtx({ solver });
      analogElement.load(ctx);

      // Nodes are 1-based: A=1, W=3, B=2. Top resistor (R_AW): A(1) ↔ W(3). Bottom resistor (R_WB): W(3) ↔ B(2).
      // Top resistance is 0, clamped to 1e-9: G_AW = 1/(1e-9) = 1e9- A(1) ↔ W(3)
      // Bottom resistance is 10000: G_WB = 1/10000 = 0.0001- W(3) ↔ B(2)
      const topStamps = stamps.filter((s) => (s[0] === 1 || s[0] === 3) && (s[1] === 1 || s[1] === 3));
      const bottomStamps = stamps.filter((s) => (s[0] === 3 || s[0] === 2) && (s[1] === 3 || s[1] === 2));

      expect(topStamps.some((s) => s[2] > 1e8)).toBe(true); // Very large G_top
      expect(bottomStamps.some((s) => Math.abs(s[2] - 0.0001) < 1e-6)).toBe(true);
    });
  });

  describe("position_1_gives_full_resistance_on_top", () => {
    it("position=1 clamps R_bottom to minimum and R_top to full", () => {
      const props = new PropertyBag();
      props.setModelParam("resistance", 10000);
      props.setModelParam("position", 1);

      const analogElement = getFactory(PotentiometerDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2], ["W", 3]]),
        props,
        () => 0,
      );

      const { solver, stamps } = makeCaptureSolver();
      const setupCtx = makeTestSetupContext({ solver });
      analogElement.setup(setupCtx);
      const ctx = makeLoadCtx({ solver });
      analogElement.load(ctx);

      // Nodes are 1-based: A=1, W=3, B=2. Top resistor (R_AW): A(1) ↔ W(3). Bottom resistor (R_WB): W(3) ↔ B(2).
      // Top resistance is 10000: G_AW = 1/10000 = 0.0001- A(1) ↔ W(3)
      // Bottom resistance is 0, clamped to 1e-9: G_WB = 1/(1e-9) = 1e9- W(3) ↔ B(2)
      const topStamps = stamps.filter((s) => (s[0] === 1 || s[0] === 3) && (s[1] === 1 || s[1] === 3));
      const bottomStamps = stamps.filter((s) => (s[0] === 3 || s[0] === 2) && (s[1] === 3 || s[1] === 2));

      expect(topStamps.some((s) => Math.abs(s[2] - 0.0001) < 1e-6)).toBe(true);
      expect(bottomStamps.some((s) => s[2] > 1e8)).toBe(true); // Very large G_WB
    });
  });

  describe("definition", () => {
    it("PotentiometerDefinition name is 'Potentiometer'", () => {
      expect(PotentiometerDefinition.name).toBe("Potentiometer");
    });

    it("PotentiometerDefinition has analog model", () => {
      expect(PotentiometerDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("PotentiometerDefinition has analogFactory", () => {
      expect((PotentiometerDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    });

    it("PotentiometerDefinition category is PASSIVES", () => {
      expect(PotentiometerDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("PotentiometerDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(PotentiometerDefinition)).not.toThrow();
    });
  });

  describe("pinLayout", () => {
    it("PotentiometerDefinition.pinLayout has 3 entries (A, B, W)", () => {
      expect(PotentiometerDefinition.pinLayout).toHaveLength(3);
      expect(PotentiometerDefinition.pinLayout[0].label).toBe("A");
      expect(PotentiometerDefinition.pinLayout[1].label).toBe("B");
      expect(PotentiometerDefinition.pinLayout[2].label).toBe("W");
    });
  });

  describe("attributeMapping", () => {
    it("resistance maps to resistance property", () => {
      const m = POTENTIOMETER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "resistance");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("resistance");
    });

    it("position maps to position property", () => {
      const m = POTENTIOMETER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "position");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("position");
    });

    it("Label maps to label property", () => {
      const m = POTENTIOMETER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("R1")).toBe("R1");
    });
  });
});

// ---------------------------------------------------------------------------
// potentiometer_load_dcop_parity- C4.1 / Task 6.2.1
//
// Pot at wiper=0.5, 10kΩ total. Each half is 5kΩ → G = 1/5000.
//
// NGSPICE reference: resload.c:16-41 (function RESload, four stamps per
// resistor segment). Potentiometer = two series resistors sharing wiper W.
//   Top resistor (A↔W):   G_top = 1/R_top = 1/(10000*0.5) = 1/5000
//   Bottom resistor (W↔B): G_bottom = 1/R_bottom = 1/(10000*0.5) = 1/5000
// Diagonal totals: (rA,rA)=G_AW, (rB,rB)=G_WB, (rW,rW)=G_AW+G_WB.
// ---------------------------------------------------------------------------

describe("potentiometer_load_dcop_parity", () => {
  it("wiper=0.5 10kΩ pot G_top=G_bottom=1/5000 bit-exact", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1.0 } },
            { id: "pot", type: "Potentiometer",   props: { label: "pot", resistance: 10000, position: 0.5 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "pot:pos"],
            ["pot:neg", "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const detail = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const lastIter = detail.iterations[detail.iterations.length - 1].ours!;
    const N = lastIter.matrixSize - 2;
    const M = lastIter.matrix!;
    const rowOf = (tag: string) => {
      for (const [row, label] of session.ourTopology.matrixRowLabels.entries()) {
        if (label.includes(tag)) return row;
      }
      throw new Error(`row not found: ${tag}`);
    };
    const rA = rowOf("pot:pos");
    const rB = rowOf("pot:neg");
    const rW = rowOf("pot:W");
    const G = 1 / 5000;
    expect(M[rA * N + rA]).toBe(G);
    expect(M[rB * N + rB]).toBe(G);
    expect(M[rW * N + rW]).toBe(G + G);   // 0.0004- wiper shared diagonal
    expect(M[rA * N + rW]).toBe(-G);
    expect(M[rW * N + rB]).toBe(-G);
  });
});
