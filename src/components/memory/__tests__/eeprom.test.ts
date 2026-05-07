import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";
import type { CircuitElement } from "../../../core/element.js";

// ---------------------------------------------------------------------------
// EEPROM canonical test set
//   EEPROM (5 inputs: A, CS, WE, OE, Din  /  1 output: D)
//   EEPROMDualPort (5 inputs: A, Din, str, C, ld  /  1 output: D)
//
// Canon set: 4 (parameter hot-load on initial-memory `data`) and 9
// (Bridge / digital). Categories 1, 2, 3, 5, 6, 7, 8, 10, 12, 13, 14, 15
// do not apply: pure-digital memory components, no analog domain, no NR
// convergence, no junctions, no LTE rollback, no acceptStep breakpoints,
// no modelRegistry presets, no documented forbidden combinations, no
// narrow input ports, no runtime-diagnostic emission, no PropertyBag
// writeback subscriptions.
//
// Category 11 (multi-output digital observability) does not apply: each
// component declares a single D output pin.
//
// File tier: fixture-only (T1). Each test composes a tiny digital circuit
// via facade.build + facade.compile, drives inputs through writeByLabel,
// advances simulator state via coordinator.step(), and observes outputs
// through readByLabel. Memory backing stores are auto-allocated by the
// digital engine during compile; initial contents are seeded via the
// component's `data` property.
// ---------------------------------------------------------------------------

interface EepromFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
  circuit: ReturnType<DefaultSimulatorFacade["build"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildEepromFixture(spec: {
  components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }>;
  connections: Array<[string, string]>;
}): EepromFixture {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build(spec);
  const coordinator = facade.compile(circuit);
  return { facade, coordinator, circuit };
}

function findElementByLabel(fix: EepromFixture, label: string): CircuitElement {
  const ltce = fix.coordinator.compiled.labelToCircuitElement;
  const el = ltce.get(label);
  if (el === undefined) {
    throw new Error(
      `findElementByLabel: '${label}' not in labelToCircuitElement (have: ${Array.from(ltce.keys()).join(", ")})`,
    );
  }
  return el;
}

// ===========================================================================
// EEPROM  Cat 9 (Bridge / digital)
// ===========================================================================

describe("EEPROM  bridge / digital (T1)", () => {
  it("eeprom_reads_seeded_memory_when_cs_oe_high_we_low", () => {
    // Cat 9: with the EEPROM seeded via the `data` property (auto-loaded into
    // the backing store at compile), driving A=0, CS=1, OE=1, WE=0 makes
    // executeEEPROM emit memory[0] on D. The wired Out display reads 0xAB.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "cs",   type: "In", props: { label: "CS_in", bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: "WE_in", bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: "OE_in", bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: "M", addrBits: 4, dataBits: 8, data: [0xAB] } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("A_in", digital(0));
    fix.coordinator.writeByLabel("CS_in", digital(1));
    fix.coordinator.writeByLabel("WE_in", digital(0));
    fix.coordinator.writeByLabel("OE_in", digital(1));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0xAB });

    fix.coordinator.dispose();
  });

  it("eeprom_cs_low_suppresses_read_output_to_zero", () => {
    // Cat 9: CS=0 disables the chip; executeEEPROM writes 0 to D regardless
    // of memory contents. Seed memory[0]=0xFF and confirm Out reads 0.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "cs",   type: "In", props: { label: "CS_in", bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: "WE_in", bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: "OE_in", bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: "M", addrBits: 4, dataBits: 8, data: [0xFF] } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("A_in", digital(0));
    fix.coordinator.writeByLabel("CS_in", digital(0));
    fix.coordinator.writeByLabel("WE_in", digital(0));
    fix.coordinator.writeByLabel("OE_in", digital(1));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("eeprom_oe_low_suppresses_read_output_to_zero", () => {
    // Cat 9: with CS=1 and WE=0 but OE=0, the chip is selected but its
    // output buffer is disabled; executeEEPROM writes 0 to D.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "cs",   type: "In", props: { label: "CS_in", bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: "WE_in", bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: "OE_in", bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: "M", addrBits: 4, dataBits: 8, data: [0xFF] } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("A_in", digital(0));
    fix.coordinator.writeByLabel("CS_in", digital(1));
    fix.coordinator.writeByLabel("WE_in", digital(0));
    fix.coordinator.writeByLabel("OE_in", digital(0));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("eeprom_we_high_suppresses_read_output_to_zero", () => {
    // Cat 9: WE=1 puts the part in write-pending mode and the read path
    // returns 0 even with CS=1 and OE=1 asserted.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "cs",   type: "In", props: { label: "CS_in", bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: "WE_in", bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: "OE_in", bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: "M", addrBits: 4, dataBits: 8, data: [0xFF] } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("A_in", digital(0));
    fix.coordinator.writeByLabel("CS_in", digital(1));
    fix.coordinator.writeByLabel("WE_in", digital(1));
    fix.coordinator.writeByLabel("OE_in", digital(1));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("eeprom_we_falling_edge_writes_din_to_captured_address", () => {
    // Cat 9 (multi-step write protocol): rising WE captures the address
    // (A=5), falling WE while CS=1 commits Din (0xBE) to memory[5].
    // Reading back via OE=1 returns the just-written byte.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "cs",   type: "In", props: { label: "CS_in", bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: "WE_in", bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: "OE_in", bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: "M", addrBits: 4, dataBits: 8 } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    // Step 1: rising edge of WE at address 5 captures the write address.
    fix.coordinator.writeByLabel("A_in", digital(5));
    fix.coordinator.writeByLabel("CS_in", digital(1));
    fix.coordinator.writeByLabel("WE_in", digital(1));
    fix.coordinator.writeByLabel("OE_in", digital(0));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.step();

    // Step 2: falling edge of WE with Din=0xBE commits memory[5]=0xBE.
    // (Address bus changes are irrelevant; the EEPROM uses its captured addr.)
    fix.coordinator.writeByLabel("A_in", digital(9));
    fix.coordinator.writeByLabel("WE_in", digital(0));
    fix.coordinator.writeByLabel("Din_in", digital(0xBE));
    fix.coordinator.step();

    // Step 3: read back from address 5.
    fix.coordinator.writeByLabel("A_in", digital(5));
    fix.coordinator.writeByLabel("WE_in", digital(0));
    fix.coordinator.writeByLabel("OE_in", digital(1));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0xBE });

    fix.coordinator.dispose();
  });

  it("eeprom_we_falling_edge_with_cs_low_does_not_write", () => {
    // Cat 9: WE rising/falling without CS asserted leaves memory unchanged.
    // After the no-write cycle, asserting CS+OE and reading the same
    // address shows the original 0 (not the would-be Din 0x99).
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "cs",   type: "In", props: { label: "CS_in", bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: "WE_in", bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: "OE_in", bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: "M", addrBits: 4, dataBits: 8 } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    // Rising WE without CS.
    fix.coordinator.writeByLabel("A_in", digital(2));
    fix.coordinator.writeByLabel("CS_in", digital(0));
    fix.coordinator.writeByLabel("WE_in", digital(1));
    fix.coordinator.writeByLabel("OE_in", digital(0));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.step();

    // Falling WE without CS.
    fix.coordinator.writeByLabel("WE_in", digital(0));
    fix.coordinator.writeByLabel("Din_in", digital(0x99));
    fix.coordinator.step();

    // Now read address 2 with CS=1, OE=1.
    fix.coordinator.writeByLabel("A_in", digital(2));
    fix.coordinator.writeByLabel("CS_in", digital(1));
    fix.coordinator.writeByLabel("OE_in", digital(1));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("eeprom_sequential_writes_to_distinct_addresses_persist_independently", () => {
    // Cat 9 (multi-cycle): three rising/falling WE cycles write 0x11, 0x22,
    // 0x33 to addresses 1, 2, 3 respectively. A subsequent read confirms
    // each write landed at the right address.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "cs",   type: "In", props: { label: "CS_in", bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: "WE_in", bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: "OE_in", bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: "M", addrBits: 4, dataBits: 8 } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("CS_in", digital(1));
    fix.coordinator.writeByLabel("OE_in", digital(0));

    const writeWord = (addr: number, val: number) => {
      // Rising WE captures address.
      fix.coordinator.writeByLabel("A_in", digital(addr));
      fix.coordinator.writeByLabel("WE_in", digital(1));
      fix.coordinator.writeByLabel("Din_in", digital(0));
      fix.coordinator.step();
      // Falling WE commits Din.
      fix.coordinator.writeByLabel("WE_in", digital(0));
      fix.coordinator.writeByLabel("Din_in", digital(val));
      fix.coordinator.step();
    };

    writeWord(1, 0x11);
    writeWord(2, 0x22);
    writeWord(3, 0x33);

    const readWord = (addr: number) => {
      fix.coordinator.writeByLabel("A_in", digital(addr));
      fix.coordinator.writeByLabel("WE_in", digital(0));
      fix.coordinator.writeByLabel("OE_in", digital(1));
      fix.coordinator.writeByLabel("Din_in", digital(0));
      fix.coordinator.step();
      return fix.coordinator.readByLabel("D_out");
    };

    expect(readWord(1)).toMatchObject({ type: "digital", value: 0x11 });
    expect(readWord(2)).toMatchObject({ type: "digital", value: 0x22 });
    expect(readWord(3)).toMatchObject({ type: "digital", value: 0x33 });

    fix.coordinator.dispose();
  });

  it("eeprom_address_wraps_within_2_to_addrbits_window", () => {
    // Cat 9: an EEPROM with addrBits=2 has 4 words; driving A=4 wraps to
    // address 0. With memory[0]=0xAA seeded, the read returns 0xAA.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 2 } },
        { id: "cs",   type: "In", props: { label: "CS_in", bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: "WE_in", bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: "OE_in", bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: "M", addrBits: 2, dataBits: 8, data: [0xAA] } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("A_in", digital(4)); // wraps to 0
    fix.coordinator.writeByLabel("CS_in", digital(1));
    fix.coordinator.writeByLabel("WE_in", digital(0));
    fix.coordinator.writeByLabel("OE_in", digital(1));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0xAA });

    fix.coordinator.dispose();
  });
});

// ===========================================================================
// EEPROM  Cat 4 (parameter hot-load on `data` initial-memory contents)
// ===========================================================================

describe("EEPROM  parameter hot-load (T1)", () => {
  it("hotload_data_seeds_initial_memory_visible_at_address_zero", () => {
    // Cat 4: the `data` property seeds the EEPROM's backing store at compile
    // time. Building two distinct fixtures with different `data` arrays
    // (0x12 vs 0x5A at index 0) yields the two distinct documented read
    // values at address 0. The closed-form post-change observable is the
    // seeded byte itself (Δ = 0x5A - 0x12 = 0x48).
    const buildSeeded = (seedByte: number): EepromFixture => buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "cs",   type: "In", props: { label: "CS_in", bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: "WE_in", bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: "OE_in", bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: "M", addrBits: 4, dataBits: 8, data: [seedByte] } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    const driveRead = (fix: EepromFixture): SignalValue => {
      fix.coordinator.writeByLabel("A_in", digital(0));
      fix.coordinator.writeByLabel("CS_in", digital(1));
      fix.coordinator.writeByLabel("WE_in", digital(0));
      fix.coordinator.writeByLabel("OE_in", digital(1));
      fix.coordinator.writeByLabel("Din_in", digital(0));
      fix.coordinator.step();
      return fix.coordinator.readByLabel("D_out");
    };

    const fixA = buildSeeded(0x12);
    const fixB = buildSeeded(0x5A);
    const before = driveRead(fixA);
    const after  = driveRead(fixB);

    expect(before).toMatchObject({ type: "digital", value: 0x12 });
    expect(after).toMatchObject({ type: "digital", value: 0x5A });
    expect(after).not.toEqual(before);

    fixA.coordinator.dispose();
    fixB.coordinator.dispose();
  });

  it("hotload_isProgramMemory_flag_observable_via_circuit_element_property", () => {
    // Cat 4: the isProgramMemory flag is a build-time property surfaced on
    // the EEPROM's CircuitElement. Two distinct circuits (true / false)
    // expose the documented post-change observable on the element accessor
    // the digital/visual layer reads.
    const buildWithFlag = (flag: boolean): EepromFixture => buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: `A_${flag}`, bitWidth: 4 } },
        { id: "cs",   type: "In", props: { label: `CS_${flag}`, bitWidth: 1 } },
        { id: "we",   type: "In", props: { label: `WE_${flag}`, bitWidth: 1 } },
        { id: "oe",   type: "In", props: { label: `OE_${flag}`, bitWidth: 1 } },
        { id: "din",  type: "In", props: { label: `Din_${flag}`, bitWidth: 8 } },
        { id: "rom",  type: "EEPROM", props: { label: `M_${flag}`, addrBits: 4, dataBits: 8, isProgramMemory: flag } },
        { id: "out",  type: "Out", props: { label: `D_${flag}`, bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["cs:out",   "rom:CS"],
        ["we:out",   "rom:WE"],
        ["oe:out",   "rom:OE"],
        ["din:out",  "rom:Din"],
        ["rom:D",    "out:in"],
      ],
    });

    const fixT = buildWithFlag(true);
    fixT.coordinator.step();
    const elT = findElementByLabel(fixT, "M_true");
    expect(elT.getProperties().getOrDefault<boolean>("isProgramMemory", false)).toBe(true);
    fixT.coordinator.dispose();

    const fixF = buildWithFlag(false);
    fixF.coordinator.step();
    const elF = findElementByLabel(fixF, "M_false");
    expect(elF.getProperties().getOrDefault<boolean>("isProgramMemory", true)).toBe(false);
    fixF.coordinator.dispose();
  });
});

// ===========================================================================
// EEPROMDualPort  Cat 9 (Bridge / digital)
// ===========================================================================

describe("EEPROMDualPort  bridge / digital (T1)", () => {
  it("eepromdualport_clock_rising_edge_with_str_high_writes_din_to_address", () => {
    // Cat 9: with str=1 and a 0->1 clock transition, sampleEEPROMDualPort
    // commits Din to memory[A]. A subsequent ld=1 read returns the byte.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "str",  type: "In", props: { label: "str_in", bitWidth: 1 } },
        { id: "clk",  type: "In", props: { label: "C_in", bitWidth: 1 } },
        { id: "ld",   type: "In", props: { label: "ld_in", bitWidth: 1 } },
        { id: "rom",  type: "EEPROMDualPort", props: { label: "M", addrBits: 4, dataBits: 8 } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["din:out",  "rom:Din"],
        ["str:out",  "rom:str"],
        ["clk:out",  "rom:C"],
        ["ld:out",   "rom:ld"],
        ["rom:D",    "out:in"],
      ],
    });

    // Initial cycle with clk=0 establishes lastClk=0.
    fix.coordinator.writeByLabel("A_in", digital(3));
    fix.coordinator.writeByLabel("Din_in", digital(0xAB));
    fix.coordinator.writeByLabel("str_in", digital(1));
    fix.coordinator.writeByLabel("C_in", digital(0));
    fix.coordinator.writeByLabel("ld_in", digital(0));
    fix.coordinator.step();

    // Rising clock edge 0->1 commits the write.
    fix.coordinator.writeByLabel("C_in", digital(1));
    fix.coordinator.step();

    // Read back via ld=1.
    fix.coordinator.writeByLabel("str_in", digital(0));
    fix.coordinator.writeByLabel("C_in", digital(0));
    fix.coordinator.writeByLabel("ld_in", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0xAB });

    fix.coordinator.dispose();
  });

  it("eepromdualport_no_rising_edge_means_no_write", () => {
    // Cat 9: holding clock high after a prior rising edge does not retrigger
    // the write. The first rising-edge write of 0xAA persists; a subsequent
    // attempt to overwrite with 0xFF while clock stays high is a no-op.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "str",  type: "In", props: { label: "str_in", bitWidth: 1 } },
        { id: "clk",  type: "In", props: { label: "C_in", bitWidth: 1 } },
        { id: "ld",   type: "In", props: { label: "ld_in", bitWidth: 1 } },
        { id: "rom",  type: "EEPROMDualPort", props: { label: "M", addrBits: 4, dataBits: 8 } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["din:out",  "rom:Din"],
        ["str:out",  "rom:str"],
        ["clk:out",  "rom:C"],
        ["ld:out",   "rom:ld"],
        ["rom:D",    "out:in"],
      ],
    });

    // Establish lastClk=0 with clk low.
    fix.coordinator.writeByLabel("A_in", digital(0));
    fix.coordinator.writeByLabel("Din_in", digital(0xAA));
    fix.coordinator.writeByLabel("str_in", digital(1));
    fix.coordinator.writeByLabel("C_in", digital(0));
    fix.coordinator.writeByLabel("ld_in", digital(0));
    fix.coordinator.step();

    // Rising edge writes 0xAA.
    fix.coordinator.writeByLabel("C_in", digital(1));
    fix.coordinator.step();

    // Clock stays high (no edge); attempt to overwrite with 0xFF is a no-op.
    fix.coordinator.writeByLabel("Din_in", digital(0xFF));
    fix.coordinator.step();

    // Read back with ld=1; first written 0xAA persists.
    fix.coordinator.writeByLabel("str_in", digital(0));
    fix.coordinator.writeByLabel("C_in", digital(0));
    fix.coordinator.writeByLabel("ld_in", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0xAA });

    fix.coordinator.dispose();
  });

  it("eepromdualport_str_low_on_clock_edge_does_not_write", () => {
    // Cat 9: str=0 disables the write port; even on a rising clock edge,
    // memory[A] stays at the seeded zero. Read-back yields 0.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "str",  type: "In", props: { label: "str_in", bitWidth: 1 } },
        { id: "clk",  type: "In", props: { label: "C_in", bitWidth: 1 } },
        { id: "ld",   type: "In", props: { label: "ld_in", bitWidth: 1 } },
        { id: "rom",  type: "EEPROMDualPort", props: { label: "M", addrBits: 4, dataBits: 8 } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["din:out",  "rom:Din"],
        ["str:out",  "rom:str"],
        ["clk:out",  "rom:C"],
        ["ld:out",   "rom:ld"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("A_in", digital(0));
    fix.coordinator.writeByLabel("Din_in", digital(0x77));
    fix.coordinator.writeByLabel("str_in", digital(0));
    fix.coordinator.writeByLabel("C_in", digital(0));
    fix.coordinator.writeByLabel("ld_in", digital(0));
    fix.coordinator.step();

    fix.coordinator.writeByLabel("C_in", digital(1));
    fix.coordinator.step();

    // Read back: nothing was written.
    fix.coordinator.writeByLabel("C_in", digital(0));
    fix.coordinator.writeByLabel("ld_in", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("eepromdualport_ld_high_outputs_seeded_memory_value", () => {
    // Cat 9: ld=1 makes executeEEPROMDualPort copy memory[A] to D each step.
    // With memory seeded via `data` to have 0xCC at index 7, A=7 + ld=1
    // makes Out(D_out) read 0xCC.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "str",  type: "In", props: { label: "str_in", bitWidth: 1 } },
        { id: "clk",  type: "In", props: { label: "C_in", bitWidth: 1 } },
        { id: "ld",   type: "In", props: { label: "ld_in", bitWidth: 1 } },
        { id: "rom",  type: "EEPROMDualPort", props: { label: "M", addrBits: 4, dataBits: 8, data: [0, 0, 0, 0, 0, 0, 0, 0xCC] } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["din:out",  "rom:Din"],
        ["str:out",  "rom:str"],
        ["clk:out",  "rom:C"],
        ["ld:out",   "rom:ld"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("A_in", digital(7));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.writeByLabel("str_in", digital(0));
    fix.coordinator.writeByLabel("C_in", digital(0));
    fix.coordinator.writeByLabel("ld_in", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0xCC });

    fix.coordinator.dispose();
  });

  it("eepromdualport_ld_low_outputs_zero_regardless_of_memory", () => {
    // Cat 9: ld=0 disables the read port; D is driven to 0 even when
    // memory[A] is non-zero.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 4 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "str",  type: "In", props: { label: "str_in", bitWidth: 1 } },
        { id: "clk",  type: "In", props: { label: "C_in", bitWidth: 1 } },
        { id: "ld",   type: "In", props: { label: "ld_in", bitWidth: 1 } },
        { id: "rom",  type: "EEPROMDualPort", props: { label: "M", addrBits: 4, dataBits: 8, data: [0xDD] } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["din:out",  "rom:Din"],
        ["str:out",  "rom:str"],
        ["clk:out",  "rom:C"],
        ["ld:out",   "rom:ld"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("A_in", digital(0));
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.writeByLabel("str_in", digital(0));
    fix.coordinator.writeByLabel("C_in", digital(0));
    fix.coordinator.writeByLabel("ld_in", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("eepromdualport_address_wraps_within_2_to_addrbits_window", () => {
    // Cat 9: addrBits=2 yields a 4-word memory; A=6 wraps to address 2.
    // With memory[2]=0x55 seeded, ld=1 read returns 0x55.
    const fix = buildEepromFixture({
      components: [
        { id: "addr", type: "In", props: { label: "A_in", bitWidth: 2 } },
        { id: "din",  type: "In", props: { label: "Din_in", bitWidth: 8 } },
        { id: "str",  type: "In", props: { label: "str_in", bitWidth: 1 } },
        { id: "clk",  type: "In", props: { label: "C_in", bitWidth: 1 } },
        { id: "ld",   type: "In", props: { label: "ld_in", bitWidth: 1 } },
        { id: "rom",  type: "EEPROMDualPort", props: { label: "M", addrBits: 2, dataBits: 8, data: [0, 0, 0x55, 0] } },
        { id: "out",  type: "Out", props: { label: "D_out", bitWidth: 8 } },
      ],
      connections: [
        ["addr:out", "rom:A"],
        ["din:out",  "rom:Din"],
        ["str:out",  "rom:str"],
        ["clk:out",  "rom:C"],
        ["ld:out",   "rom:ld"],
        ["rom:D",    "out:in"],
      ],
    });

    fix.coordinator.writeByLabel("A_in", digital(6)); // wraps to 2
    fix.coordinator.writeByLabel("Din_in", digital(0));
    fix.coordinator.writeByLabel("str_in", digital(0));
    fix.coordinator.writeByLabel("C_in", digital(0));
    fix.coordinator.writeByLabel("ld_in", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("D_out")).toMatchObject({ type: "digital", value: 0x55 });

    fix.coordinator.dispose();
  });
});
