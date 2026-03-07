/**
 * Two-phase (sampleFn + executeFn) tests for memory components and PRNG.
 *
 * Covers Task 2.3b (counters/registers) and Task 2.3c (RAM/EEPROM/PRNG/ROM/LUT).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  sampleCounter,
  executeCounter,
  CounterDefinition,
} from "../counter.js";
import {
  sampleCounterPreset,
  executeCounterPreset as _executeCounterPreset,
  CounterPresetDefinition,
} from "../counter-preset.js";
import {
  sampleProgramCounter,
  executeProgramCounter as _executeProgramCounter,
  ProgramCounterDefinition,
} from "../program-counter.js";
import type { ProgramCounterLayout } from "../program-counter.js";
import {
  sampleRegister,
  executeRegister,
  RegisterDefinition,
} from "../register.js";
import {
  sampleRegisterFile,
  executeRegisterFile as _executeRegisterFile,
  RegisterFileDefinition,
} from "../register-file.js";
import {
  sampleProgramMemory,
  executeProgramMemory as _executeProgramMemory,
  ProgramMemoryDefinition,
} from "../program-memory.js";
import type { ProgramMemoryLayout } from "../program-memory.js";
import {
  DataField,
  registerBackingStore,
  clearBackingStores,
  sampleRAMSinglePort,
  executeRAMSinglePort as _executeRAMSinglePort,
  RAMSinglePortDefinition,
  sampleRAMDualPort,
  executeRAMDualPort,
  RAMDualPortDefinition,
  sampleRAMDualAccess,
  executeRAMDualAccess as _executeRAMDualAccess,
  RAMDualAccessDefinition,
  RAMAsyncDefinition,
  RAMSinglePortSelDefinition,
  sampleBlockRAMDualPort,
  executeBlockRAMDualPort as _executeBlockRAMDualPort,
  BlockRAMDualPortDefinition,
} from "../ram.js";
import type { RAMLayout } from "../ram.js";
import {
  sampleEEPROM,
  executeEEPROM,
  EEPROMDefinition,
  sampleEEPROMDualPort,
  executeEEPROMDualPort as _executeEEPROMDualPort,
  EEPROMDualPortDefinition,
} from "../eeprom.js";
import type { EEPROMLayout } from "../eeprom.js";
import {
  samplePRNG,
  executePRNG,
  PRNGDefinition,
} from "../../arithmetic/prng.js";
import type { PRNGLayout } from "../../arithmetic/prng.js";
import { ROMDefinition } from "../rom.js";
import { LookUpTableDefinition } from "../lookup-table.js";
import type { ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function makeRAMLayout(inputCount: number, outputCount: number): RAMLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
  };
}

function makeEEPROMLayout(inputCount: number, outputCount: number): EEPROMLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
  };
}

function makePRNGLayout(inputCount: number, outputCount: number): PRNGLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
  };
}

// ---------------------------------------------------------------------------
// Layout helpers for counters/registers (Task 2.3b)
// ---------------------------------------------------------------------------

function makeCounterLayout(): {
  layout: ComponentLayout & { stateOffset(i: number): number; getProperty?(i: number, key: string): number };
  state: Uint32Array;
  highZs: Uint32Array;
} {
  // Counter: inputs [en=0, C=1, clr=2], outputs [out=3, ovf=4], state [counter=5, prevClock=6]
  const state = new Uint32Array(64);
  const highZs = new Uint32Array(64);
  const layout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 3,
    inputOffset: () => 0,
    outputCount: () => 2,
    outputOffset: () => 3,
    stateOffset: () => 5,
    getProperty: (_i: number, key: string) => {
      if (key === "bitWidth") return 4;
      return 0;
    },
  };
  return { layout, state, highZs };
}

function makeCounterPresetLayout(): {
  layout: ComponentLayout & { stateOffset(i: number): number; getProperty?(i: number, key: string): number };
  state: Uint32Array;
  highZs: Uint32Array;
} {
  // CounterPreset: inputs [en=0, C=1, dir=2, in=3, ld=4, clr=5], outputs [out=6, ovf=7], state [counter=8, prevClock=9]
  const state = new Uint32Array(64);
  const highZs = new Uint32Array(64);
  const layout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 6,
    inputOffset: () => 0,
    outputCount: () => 2,
    outputOffset: () => 6,
    stateOffset: () => 8,
    getProperty: (_i: number, key: string) => {
      if (key === "bitWidth") return 4;
      if (key === "maxValue") return 0;
      return 0;
    },
  };
  return { layout, state, highZs };
}

function makeProgramCounterLayout(): {
  layout: ComponentLayout & ProgramCounterLayout;
  state: Uint32Array;
  highZs: Uint32Array;
} {
  // ProgramCounter: inputs [D=0, en=1, C=2, ld=3], outputs [Q=4, ovf=5], state [counter=6, prevClock=7]
  const state = new Uint32Array(64);
  const highZs = new Uint32Array(64);
  const layout: ComponentLayout & ProgramCounterLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 4,
    inputOffset: () => 0,
    outputCount: () => 2,
    outputOffset: () => 4,
    stateOffset: () => 6,
  };
  return { layout, state, highZs };
}

function makeRegisterLayout(): {
  layout: ComponentLayout;
  state: Uint32Array;
  highZs: Uint32Array;
} {
  // Register: inputs [D=0, C=1, en=2], outputs [Q=3], state [storedVal=4, prevClock=5]
  const state = new Uint32Array(64);
  const highZs = new Uint32Array(64);
  const layout: ComponentLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 3,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => 3,
    stateOffset: () => 4,
  };
  return { layout, state, highZs };
}

function makeRegisterFileLayout(): {
  layout: ComponentLayout & { stateOffset(i: number): number; getProperty?(i: number, key: string): number };
  state: Uint32Array;
  highZs: Uint32Array;
} {
  // RegisterFile: inputs [Din=0, we=1, Rw=2, C=3, Ra=4, Rb=5], outputs [Da=6, Db=7], state [prevClock=8, reg[0..3]=9..12]
  const state = new Uint32Array(64);
  const highZs = new Uint32Array(64);
  const layout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 6,
    inputOffset: () => 0,
    outputCount: () => 2,
    outputOffset: () => 6,
    stateOffset: () => 8,
    getProperty: (_i: number, key: string) => {
      if (key === "addrBits") return 2;
      return 0;
    },
  };
  return { layout, state, highZs };
}

function makeProgramMemoryLayout(): {
  layout: ComponentLayout & ProgramMemoryLayout;
  state: Uint32Array;
  highZs: Uint32Array;
} {
  // ProgramMemory: inputs [A=0, ld=1, C=2], outputs [D=3], state [addrReg=4, prevClock=5]
  const state = new Uint32Array(64);
  const highZs = new Uint32Array(64);
  const layout: ComponentLayout & ProgramMemoryLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 3,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => 3,
    stateOffset: () => 4,
  };
  return { layout, state, highZs };
}

// ---------------------------------------------------------------------------
// Counter Tests (Task 2.3b)
// ---------------------------------------------------------------------------

describe("Counter", () => {
  const IDX = 0;

  it("sampleCounter_increments_on_rising_edge", () => {
    const { layout, state, highZs } = makeCounterLayout();
    const stBase = 5;

    state[0] = 1;       // en = 1
    state[1] = 0;       // C = 0
    state[stBase] = 0;  // counter = 0
    state[stBase + 1] = 0; // prevClock = 0

    // Rising edge
    state[1] = 1;
    sampleCounter(IDX, state, highZs, layout);

    expect(state[stBase]).toBe(1);

    // Call executeCounter to verify output
    executeCounter(IDX, state, highZs, layout);
    expect(state[3]).toBe(1); // out = counter
  });

  it("sampleCounter_clears_on_clr", () => {
    const { layout, state, highZs } = makeCounterLayout();
    const stBase = 5;

    state[0] = 1;       // en = 1
    state[stBase] = 5;  // counter = 5
    state[stBase + 1] = 0; // prevClock = 0

    // Rising edge with clr=1
    state[1] = 1;  // C = 1
    state[2] = 1;  // clr = 1
    sampleCounter(IDX, state, highZs, layout);

    expect(state[stBase]).toBe(0);
  });

  it("CounterDefinition has sampleFn", () => {
    expect(CounterDefinition.sampleFn).toBeDefined();
    expect(CounterDefinition.sampleFn).toBe(sampleCounter);
  });
});

// ---------------------------------------------------------------------------
// CounterPreset Tests (Task 2.3b)
// ---------------------------------------------------------------------------

describe("CounterPreset", () => {
  const IDX = 0;

  it("sampleCounterPreset_loads_on_ld", () => {
    const { layout, state, highZs } = makeCounterPresetLayout();
    const stBase = 8;

    state[0] = 0;       // en = 0
    state[1] = 0;       // C = 0
    state[2] = 0;       // dir = 0
    state[3] = 0x42;    // in = 0x42 (load value)
    state[4] = 1;       // ld = 1
    state[5] = 0;       // clr = 0
    state[stBase] = 0;  // counter = 0
    state[stBase + 1] = 0; // prevClock = 0

    // Rising edge
    state[1] = 1;
    sampleCounterPreset(IDX, state, highZs, layout);

    expect(state[stBase]).toBe(0x42 & 0xF); // masked to 4-bit
  });

  it("CounterPresetDefinition has sampleFn", () => {
    expect(CounterPresetDefinition.sampleFn).toBeDefined();
    expect(CounterPresetDefinition.sampleFn).toBe(sampleCounterPreset);
  });
});

// ---------------------------------------------------------------------------
// ProgramCounter Tests (Task 2.3b)
// ---------------------------------------------------------------------------

describe("ProgramCounter", () => {
  const IDX = 0;

  it("sampleProgramCounter_increments_on_edge", () => {
    const { layout, state, highZs } = makeProgramCounterLayout();
    const stBase = 6;

    state[0] = 0;       // D = 0
    state[1] = 1;       // en = 1
    state[2] = 0;       // C = 0
    state[3] = 0;       // ld = 0
    state[stBase] = 0;  // counter = 0
    state[stBase + 1] = 0; // prevClock = 0

    // Rising edge
    state[2] = 1;
    sampleProgramCounter(IDX, state, highZs, layout);

    expect(state[stBase]).toBe(1);

    // Reset prevClock for next edge
    state[stBase + 1] = 0;
    state[2] = 1;
    sampleProgramCounter(IDX, state, highZs, layout);

    expect(state[stBase]).toBe(2);
  });

  it("ProgramCounterDefinition has sampleFn", () => {
    expect(ProgramCounterDefinition.sampleFn).toBeDefined();
    expect(ProgramCounterDefinition.sampleFn).toBe(sampleProgramCounter);
  });
});

// ---------------------------------------------------------------------------
// Register Tests (Task 2.3b)
// ---------------------------------------------------------------------------

describe("Register", () => {
  const IDX = 0;

  it("sampleRegister_latches_on_rising_edge", () => {
    const { layout, state, highZs } = makeRegisterLayout();
    const stBase = 4;

    state[0] = 0xAB;    // D = 0xAB
    state[1] = 0;       // C = 0
    state[2] = 1;       // en = 1
    state[stBase] = 0;  // storedVal = 0
    state[stBase + 1] = 0; // prevClock = 0

    // Rising edge
    state[1] = 1;
    sampleRegister(IDX, state, highZs, layout);

    expect(state[stBase]).toBe(0xAB);

    // Execute outputs from state
    executeRegister(IDX, state, highZs, layout);
    expect(state[3]).toBe(0xAB); // Q = storedVal
  });

  it("executeRegister_outputs_from_state_not_inputs", () => {
    const { layout, state, highZs } = makeRegisterLayout();
    const stBase = 4;

    state[0] = 0xFF;    // D = 0xFF (input)
    state[1] = 0;       // C = 0 (no edge)
    state[2] = 1;       // en = 1
    state[stBase] = 0x00;  // storedVal = 0x00
    state[stBase + 1] = 0; // prevClock = 0 (but clock is 0, so no edge)

    executeRegister(IDX, state, highZs, layout);

    expect(state[3]).toBe(0x00); // Q = 0x00 from state, not 0xFF from D
  });

  it("RegisterDefinition has sampleFn", () => {
    expect(RegisterDefinition.sampleFn).toBeDefined();
    expect(RegisterDefinition.sampleFn).toBe(sampleRegister);
  });
});

// ---------------------------------------------------------------------------
// RegisterFile Tests (Task 2.3b)
// ---------------------------------------------------------------------------

describe("RegisterFile", () => {
  const IDX = 0;

  it("sampleRegisterFile_writes_on_edge", () => {
    const { layout, state, highZs } = makeRegisterFileLayout();
    const stBase = 8;

    state[0] = 0xCD;    // Din = 0xCD
    state[1] = 1;       // we = 1
    state[2] = 2;       // Rw = 2
    state[3] = 0;       // C = 0
    state[4] = 0;       // Ra = 0
    state[5] = 0;       // Rb = 0
    state[stBase] = 0;  // prevClock = 0

    // Rising edge
    state[3] = 1;
    sampleRegisterFile(IDX, state, highZs, layout);

    // register[2] in state = stBase + 1 + 2 = 11
    expect(state[stBase + 1 + 2]).toBe(0xCD);
  });

  it("RegisterFileDefinition has sampleFn", () => {
    expect(RegisterFileDefinition.sampleFn).toBeDefined();
    expect(RegisterFileDefinition.sampleFn).toBe(sampleRegisterFile);
  });
});

// ---------------------------------------------------------------------------
// ProgramMemory Tests (Task 2.3b)
// ---------------------------------------------------------------------------

describe("ProgramMemory", () => {
  const IDX = 0;

  it("sampleProgramMemory_latches_address", () => {
    const { layout, state, highZs } = makeProgramMemoryLayout();
    const stBase = 4;

    state[0] = 5;       // A = 5
    state[1] = 1;       // ld = 1
    state[2] = 0;       // C = 0
    state[stBase] = 0;  // addrReg = 0
    state[stBase + 1] = 0; // prevClock = 0

    // Rising edge
    state[2] = 1;
    sampleProgramMemory(IDX, state, highZs, layout);

    expect(state[stBase]).toBe(5);
  });

  it("ProgramMemoryDefinition has sampleFn", () => {
    expect(ProgramMemoryDefinition.sampleFn).toBeDefined();
    expect(ProgramMemoryDefinition.sampleFn).toBe(sampleProgramMemory);
  });
});

// ---------------------------------------------------------------------------
// RAM Tests
// ---------------------------------------------------------------------------

describe("RAM", () => {
  const IDX = 0;

  beforeEach(() => {
    clearBackingStores();
  });

  it("sampleRam_stores_on_clock_edge", () => {
    const layout = makeRAMLayout(5, 1);
    const stBase = 5 + 1;
    const state = new Uint32Array(64);
    const highZs = new Uint32Array(64);
    const mem = new DataField(16);
    registerBackingStore(IDX, mem);

    // RAMDualPort: inputs [A=0, Din=1, str=2, C=3, ld=4], output [D=5]
    // Set addr=3, din=0xFF, str=1, clock low->high
    state[0] = 3;       // A
    state[1] = 0xFF;    // Din
    state[2] = 1;       // str
    state[3] = 0;       // C (low initially)
    state[stBase] = 0;  // lastClk = 0

    // Clock goes high
    state[3] = 1;
    sampleRAMDualPort(IDX, state, highZs, layout);

    expect(mem.read(3)).toBe(0xFF);
  });

  it("sampleRam_ignores_when_we_low", () => {
    const layout = makeRAMLayout(5, 1);
    const stBase = 5 + 1;
    const state = new Uint32Array(64);
    const highZs = new Uint32Array(64);
    const mem = new DataField(16);
    registerBackingStore(IDX, mem);

    // Set addr=3, din=0xFF, str=0 (write-enable low), clock edge
    state[0] = 3;       // A
    state[1] = 0xFF;    // Din
    state[2] = 0;       // str = 0
    state[3] = 1;       // C = high
    state[stBase] = 0;  // lastClk = 0 (rising edge)

    sampleRAMDualPort(IDX, state, highZs, layout);

    expect(mem.read(3)).toBe(0);
  });

  it("executeRam_reads_from_state", () => {
    const layout = makeRAMLayout(5, 1);
    const state = new Uint32Array(64);
    const highZs = new Uint32Array(64);
    const mem = new DataField(16);
    registerBackingStore(IDX, mem);

    // Pre-populate memory
    mem.write(3, 0xAB);

    // Set addr=3, ld=1
    state[0] = 3;       // A
    state[4] = 1;       // ld

    executeRAMDualPort(IDX, state, highZs, layout);

    expect(state[5]).toBe(0xAB);
  });

  it("RAMSinglePort has sampleFn", () => {
    expect(RAMSinglePortDefinition.sampleFn).toBeDefined();
    expect(RAMSinglePortDefinition.sampleFn).toBe(sampleRAMSinglePort);
  });

  it("RAMDualPort has sampleFn", () => {
    expect(RAMDualPortDefinition.sampleFn).toBeDefined();
    expect(RAMDualPortDefinition.sampleFn).toBe(sampleRAMDualPort);
  });

  it("RAMDualAccess has sampleFn", () => {
    expect(RAMDualAccessDefinition.sampleFn).toBeDefined();
    expect(RAMDualAccessDefinition.sampleFn).toBe(sampleRAMDualAccess);
  });

  it("BlockRAMDualPort has sampleFn", () => {
    expect(BlockRAMDualPortDefinition.sampleFn).toBeDefined();
    expect(BlockRAMDualPortDefinition.sampleFn).toBe(sampleBlockRAMDualPort);
  });

  it("RAMSinglePortSel has no sampleFn (combinational)", () => {
    expect(RAMSinglePortSelDefinition.sampleFn).toBeUndefined();
  });

  it("RAMAsync has no sampleFn (combinational)", () => {
    expect(RAMAsyncDefinition.sampleFn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EEPROM Tests
// ---------------------------------------------------------------------------

describe("EEPROM", () => {
  const IDX = 0;

  beforeEach(() => {
    clearBackingStores();
  });

  it("sampleEeprom_captures_write", () => {
    // EEPROM: inputs [A=0, CS=1, WE=2, OE=3, Din=4], output [D=5]
    const layout = makeEEPROMLayout(5, 1);
    const stBase = 5 + 1;
    const state = new Uint32Array(64);
    const highZs = new Uint32Array(64);
    const mem = new DataField(16);
    registerBackingStore(IDX, mem);

    // Step 1: Rising edge of WE (captures address)
    state[0] = 1;       // A = 1
    state[1] = 1;       // CS = 1
    state[2] = 1;       // WE = 1 (rising edge)
    state[3] = 0;       // OE = 0
    state[4] = 0x55;    // Din = 0x55
    state[stBase] = 0;  // lastWE = 0

    sampleEEPROM(IDX, state, highZs, layout);

    // Address should be captured in stBase+1
    expect(state[stBase + 1]).toBe(1);
    expect(state[stBase]).toBe(1); // lastWE updated to 1

    // Step 2: Falling edge of WE (commits write)
    state[2] = 0;       // WE = 0 (falling edge)
    state[4] = 0x55;    // Din still 0x55

    sampleEEPROM(IDX, state, highZs, layout);

    expect(mem.read(1)).toBe(0x55);
  });

  it("executeEeprom_reads_from_state", () => {
    const layout = makeEEPROMLayout(5, 1);
    const state = new Uint32Array(64);
    const highZs = new Uint32Array(64);
    const mem = new DataField(16);
    registerBackingStore(IDX, mem);

    mem.write(1, 0x55);

    // CS=1, OE=1, WE=0 -> read mode
    state[0] = 1;       // A = 1
    state[1] = 1;       // CS = 1
    state[2] = 0;       // WE = 0
    state[3] = 1;       // OE = 1

    executeEEPROM(IDX, state, highZs, layout);

    expect(state[5]).toBe(0x55);
  });

  it("EEPROMDualPort has sampleFn", () => {
    expect(EEPROMDualPortDefinition.sampleFn).toBeDefined();
    expect(EEPROMDualPortDefinition.sampleFn).toBe(sampleEEPROMDualPort);
  });

  it("EEPROM has sampleFn", () => {
    expect(EEPROMDefinition.sampleFn).toBeDefined();
    expect(EEPROMDefinition.sampleFn).toBe(sampleEEPROM);
  });
});

// ---------------------------------------------------------------------------
// PRNG Tests
// ---------------------------------------------------------------------------

describe("PRNG", () => {
  const IDX = 0;

  it("samplePrng_advances_lfsr_on_edge", () => {
    // PRNG: inputs [S=0, se=1, ne=2, C=3], output [R=4]
    const layout = makePRNGLayout(4, 1);
    const stBase = 4 + 1;
    const state = new Uint32Array(64);
    const highZs = new Uint32Array(64);

    // Initialize LFSR state to a known non-zero value
    state[stBase] = 1;      // lfsrState = 1
    state[stBase + 1] = 0;  // prevClock = 0

    // Set ne=1, clock low->high
    state[1] = 0;  // se = 0
    state[2] = 1;  // ne = 1
    state[3] = 1;  // C = 1 (rising edge)

    samplePRNG(IDX, state, highZs, layout as ComponentLayout);

    const state1 = state[stBase];
    expect(state1).not.toBe(1); // LFSR advanced

    // Call again with another rising edge
    state[stBase + 1] = 0;  // reset prevClock
    state[3] = 1;           // C = 1

    samplePRNG(IDX, state, highZs, layout as ComponentLayout);

    const state2 = state[stBase];
    expect(state2).not.toBe(state1); // Different again
  });

  it("executePrng_outputs_from_state", () => {
    const layout = makePRNGLayout(4, 1);
    const stBase = 4 + 1;
    const state = new Uint32Array(64);
    const highZs = new Uint32Array(64);

    state[stBase] = 42;     // lfsrState = 42
    state[stBase + 1] = 1;  // prevClock (irrelevant for execute)

    executePRNG(IDX, state, highZs, layout as ComponentLayout);

    expect(state[4]).toBe(42); // Output R = lfsrState
  });

  it("PRNGDefinition has sampleFn", () => {
    expect(PRNGDefinition.sampleFn).toBeDefined();
    expect(PRNGDefinition.sampleFn).toBe(samplePRNG);
  });
});

// ---------------------------------------------------------------------------
// ROM — confirm no sampleFn
// ---------------------------------------------------------------------------

describe("ROM", () => {
  it("has_no_sampleFn", () => {
    expect(ROMDefinition.sampleFn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LookupTable — confirm no sampleFn
// ---------------------------------------------------------------------------

describe("LookupTable", () => {
  it("has_no_sampleFn", () => {
    expect(LookUpTableDefinition.sampleFn).toBeUndefined();
  });
});
