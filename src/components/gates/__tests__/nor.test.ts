import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { ComponentSpec } from "../../../headless/netlist-types.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Canon Cat 9 — Bridge / digital interaction (T1 via DefaultSimulatorFacade)
//
// NOr exposes models.digital (executeFn = executeNOr, inputSchema In_1..In_N,
// outputSchema ["out"]) and a behavioural / cmos modelRegistry. The runtime
// digital path is the only canon-relevant surface: there is no analog state
// pool, no MNA matrix, no DCOP, no junction limiting, no LTE rollback, no
// breakpoint registration, no transient dynamics paired against ngspice.
// Cats 1–5/6/7/8/10/11/12/13 do not apply.
//
// Cat 9 worked structure: drive labelled In pins (In_1..In_N) through
// facade.setSignal, advance the engine via facade.step / facade.settle,
// observe the labelled Out pin via facade.readSignal. facade.setSignal /
// step / settle / readSignal are thin wrappers over the sanctioned
// coordinator.writeSignal / step / readSignal surface (the binary canonical
// gate from Step 2b).
// ---------------------------------------------------------------------------

interface NorRig {
  facade: DefaultSimulatorFacade;
  coord: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function buildNorRig(args: { inputCount: number; bitWidth?: number }): NorRig {
  const { inputCount, bitWidth = 1 } = args;
  const facade = new DefaultSimulatorFacade(registry);

  const components: ComponentSpec[] = [
    { id: "g", type: "NOr", props: { inputCount, bitWidth } },
    { id: "OUT", type: "Out", props: { label: "OUT", bitWidth } },
  ];
  const connections: Array<[string, string]> = [["g:out", "OUT:in"]];

  for (let i = 0; i < inputCount; i++) {
    const label = `IN${i + 1}`;
    components.push({ id: label, type: "In", props: { label, bitWidth } });
    connections.push([`${label}:out`, `g:In_${i + 1}`]);
  }

  const coord = facade.compile(facade.build({ components, connections }));
  return { facade, coord };
}

async function driveAndRead(rig: NorRig, inputs: number[]): Promise<number> {
  for (let i = 0; i < inputs.length; i++) {
    rig.facade.setSignal(rig.coord, `IN${i + 1}`, inputs[i]);
  }
  await rig.facade.settle(rig.coord);
  return rig.facade.readSignal(rig.coord, "OUT");
}

describe("NOr gate — digital bridge (T1)", () => {
  // -------------------------------------------------------------------------
  // 2-input truth table (NOR): out = ~(a | b)
  // -------------------------------------------------------------------------

  it("nor2_zero_zero_drives_out_high", async () => {
    const rig = buildNorRig({ inputCount: 2 });
    expect(await driveAndRead(rig, [0, 0])).toBe(1);
  });

  it("nor2_one_zero_drives_out_low", async () => {
    const rig = buildNorRig({ inputCount: 2 });
    expect(await driveAndRead(rig, [1, 0])).toBe(0);
  });

  it("nor2_zero_one_drives_out_low", async () => {
    const rig = buildNorRig({ inputCount: 2 });
    expect(await driveAndRead(rig, [0, 1])).toBe(0);
  });

  it("nor2_one_one_drives_out_low", async () => {
    const rig = buildNorRig({ inputCount: 2 });
    expect(await driveAndRead(rig, [1, 1])).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3-input NOR: out high only when all inputs are 0.
  // -------------------------------------------------------------------------

  it("nor3_all_zero_drives_out_high", async () => {
    const rig = buildNorRig({ inputCount: 3 });
    expect(await driveAndRead(rig, [0, 0, 0])).toBe(1);
  });

  it("nor3_one_input_high_drives_out_low", async () => {
    const rig = buildNorRig({ inputCount: 3 });
    expect(await driveAndRead(rig, [0, 1, 0])).toBe(0);
  });

  it("nor3_all_inputs_high_drives_out_low", async () => {
    const rig = buildNorRig({ inputCount: 3 });
    expect(await driveAndRead(rig, [1, 1, 1])).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Multi-bit NOR — bitwise per-bit NOR across the bus.
  // bitWidth=8: out = ~(a | b) & 0xFF.
  // -------------------------------------------------------------------------

  it("nor2_8bit_complementary_inputs_drive_out_zero", async () => {
    // 0xF0 | 0x0F = 0xFF → ~0xFF & 0xFF = 0x00.
    const rig = buildNorRig({ inputCount: 2, bitWidth: 8 });
    expect(await driveAndRead(rig, [0xF0, 0x0F])).toBe(0x00);
  });

  it("nor2_8bit_zero_zero_drives_out_all_ones", async () => {
    // ~0x00 & 0xFF = 0xFF.
    const rig = buildNorRig({ inputCount: 2, bitWidth: 8 });
    expect(await driveAndRead(rig, [0x00, 0x00])).toBe(0xFF);
  });

  it("nor2_8bit_mixed_overlap_masks_to_byte_width", async () => {
    // 0xA0 | 0x05 = 0xA5 → ~0xA5 & 0xFF = 0x5A.
    const rig = buildNorRig({ inputCount: 2, bitWidth: 8 });
    expect(await driveAndRead(rig, [0xA0, 0x05])).toBe(0x5A);
  });

  it("nor3_8bit_disjoint_bits_drive_zero", async () => {
    // 0x01 | 0x02 | 0x04 = 0x07 → ~0x07 & 0xFF = 0xF8.
    const rig = buildNorRig({ inputCount: 3, bitWidth: 8 });
    expect(await driveAndRead(rig, [0x01, 0x02, 0x04])).toBe(0xF8);
  });
});
