import { describe, it, expect } from "vitest";

import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { Circuit } from "../../../core/circuit.js";
import type { ComponentSpec } from "../../../headless/netlist-types.js";

// ---------------------------------------------------------------------------
// Canonical helper- build a digital test rig that exposes every input/output
// pin of a Function component as a labeled In/Out so signals can be driven
// and observed via facade.setSignal / facade.readSignal.
//
// Canon Cat 9 (Bridge / digital interaction): Function has only models.digital,
// so the canonical surface is the digital signal pipeline. buildFixture is not
// applicable to digital-only circuits (build-fixture.ts:99-102 throws), and
// the component has no analog domain to compare via ComparisonSession. The
// sanctioned alternative for this capability gate is the facade's digital
// signal API, which routes to coordinator.writeSignal / coordinator.readSignal
// (default-facade.ts:181-213).
// ---------------------------------------------------------------------------

function buildFunctionRig(args: {
  facade: DefaultSimulatorFacade;
  inputCount: number;
  outputCount: number;
  truthTable: number[];
}): Circuit {
  const { facade, inputCount, outputCount, truthTable } = args;

  const components: ComponentSpec[] = [
    {
      id: "fn",
      type: "Function",
      props: {
        label: "fn",
        inputCount,
        outputCount,
        truthTable,
      },
    },
  ];
  const connections: Array<[string, string]> = [];

  for (let i = 0; i < inputCount; i++) {
    components.push({ id: `IN${i}`, type: "In", props: { label: `IN${i}`, bitWidth: 1 } });
    connections.push([`IN${i}:out`, `fn:in${i}`]);
  }

  if (outputCount === 1) {
    components.push({ id: "OUT", type: "Out", props: { label: "OUT", bitWidth: 1 } });
    connections.push(["fn:out", "OUT:in"]);
  } else {
    for (let o = 0; o < outputCount; o++) {
      components.push({ id: `OUT${o}`, type: "Out", props: { label: `OUT${o}`, bitWidth: 1 } });
      connections.push([`fn:out${o}`, `OUT${o}:in`]);
    }
  }

  return facade.build({ components, connections });
}

async function driveAndRead(args: {
  facade: DefaultSimulatorFacade;
  circuit: Circuit;
  inputs: number[];
  outputLabels: readonly string[];
}): Promise<number[]> {
  const coordinator = args.facade.compile(args.circuit);
  for (let i = 0; i < args.inputs.length; i++) {
    args.facade.setSignal(coordinator, `IN${i}`, args.inputs[i] & 1);
  }
  await args.facade.settle(coordinator);
  return args.outputLabels.map((label) => args.facade.readSignal(coordinator, label));
}

// ===========================================================================
// Canon Cat 9- Bridge / digital interaction (T1 via DefaultSimulatorFacade)
//
// Each it() drives Function inputs through digital In components and reads
// the output through digital Out components. The truth table is the user-
// facing contract; these are the canonical assertions of that contract.
// ===========================================================================

describe("Function (digital) - canonical bridge / digital interaction (T1)", () => {
  it("AND truth table drives single output through every input combination", async () => {
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = buildFunctionRig({
      facade,
      inputCount: 2,
      outputCount: 1,
      truthTable: [0, 0, 0, 1],
    });

    // Inputs in0=LSB, in1=MSB. Expected outputs at each (in1,in0) pair.
    expect(await driveAndRead({ facade, circuit, inputs: [0, 0], outputLabels: ["OUT"] })).toEqual([0]);
    expect(await driveAndRead({ facade, circuit, inputs: [1, 0], outputLabels: ["OUT"] })).toEqual([0]);
    expect(await driveAndRead({ facade, circuit, inputs: [0, 1], outputLabels: ["OUT"] })).toEqual([0]);
    expect(await driveAndRead({ facade, circuit, inputs: [1, 1], outputLabels: ["OUT"] })).toEqual([1]);
  });

  it("OR truth table drives single output through every input combination", async () => {
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = buildFunctionRig({
      facade,
      inputCount: 2,
      outputCount: 1,
      truthTable: [0, 1, 1, 1],
    });

    expect(await driveAndRead({ facade, circuit, inputs: [0, 0], outputLabels: ["OUT"] })).toEqual([0]);
    expect(await driveAndRead({ facade, circuit, inputs: [1, 0], outputLabels: ["OUT"] })).toEqual([1]);
    expect(await driveAndRead({ facade, circuit, inputs: [0, 1], outputLabels: ["OUT"] })).toEqual([1]);
    expect(await driveAndRead({ facade, circuit, inputs: [1, 1], outputLabels: ["OUT"] })).toEqual([1]);
  });

  it("XOR truth table drives single output through every input combination", async () => {
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = buildFunctionRig({
      facade,
      inputCount: 2,
      outputCount: 1,
      truthTable: [0, 1, 1, 0],
    });

    expect(await driveAndRead({ facade, circuit, inputs: [0, 0], outputLabels: ["OUT"] })).toEqual([0]);
    expect(await driveAndRead({ facade, circuit, inputs: [1, 0], outputLabels: ["OUT"] })).toEqual([1]);
    expect(await driveAndRead({ facade, circuit, inputs: [0, 1], outputLabels: ["OUT"] })).toEqual([1]);
    expect(await driveAndRead({ facade, circuit, inputs: [1, 1], outputLabels: ["OUT"] })).toEqual([0]);
  });

  it("NOT (1-input) truth table drives output through both input states", async () => {
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = buildFunctionRig({
      facade,
      inputCount: 1,
      outputCount: 1,
      truthTable: [1, 0],
    });

    expect(await driveAndRead({ facade, circuit, inputs: [0], outputLabels: ["OUT"] })).toEqual([1]);
    expect(await driveAndRead({ facade, circuit, inputs: [1], outputLabels: ["OUT"] })).toEqual([0]);
  });

  it("3-input majority function drives output for representative rows", async () => {
    // Majority: output is 1 when 2+ of 3 inputs are HIGH.
    // Rows index = (in2<<2)|(in1<<1)|in0. Table[0..7]:
    //   000=0, 001=0, 010=0, 011=1, 100=0, 101=1, 110=1, 111=1
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = buildFunctionRig({
      facade,
      inputCount: 3,
      outputCount: 1,
      truthTable: [0, 0, 0, 1, 0, 1, 1, 1],
    });

    // [in0, in1, in2] = [1, 1, 0] - index 0b011 = 3 - majority
    expect(await driveAndRead({ facade, circuit, inputs: [1, 1, 0], outputLabels: ["OUT"] })).toEqual([1]);
    // [1, 0, 0] - index 0b001 = 1 - minority
    expect(await driveAndRead({ facade, circuit, inputs: [1, 0, 0], outputLabels: ["OUT"] })).toEqual([0]);
    // [1, 1, 1] - index 7 - all-high
    expect(await driveAndRead({ facade, circuit, inputs: [1, 1, 1], outputLabels: ["OUT"] })).toEqual([1]);
    // [0, 0, 0] - index 0 - all-low
    expect(await driveAndRead({ facade, circuit, inputs: [0, 0, 0], outputLabels: ["OUT"] })).toEqual([0]);
  });

  it("multi-output function emits each output bit independently", async () => {
    // Truth table values: [0, 1, 2, 3]. Two outputs:
    //   out0 = bit0 of value, out1 = bit1 of value.
    // Row 0 (in=00) -> 0  -> [0, 0]
    // Row 1 (in=01) -> 1  -> [1, 0]   (in0=1,in1=0 -> idx=1)
    // Row 2 (in=10) -> 2  -> [0, 1]   (in0=0,in1=1 -> idx=2)
    // Row 3 (in=11) -> 3  -> [1, 1]
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = buildFunctionRig({
      facade,
      inputCount: 2,
      outputCount: 2,
      truthTable: [0, 1, 2, 3],
    });

    expect(await driveAndRead({ facade, circuit, inputs: [0, 0], outputLabels: ["OUT0", "OUT1"] })).toEqual([0, 0]);
    expect(await driveAndRead({ facade, circuit, inputs: [1, 0], outputLabels: ["OUT0", "OUT1"] })).toEqual([1, 0]);
    expect(await driveAndRead({ facade, circuit, inputs: [0, 1], outputLabels: ["OUT0", "OUT1"] })).toEqual([0, 1]);
    expect(await driveAndRead({ facade, circuit, inputs: [1, 1], outputLabels: ["OUT0", "OUT1"] })).toEqual([1, 1]);
  });

  it("don't-care entries (-1) emit zero on every output bit", async () => {
    // Table: row 0 don't-care, row 1 = 1, row 2 = 0, row 3 don't-care.
    // Per truth-table contract, don't-care -> 0 on every output bit.
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = buildFunctionRig({
      facade,
      inputCount: 2,
      outputCount: 1,
      truthTable: [-1, 1, 0, -1],
    });

    expect(await driveAndRead({ facade, circuit, inputs: [0, 0], outputLabels: ["OUT"] })).toEqual([0]); // row 0 - dont-care
    expect(await driveAndRead({ facade, circuit, inputs: [1, 0], outputLabels: ["OUT"] })).toEqual([1]); // row 1 - explicit 1
    expect(await driveAndRead({ facade, circuit, inputs: [0, 1], outputLabels: ["OUT"] })).toEqual([0]); // row 2 - explicit 0
    expect(await driveAndRead({ facade, circuit, inputs: [1, 1], outputLabels: ["OUT"] })).toEqual([0]); // row 3 - dont-care
  });

  it("don't-care row on a multi-output function emits zero on every bit", async () => {
    // Table: row 0 don't-care, rows 1..3 explicit. With outputCount=2,
    // don't-care must zero both bits even when other rows hold non-zero values.
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = buildFunctionRig({
      facade,
      inputCount: 2,
      outputCount: 2,
      truthTable: [-1, 3, 2, 1],
    });

    expect(await driveAndRead({ facade, circuit, inputs: [0, 0], outputLabels: ["OUT0", "OUT1"] })).toEqual([0, 0]);
    expect(await driveAndRead({ facade, circuit, inputs: [1, 0], outputLabels: ["OUT0", "OUT1"] })).toEqual([1, 1]); // value 3 = 0b11
    expect(await driveAndRead({ facade, circuit, inputs: [0, 1], outputLabels: ["OUT0", "OUT1"] })).toEqual([0, 1]); // value 2 = 0b10
    expect(await driveAndRead({ facade, circuit, inputs: [1, 1], outputLabels: ["OUT0", "OUT1"] })).toEqual([1, 0]); // value 1 = 0b01
  });
});
