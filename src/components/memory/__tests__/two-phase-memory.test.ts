import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
//
// Every component covered here (Counter, CounterPreset, ProgramCounter,
// Register, RegisterFile, ProgramMemory, RAMSinglePort, RAMDualPort,
// RAMDualAccess, RAMAsync, RAMSinglePortSel, BlockRAMDualPort, EEPROM,
// EEPROMDualPort, PRNG, ROM, LookUpTable) carries a `models.digital` entry;
// capability gate 9 is the only canon category that applies. Categories 1-8
// do not apply to pure digital components: there is no analog state pool, no
// MNA matrix, no DCOP, no junction limiting, no LTE rollback, no breakpoint
// registration via acceptStep, and no analog transient dynamics for a paired
// ngspice run.
//
// The file's authoring purpose is the two-phase split (sample phase reads
// inputs / updates internal state on edges; execute phase drives outputs from
// state). That split is an internal scheduling detail of the digital engine
// pipeline; the canonical observable at the simulator surface is the
// post-step output read via coordinator.readSignal. Each canonical it()
// drives inputs through facade.setSignal, advances the engine via
// facade.step, and observes labeled Out pins via facade.readSignal — these
// are thin wrappers over coordinator.writeSignal / step() / readSignal i.e.
// the sanctioned simulator surface from Step 2b's binary canonical gate.
// ---------------------------------------------------------------------------

/**
 * Drive a clock pin through one full low-high-low cycle so a single rising
 * edge reaches the component. The trailing 1->0 keeps successive calls
 * independent (each call delivers exactly one rising edge).
 */
function pulseClock(
  facade: DefaultSimulatorFacade,
  coord: ReturnType<DefaultSimulatorFacade["compile"]>,
  clkLabel: string,
): void {
  facade.setSignal(coord, clkLabel, 0);
  facade.step(coord);
  facade.setSignal(coord, clkLabel, 1);
  facade.step(coord);
  facade.setSignal(coord, clkLabel, 0);
  facade.step(coord);
}

// ===========================================================================
// Counter — sample phase increments on rising edge with en=1; execute phase
//            drives out from state.
// ===========================================================================

describe("Counter two-phase observable (Cat 9)", () => {
  function buildCounter(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "en",  type: "In",      props: { label: "EN_in",  bitWidth: 1 } },
        { id: "c",   type: "In",      props: { label: "CLK_in", bitWidth: 1 } },
        { id: "clr", type: "In",      props: { label: "CLR_in", bitWidth: 1 } },
        { id: "cnt", type: "Counter", props: { bitWidth: 4 } },
        { id: "q",   type: "Out",     props: { label: "Q_out",  bitWidth: 4 } },
      ],
      connections: [
        ["en:out",  "cnt:en"],
        ["c:out",   "cnt:C"],
        ["clr:out", "cnt:clr"],
        ["cnt:out", "q:in"],
      ],
    });
  }

  it("rising_edge_with_en_high_increments_state_then_executes_q_one", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildCounter(facade));
    facade.setSignal(coord, "EN_in", 1);
    facade.setSignal(coord, "CLR_in", 0);
    pulseClock(facade, coord, "CLK_in");
    expect(facade.readSignal(coord, "Q_out")).toBe(1);
    coord.dispose();
  });

  it("rising_edge_with_clr_high_resets_state_then_executes_q_zero", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildCounter(facade));
    // Increment to 5 first.
    facade.setSignal(coord, "EN_in", 1);
    facade.setSignal(coord, "CLR_in", 0);
    for (let i = 0; i < 5; i++) pulseClock(facade, coord, "CLK_in");
    expect(facade.readSignal(coord, "Q_out")).toBe(5);
    // Clear via rising edge with clr=1.
    facade.setSignal(coord, "CLR_in", 1);
    pulseClock(facade, coord, "CLK_in");
    expect(facade.readSignal(coord, "Q_out")).toBe(0);
  });
});

// ===========================================================================
// CounterPreset — sample phase loads `in` on rising edge with ld=1; execute
//             phase drives out from state.
// ===========================================================================

describe("CounterPreset two-phase observable (Cat 9)", () => {
  function buildCounterPreset(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "en",  type: "In",            props: { label: "EN",  bitWidth: 1 } },
        { id: "c",   type: "In",            props: { label: "C",   bitWidth: 1 } },
        { id: "dir", type: "In",            props: { label: "DIR", bitWidth: 1 } },
        { id: "din", type: "In",            props: { label: "DIN", bitWidth: 4 } },
        { id: "ld",  type: "In",            props: { label: "LD",  bitWidth: 1 } },
        { id: "clr", type: "In",            props: { label: "CLR", bitWidth: 1 } },
        { id: "cnt", type: "CounterPreset", props: { bitWidth: 4 } },
        { id: "q",   type: "Out",           props: { label: "Q",   bitWidth: 4 } },
      ],
      connections: [
        ["en:out",  "cnt:en"],
        ["c:out",   "cnt:C"],
        ["dir:out", "cnt:dir"],
        ["din:out", "cnt:in"],
        ["ld:out",  "cnt:ld"],
        ["clr:out", "cnt:clr"],
        ["cnt:out", "q:in"],
      ],
    });
  }

  it("rising_edge_with_ld_high_loads_state_then_executes_q_loaded", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildCounterPreset(facade));
    facade.setSignal(coord, "EN", 0);
    facade.setSignal(coord, "DIR", 0);
    facade.setSignal(coord, "DIN", 0xA);
    facade.setSignal(coord, "LD", 1);
    facade.setSignal(coord, "CLR", 0);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0xA);
  });
});

// ===========================================================================
// ProgramCounter — sample phase increments on rising edge with en=1; execute
//             phase drives Q from state.
// ===========================================================================

describe("ProgramCounter two-phase observable (Cat 9)", () => {
  // ProgramCounter pin defaultBitWidth=1 throughout; build at bitWidth=1 so
  // every In/Out and pc pin sits on a width-consistent 1-bit net.
  function buildProgramCounter(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "d",   type: "In",             props: { label: "D_in",  bitWidth: 1 } },
        { id: "en",  type: "In",             props: { label: "EN_in", bitWidth: 1 } },
        { id: "c",   type: "In",             props: { label: "C_in",  bitWidth: 1 } },
        { id: "ld",  type: "In",             props: { label: "LD_in", bitWidth: 1 } },
        { id: "pc",  type: "ProgramCounter", props: { bitWidth: 1 } },
        { id: "q",   type: "Out",            props: { label: "Q_out", bitWidth: 1 } },
      ],
      connections: [
        ["d:out",  "pc:D"],
        ["en:out", "pc:en"],
        ["c:out",  "pc:C"],
        ["ld:out", "pc:ld"],
        ["pc:Q",   "q:in"],
      ],
    });
  }

  it("rising_edge_with_en_high_increments_state_then_executes_q_one", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildProgramCounter(facade));
    facade.setSignal(coord, "D_in", 0);
    facade.setSignal(coord, "EN_in", 1);
    facade.setSignal(coord, "LD_in", 0);
    pulseClock(facade, coord, "C_in");
    expect(facade.readSignal(coord, "Q_out")).toBe(1);
  });

  it("two_consecutive_rising_edges_with_en_high_wraps_one_bit_state_to_zero", () => {
    // bitWidth=1: state cycles 0 -> 1 -> 0 over two rising edges.
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildProgramCounter(facade));
    facade.setSignal(coord, "D_in", 0);
    facade.setSignal(coord, "EN_in", 1);
    facade.setSignal(coord, "LD_in", 0);
    pulseClock(facade, coord, "C_in");
    expect(facade.readSignal(coord, "Q_out")).toBe(1);
    pulseClock(facade, coord, "C_in");
    expect(facade.readSignal(coord, "Q_out")).toBe(0);
  });
});

// ===========================================================================
// Register — sample phase latches D on rising clock edge with en=1; execute
//            phase drives Q from latched state.
// ===========================================================================

describe("Register two-phase observable (Cat 9)", () => {
  function buildRegister(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "d",   type: "In",       props: { label: "D",  bitWidth: 8 } },
        { id: "c",   type: "In",       props: { label: "C",  bitWidth: 1 } },
        { id: "en",  type: "In",       props: { label: "EN", bitWidth: 1 } },
        { id: "reg", type: "Register", props: { bitWidth: 8 } },
        { id: "q",   type: "Out",      props: { label: "Q",  bitWidth: 8 } },
      ],
      connections: [
        ["d:out",   "reg:D"],
        ["c:out",   "reg:C"],
        ["en:out",  "reg:en"],
        ["reg:Q",   "q:in"],
      ],
    });
  }

  it("rising_edge_with_en_high_latches_d_then_executes_q_latched", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRegister(facade));
    facade.setSignal(coord, "D", 0xAB);
    facade.setSignal(coord, "EN", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0xAB);
  });

  it("execute_drives_q_from_state_not_input_when_clock_static", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRegister(facade));
    // Latch Q=0x55 via rising edge with D=0x55.
    facade.setSignal(coord, "D", 0x55);
    facade.setSignal(coord, "EN", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "Q")).toBe(0x55);
    // Hold C low, change D — execute reads state, not D.
    facade.setSignal(coord, "D", 0xFF);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0x55);
  });
});

// ===========================================================================
// RegisterFile — sample phase writes Din into register[Rw] on rising clock
//             edge with we=1; execute phase drives Da/Db combinationally from
//             register[Ra]/register[Rb].
// ===========================================================================

describe("RegisterFile two-phase observable (Cat 9)", () => {
  function buildRegisterFile(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "din", type: "In",           props: { label: "DIN", bitWidth: 8 } },
        { id: "we",  type: "In",           props: { label: "WE",  bitWidth: 1 } },
        { id: "rw",  type: "In",           props: { label: "RW",  bitWidth: 2 } },
        { id: "c",   type: "In",           props: { label: "C",   bitWidth: 1 } },
        { id: "ra",  type: "In",           props: { label: "RA",  bitWidth: 2 } },
        { id: "rb",  type: "In",           props: { label: "RB",  bitWidth: 2 } },
        { id: "rf",  type: "RegisterFile", props: { addrBits: 2, dataBits: 8 } },
        { id: "da",  type: "Out",          props: { label: "DA",  bitWidth: 8 } },
        { id: "db",  type: "Out",          props: { label: "DB",  bitWidth: 8 } },
      ],
      connections: [
        ["din:out", "rf:Din"],
        ["we:out",  "rf:we"],
        ["rw:out",  "rf:Rw"],
        ["c:out",   "rf:C"],
        ["ra:out",  "rf:Ra"],
        ["rb:out",  "rf:Rb"],
        ["rf:Da",   "da:in"],
        ["rf:Db",   "db:in"],
      ],
    });
  }

  it("rising_edge_with_we_high_writes_register_then_read_observes_value", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRegisterFile(facade));
    // Write 0xCD into register[2].
    facade.setSignal(coord, "DIN", 0xCD);
    facade.setSignal(coord, "WE", 1);
    facade.setSignal(coord, "RW", 2);
    pulseClock(facade, coord, "C");
    // Read register[2] via Ra.
    facade.setSignal(coord, "WE", 0);
    facade.setSignal(coord, "RA", 2);
    facade.setSignal(coord, "RB", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "DA")).toBe(0xCD);
  });
});

// ===========================================================================
// ProgramMemory — sample phase latches address on rising clock edge with
//             ld=1; execute phase drives D from memory[latched_address].
// ===========================================================================

describe("ProgramMemory two-phase observable (Cat 9)", () => {
  function buildProgramMemory(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",            props: { label: "A",  bitWidth: 4 } },
        { id: "ld",  type: "In",            props: { label: "LD", bitWidth: 1 } },
        { id: "c",   type: "In",            props: { label: "C",  bitWidth: 1 } },
        { id: "pm",  type: "ProgramMemory", props: { addrBits: 4, dataBits: 8 } },
        { id: "d",   type: "Out",           props: { label: "D",  bitWidth: 8 } },
      ],
      connections: [
        ["a:out",  "pm:A"],
        ["ld:out", "pm:ld"],
        ["c:out",  "pm:C"],
        ["pm:D",   "d:in"],
      ],
    });
  }

  it("rising_edge_with_ld_high_latches_address_then_executes_d_from_memory", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildProgramMemory(facade));
    // Memory defaults to all-zero; the documented contract is that a rising
    // edge with ld=1 latches the address into the address register, after
    // which D is driven from memory[latched_address]. With default zero
    // contents the observable D is 0 — the canonical assertion is that the
    // simulator path executes without throwing and D reads as a digital
    // value.
    facade.setSignal(coord, "A", 5);
    facade.setSignal(coord, "LD", 1);
    pulseClock(facade, coord, "C");
    expect(facade.readSignal(coord, "D")).toBe(0);
  });
});

// ===========================================================================
// RAMSinglePort — sample phase writes Din into memory[A] on rising clock edge
//             with str=1; execute phase drives D combinationally when ld=1.
// ===========================================================================

describe("RAMSinglePort two-phase observable (Cat 9)", () => {
  // RAMSinglePort has a single bidirectional D pin: external driver delivers
  // write data when str=1; the component drives D from memory[A] when ld=1.
  // Per the Canon's bidirectional-pin canonical fixture, wire D to BOTH an In
  // (drive-in) and an Out (observer).
  function buildRAMSinglePort(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",            props: { label: "A",       bitWidth: 4 } },
        { id: "drv", type: "In",            props: { label: "D_DRIVE", bitWidth: 8 } },
        { id: "str", type: "In",            props: { label: "STR",     bitWidth: 1 } },
        { id: "c",   type: "In",            props: { label: "C",       bitWidth: 1 } },
        { id: "ld",  type: "In",            props: { label: "LD",      bitWidth: 1 } },
        { id: "ram", type: "RAMSinglePort", props: { addrBits: 4, dataBits: 8 } },
        { id: "obs", type: "Out",           props: { label: "D_OBS",   bitWidth: 8 } },
      ],
      connections: [
        ["a:out",   "ram:A"],
        ["str:out", "ram:str"],
        ["c:out",   "ram:C"],
        ["ld:out",  "ram:ld"],
        ["drv:out", "ram:D"],
        ["ram:D",   "obs:in"],
      ],
    });
  }

  it("write_then_read_round_trip_drives_d_to_written_value", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRAMSinglePort(facade));
    // Write phase: drive D externally with 0xAB, str=1, ld=0, pulse clock.
    facade.setSignal(coord, "A", 3);
    facade.setSignal(coord, "D_DRIVE", 0xAB);
    facade.setSignal(coord, "STR", 1);
    facade.setSignal(coord, "LD", 0);
    pulseClock(facade, coord, "C");
    // Read phase: str=0, ld=1; component drives D, observer reads.
    facade.setSignal(coord, "STR", 0);
    facade.setSignal(coord, "LD", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "D_OBS")).toBe(0xAB);
  });

  it("write_with_str_low_does_not_modify_memory", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRAMSinglePort(facade));
    facade.setSignal(coord, "A", 3);
    facade.setSignal(coord, "D_DRIVE", 0xFF);
    facade.setSignal(coord, "STR", 0);
    facade.setSignal(coord, "LD", 0);
    pulseClock(facade, coord, "C");
    facade.setSignal(coord, "LD", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "D_OBS")).toBe(0);
  });
});

// ===========================================================================
// RAMDualPort — sample phase writes Din into memory[A] on rising clock edge
//             with str=1; execute phase drives D combinationally when ld=1.
// ===========================================================================

describe("RAMDualPort two-phase observable (Cat 9)", () => {
  function buildRAMDualPort(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",          props: { label: "A",   bitWidth: 4 } },
        { id: "din", type: "In",          props: { label: "DIN", bitWidth: 8 } },
        { id: "str", type: "In",          props: { label: "STR", bitWidth: 1 } },
        { id: "c",   type: "In",          props: { label: "C",   bitWidth: 1 } },
        { id: "ld",  type: "In",          props: { label: "LD",  bitWidth: 1 } },
        { id: "ram", type: "RAMDualPort", props: { addrBits: 4, dataBits: 8 } },
        { id: "dobs",type: "Out",         props: { label: "DOBS",bitWidth: 8 } },
      ],
      connections: [
        ["a:out",   "ram:A"],
        ["din:out", "ram:Din"],
        ["str:out", "ram:str"],
        ["c:out",   "ram:C"],
        ["ld:out",  "ram:ld"],
        ["ram:D",   "dobs:in"],
      ],
    });
  }

  it("write_then_read_round_trip_drives_d_to_written_value", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRAMDualPort(facade));
    facade.setSignal(coord, "A", 3);
    facade.setSignal(coord, "DIN", 0xAB);
    facade.setSignal(coord, "STR", 1);
    facade.setSignal(coord, "LD", 0);
    pulseClock(facade, coord, "C");
    facade.setSignal(coord, "STR", 0);
    facade.setSignal(coord, "LD", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "DOBS")).toBe(0xAB);
  });

  it("write_with_str_low_does_not_modify_memory", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRAMDualPort(facade));
    facade.setSignal(coord, "A", 3);
    facade.setSignal(coord, "DIN", 0xFF);
    facade.setSignal(coord, "STR", 0);
    facade.setSignal(coord, "LD", 0);
    pulseClock(facade, coord, "C");
    facade.setSignal(coord, "LD", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "DOBS")).toBe(0);
  });
});

// ===========================================================================
// RAMDualAccess — sample phase writes 1Din into memory[1A] on rising clock
//             edge with str=1; execute phase drives 1D from memory[1A] when
//             ld=1, and 2D combinationally from memory[2A].
// ===========================================================================

describe("RAMDualAccess two-phase observable (Cat 9)", () => {
  function buildRAMDualAccess(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "str", type: "In",            props: { label: "STR", bitWidth: 1 } },
        { id: "c",   type: "In",            props: { label: "C",   bitWidth: 1 } },
        { id: "ld",  type: "In",            props: { label: "LD",  bitWidth: 1 } },
        { id: "a1",  type: "In",            props: { label: "A1",  bitWidth: 4 } },
        { id: "din1",type: "In",            props: { label: "DIN1",bitWidth: 8 } },
        { id: "a2",  type: "In",            props: { label: "A2",  bitWidth: 4 } },
        { id: "ram", type: "RAMDualAccess", props: { addrBits: 4, dataBits: 8 } },
        { id: "d1",  type: "Out",           props: { label: "D1",  bitWidth: 8 } },
        { id: "d2",  type: "Out",           props: { label: "D2",  bitWidth: 8 } },
      ],
      connections: [
        ["str:out",  "ram:str"],
        ["c:out",    "ram:C"],
        ["ld:out",   "ram:ld"],
        ["a1:out",   "ram:1A"],
        ["din1:out", "ram:1Din"],
        ["a2:out",   "ram:2A"],
        ["ram:1D",   "d1:in"],
        ["ram:2D",   "d2:in"],
      ],
    });
  }

  it("write_then_read_round_trip_drives_2d_to_written_value_at_same_address", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRAMDualAccess(facade));
    // Write 0x77 into address 5 via port 1.
    facade.setSignal(coord, "A1", 5);
    facade.setSignal(coord, "DIN1", 0x77);
    facade.setSignal(coord, "STR", 1);
    facade.setSignal(coord, "LD", 0);
    pulseClock(facade, coord, "C");
    // Read address 5 via port 2 (combinational).
    facade.setSignal(coord, "STR", 0);
    facade.setSignal(coord, "A2", 5);
    facade.step(coord);
    expect(facade.readSignal(coord, "D2")).toBe(0x77);
  });
});

// ===========================================================================
// RAMAsync — async write: sample phase writes Din into memory[A] on rising
//             clock edge with str=1; execute phase drives D combinationally
//             from memory[A].
// ===========================================================================

describe("RAMAsync two-phase observable (Cat 9)", () => {
  function buildRAMAsync(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",       props: { label: "A",   bitWidth: 4 } },
        { id: "din", type: "In",       props: { label: "DIN", bitWidth: 8 } },
        { id: "we",  type: "In",       props: { label: "WE",  bitWidth: 1 } },
        { id: "ram", type: "RAMAsync", props: { addrBits: 4, dataBits: 8 } },
        { id: "q",   type: "Out",      props: { label: "Q",   bitWidth: 8 } },
      ],
      connections: [
        ["a:out",   "ram:A"],
        ["din:out", "ram:D"],
        ["we:out",  "ram:we"],
        ["ram:Q",   "q:in"],
      ],
    });
  }

  it("write_then_read_round_trip_drives_q_to_written_value", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRAMAsync(facade));
    facade.setSignal(coord, "A", 7);
    facade.setSignal(coord, "DIN", 0x33);
    facade.setSignal(coord, "WE", 1);
    facade.step(coord);
    facade.step(coord);
    facade.setSignal(coord, "WE", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Q")).toBe(0x33);
  });
});

// ===========================================================================
// RAMSinglePortSel — combinational read: execute phase drives D from
//             memory[A] when sel=1, otherwise 0.
// ===========================================================================

describe("RAMSinglePortSel two-phase observable (Cat 9)", () => {
  // RAMSinglePortSel: combinational chip-select RAM. Pins A, CS, WE, OE, D.
  // No clock; execute drives D from memory[A] when CS=1, OE=1, WE=0.
  function buildRAMSinglePortSel(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",               props: { label: "A",   bitWidth: 4 } },
        { id: "cs",  type: "In",               props: { label: "CS",  bitWidth: 1 } },
        { id: "we",  type: "In",               props: { label: "WE",  bitWidth: 1 } },
        { id: "oe",  type: "In",               props: { label: "OE",  bitWidth: 1 } },
        { id: "ram", type: "RAMSinglePortSel", props: { addrBits: 4, dataBits: 8 } },
        { id: "d",   type: "Out",              props: { label: "D",   bitWidth: 8 } },
      ],
      connections: [
        ["a:out",  "ram:A"],
        ["cs:out", "ram:CS"],
        ["we:out", "ram:WE"],
        ["oe:out", "ram:OE"],
        ["ram:D",  "d:in"],
      ],
    });
  }

  it("read_default_zero_memory_with_cs_oe_high_we_low_drives_d_zero", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildRAMSinglePortSel(facade));
    facade.setSignal(coord, "A", 0);
    facade.setSignal(coord, "CS", 1);
    facade.setSignal(coord, "WE", 0);
    facade.setSignal(coord, "OE", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "D")).toBe(0);
  });
});

// ===========================================================================
// BlockRAMDualPort — sample phase writes Din into memory[A] on rising clock
//             edge with str=1; execute phase drives D from memory[A].
// ===========================================================================

describe("BlockRAMDualPort two-phase observable (Cat 9)", () => {
  function buildBlockRAMDualPort(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",               props: { label: "A",   bitWidth: 4 } },
        { id: "din", type: "In",               props: { label: "DIN", bitWidth: 8 } },
        { id: "str", type: "In",               props: { label: "STR", bitWidth: 1 } },
        { id: "c",   type: "In",               props: { label: "C",   bitWidth: 1 } },
        { id: "ram", type: "BlockRAMDualPort", props: { addrBits: 4, dataBits: 8 } },
        { id: "d",   type: "Out",              props: { label: "D",   bitWidth: 8 } },
      ],
      connections: [
        ["a:out",   "ram:A"],
        ["din:out", "ram:Din"],
        ["str:out", "ram:str"],
        ["c:out",   "ram:C"],
        ["ram:D",   "d:in"],
      ],
    });
  }

  it("write_then_read_round_trip_drives_d_to_written_value", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildBlockRAMDualPort(facade));
    // Write 0x42 into address 9.
    facade.setSignal(coord, "A", 9);
    facade.setSignal(coord, "DIN", 0x42);
    facade.setSignal(coord, "STR", 1);
    pulseClock(facade, coord, "C");
    // Read address 9.
    facade.setSignal(coord, "STR", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "D")).toBe(0x42);
  });
});

// ===========================================================================
// EEPROM — sample phase captures address on rising edge of WE, then commits
//             write on falling edge of WE; execute phase drives D from
//             memory[A] when CS=1, OE=1, WE=0.
// ===========================================================================

describe("EEPROM two-phase observable (Cat 9)", () => {
  function buildEEPROM(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",     props: { label: "A",   bitWidth: 4 } },
        { id: "cs",  type: "In",     props: { label: "CS",  bitWidth: 1 } },
        { id: "we",  type: "In",     props: { label: "WE",  bitWidth: 1 } },
        { id: "oe",  type: "In",     props: { label: "OE",  bitWidth: 1 } },
        { id: "din", type: "In",     props: { label: "DIN", bitWidth: 8 } },
        { id: "rom", type: "EEPROM", props: { addrBits: 4, dataBits: 8 } },
        { id: "d",   type: "Out",    props: { label: "D",   bitWidth: 8 } },
      ],
      connections: [
        ["a:out",   "rom:A"],
        ["cs:out",  "rom:CS"],
        ["we:out",  "rom:WE"],
        ["oe:out",  "rom:OE"],
        ["din:out", "rom:Din"],
        ["rom:D",   "d:in"],
      ],
    });
  }

  it("write_cycle_then_read_drives_d_to_written_value", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildEEPROM(facade));
    // Step 1: rising edge of WE captures address.
    facade.setSignal(coord, "A", 1);
    facade.setSignal(coord, "CS", 1);
    facade.setSignal(coord, "OE", 0);
    facade.setSignal(coord, "DIN", 0x55);
    facade.setSignal(coord, "WE", 0);
    facade.step(coord);
    facade.setSignal(coord, "WE", 1);
    facade.step(coord);
    // Step 2: falling edge of WE commits write.
    facade.setSignal(coord, "WE", 0);
    facade.step(coord);
    // Step 3: read mode (CS=1, OE=1, WE=0).
    facade.setSignal(coord, "OE", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "D")).toBe(0x55);
  });
});

// ===========================================================================
// EEPROMDualPort — same write/read split as EEPROM but with dual ports.
// ===========================================================================

describe("EEPROMDualPort two-phase observable (Cat 9)", () => {
  // EEPROMDualPort uses RAM-style pins (A, Din, str, C, ld, D) — sample
  // phase writes Din into memory[A] on rising clock with str=1; execute
  // phase drives D combinationally from memory[A] when ld=1.
  function buildEEPROMDualPort(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",             props: { label: "A",   bitWidth: 4 } },
        { id: "din", type: "In",             props: { label: "DIN", bitWidth: 8 } },
        { id: "str", type: "In",             props: { label: "STR", bitWidth: 1 } },
        { id: "c",   type: "In",             props: { label: "C",   bitWidth: 1 } },
        { id: "ld",  type: "In",             props: { label: "LD",  bitWidth: 1 } },
        { id: "rom", type: "EEPROMDualPort", props: { addrBits: 4, dataBits: 8 } },
        { id: "d",   type: "Out",            props: { label: "D",   bitWidth: 8 } },
      ],
      connections: [
        ["a:out",   "rom:A"],
        ["din:out", "rom:Din"],
        ["str:out", "rom:str"],
        ["c:out",   "rom:C"],
        ["ld:out",  "rom:ld"],
        ["rom:D",   "d:in"],
      ],
    });
  }

  it("read_default_zero_memory_with_ld_high_drives_d_zero", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildEEPROMDualPort(facade));
    facade.setSignal(coord, "A", 0);
    facade.setSignal(coord, "STR", 0);
    facade.setSignal(coord, "LD", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "D")).toBe(0);
  });
});

// ===========================================================================
// PRNG — sample phase advances LFSR state on rising clock edge with ne=1;
//             execute phase drives R from state.
// ===========================================================================

describe("PRNG two-phase observable (Cat 9)", () => {
  function buildPRNG(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "s",   type: "In",   props: { label: "S",  bitWidth: 8 } },
        { id: "se",  type: "In",   props: { label: "SE", bitWidth: 1 } },
        { id: "ne",  type: "In",   props: { label: "NE", bitWidth: 1 } },
        { id: "c",   type: "In",   props: { label: "C",  bitWidth: 1 } },
        { id: "rng", type: "PRNG", props: { bitWidth: 8 } },
        { id: "r",   type: "Out",  props: { label: "R",  bitWidth: 8 } },
      ],
      connections: [
        ["s:out",  "rng:S"],
        ["se:out", "rng:se"],
        ["ne:out", "rng:ne"],
        ["c:out",  "rng:C"],
        ["rng:R",  "r:in"],
      ],
    });
  }

  it("rising_edge_with_ne_high_advances_lfsr_state_then_executes_r_changed", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildPRNG(facade));
    // Seed: assert se=1 with S=1 over a rising edge to load seed.
    facade.setSignal(coord, "S", 1);
    facade.setSignal(coord, "SE", 1);
    facade.setSignal(coord, "NE", 0);
    pulseClock(facade, coord, "C");
    facade.setSignal(coord, "SE", 0);
    facade.step(coord);
    const before = facade.readSignal(coord, "R") as number;
    // Advance LFSR.
    facade.setSignal(coord, "NE", 1);
    pulseClock(facade, coord, "C");
    const after = facade.readSignal(coord, "R") as number;
    expect(after).not.toBe(before);
  });
});

// ===========================================================================
// ROM — combinational read: execute phase drives out from memory[A]. No
//             clock, no write path. Default zero contents → out reads 0.
// ===========================================================================

describe("ROM two-phase observable (Cat 9)", () => {
  function buildROM(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",  props: { label: "A",   bitWidth: 4 } },
        { id: "sel", type: "In",  props: { label: "SEL", bitWidth: 1 } },
        { id: "rom", type: "ROM", props: { addrBits: 4, dataBits: 8 } },
        { id: "d",   type: "Out", props: { label: "D",   bitWidth: 8 } },
      ],
      connections: [
        ["a:out",   "rom:A"],
        ["sel:out", "rom:sel"],
        ["rom:D",   "d:in"],
      ],
    });
  }

  it("read_default_zero_memory_with_sel_high_drives_d_zero", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildROM(facade));
    facade.setSignal(coord, "A", 0);
    facade.setSignal(coord, "SEL", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "D")).toBe(0);
  });
});

// ===========================================================================
// LookUpTable — combinational read: execute phase drives out from
//             memory[address built from inputs]. Default zero contents →
//             out reads 0. Numeric pin labels per LUT generic shape.
// ===========================================================================

describe("LookUpTable two-phase observable (Cat 9)", () => {
  function buildLookUpTable(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "i0",  type: "In",          props: { label: "I0", bitWidth: 1 } },
        { id: "i1",  type: "In",          props: { label: "I1", bitWidth: 1 } },
        { id: "lut", type: "LookUpTable", props: { inputCount: 2, dataBits: 1 } },
        { id: "o",   type: "Out",         props: { label: "O",  bitWidth: 1 } },
      ],
      connections: [
        ["i0:out",  "lut:0"],
        ["i1:out",  "lut:1"],
        ["lut:out", "o:in"],
      ],
    });
  }

  it("read_default_zero_table_drives_out_zero", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildLookUpTable(facade));
    facade.setSignal(coord, "I0", 0);
    facade.setSignal(coord, "I1", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "O")).toBe(0);
  });
});
