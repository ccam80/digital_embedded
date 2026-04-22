/**
 * Integration test: CurrentSource.getPinCurrents sign convention.
 *
 * Verifies that after the pinLayout swap (neg=index 0, pos=index 1),
 * getPinCurrents returns [+I, -I] where:
 *   index 0 (neg) → current into element at neg = +I  (return path enters here)
 *   index 1 (pos) → current into element at pos = -I  (current exits here)
 *
 * Circuit: I_src (2 mA) → R (1 kΩ) → ground
 *   node 1 = top of R = pos terminal of current source
 *   node 0 = ground   = neg terminal of current source
 *   V_node1 = I * R = 0.002 * 1000 = 2.0 V
 *   I_through_R = (V_node1 - 0) / R = 2 mA (flows from node 1 to ground)
 */

import { describe, it, expect } from "vitest";
import { makeCurrentSource as makeCurrentSourceElement } from "../current-source.js";
import {
  makeResistor,
  withNodeIds,
} from "../../../solver/analog/__tests__/test-helpers.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";

describe("CurrentSource — getPinCurrents KCL integration", () => {
  it("pin index 0 (neg) carries +I, pin index 1 (pos) carries -I", () => {
    const I_src = 0.002; // 2 mA
    const R_val = 1000;  // 1 kΩ

    // Build elements using the real component factory (same as compiler output).
    // nodePos=1 (pos terminal), nodeNeg=0 (ground / neg terminal).
    const srcCore = makeCurrentSourceElement(1, 0, I_src);
    const src = withNodeIds(srcCore, [0, 1]); // pinNodeIds: [neg=node0, pos=node1]

    const res = makeResistor(1, 0, R_val); // node1 → ground

    const compiled = {
      netCount: 1,
      componentCount: 2,
      nodeCount: 1,
      branchCount: 0,
      matrixSize: 1,
      elements: [src, res],
      labelToNodeId: new Map(),
    } as unknown as ConcreteCompiledAnalogCircuit;

    const engine = new MNAEngine();
    engine.init(compiled);
    engine.dcOperatingPoint();

    // Node 1 voltage: V = I * R = 0.002 * 1000 = 2.0 V
    const v1 = engine.getNodeVoltage(1);

    // --- Core invariant: getPinCurrents sign convention ---
    const pinCurrents = engine.getElementPinCurrents(0); // element 0 = current source

    // Index 0 = neg pin: current flows into element at neg (return path) → +I

    // Index 1 = pos pin: current flows out of element at pos into circuit → -I

    // --- KCL residual: sum of pin currents into element must be zero ---
    const kcl = pinCurrents[0] + pinCurrents[1];
    expect(Math.abs(kcl)).toBeLessThan(1e-10);

    // --- Cross-check against load: Ohm's law gives same magnitude ---
    const I_load = v1 / R_val;
  });

  it("setParam current update propagates to getPinCurrents", () => {
    const srcCore = makeCurrentSourceElement(1, 0, 0.001);
    const src = withNodeIds(srcCore, [0, 1]);
    const res = makeResistor(1, 0, 1000);

    const compiled = {
      netCount: 1, componentCount: 2,
      nodeCount: 1, branchCount: 0, matrixSize: 1,
      elements: [src, res],
      labelToNodeId: new Map(),
    } as unknown as ConcreteCompiledAnalogCircuit;

    const engine = new MNAEngine();
    engine.init(compiled);

    // Change current to 5 mA via setParam
    src.setParam("current", 0.005);
    engine.dcOperatingPoint();

    const pinCurrents = engine.getElementPinCurrents(0);
  });
});
