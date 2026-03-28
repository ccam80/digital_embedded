/**
 * Component sweep E2E tests — Phase 5 of the test plan.
 *
 * Parametrized tests that place every component type from the palette,
 * and for width-configurable components, test at multiple bit widths.
 *
 * 5A — Placement Sweep: every type can be placed from the palette
 * 5B — Bit-Width Variation Sweep: width-configurable components at multiple widths
 * 5C — Per-Component Engine Mode Sweep: dual-engine components in each mode
 *
 * See spec/e2e-circuit-assembly-test-plan.md for full plan.
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ===========================================================================
// 5A — Component type lists by category
// ===========================================================================

const LOGIC = ['And', 'Or', 'Not', 'NAnd', 'NOr', 'XOr', 'XNOr'];

const IO = [
  'In', 'Out', 'Clock', 'Const', 'Button', 'ButtonLED', 'DipSwitch',
  'Ground', 'VDD', 'NotConnected', 'LED', 'PolarityAwareLED', 'LightBulb',
  'RGBLED', 'Probe', 'Scope', 'ScopeTrigger', 'SevenSeg', 'SevenSegHex',
  'SixteenSeg', 'PowerSupply', 'MIDI', 'RotEncoder',
  'StepperMotorBipolar', 'StepperMotorUnipolar',
];

const FLIP_FLOPS = [
  'D_FF', 'D_FF_AS', 'JK_FF', 'JK_FF_AS',
  'RS_FF', 'RS_FF_AS', 'T_FF', 'Monoflop',
];

const MEMORY = [
  'Counter', 'CounterPreset', 'Register', 'RegisterFile',
  'ROM', 'ROMDualPort', 'EEPROM', 'EEPROMDualPort', 'LookUpTable',
  'ProgramCounter', 'ProgramMemory',
  'RAMSinglePort', 'RAMSinglePortSel', 'RAMDualPort',
  'RAMDualAccess', 'RAMAsync', 'BlockRAMDualPort',
];

const ARITHMETIC = [
  'Add', 'Sub', 'Mul', 'Div', 'MagnitudeComparator', 'Neg',
  'BitExtender', 'BarrelShifter', 'BitCount', 'PRNG',
];

const WIRING = [
  'Multiplexer', 'Demultiplexer', 'Decoder', 'BitSelector',
  'PriorityEncoder', 'Splitter', 'BusSplitter',
  'Driver', 'DriverInvSel', 'Tunnel', 'Delay',
  'AsyncSeq', 'Reset', 'Stop', 'Break',
];

const SWITCHING = [
  'Relay', 'RelayDT', 'Switch', 'SwitchDT', 'TransGate',
  'NFET', 'PFET', 'FGNFET', 'FGPFET', 'Fuse',
];

const PLD = ['Diode', 'PldDiodeForward', 'PldDiodeBackward', 'PullUp', 'PullDown'];

const PASSIVES = [
  'Resistor', 'Capacitor', 'Inductor',
  'Potentiometer', 'Transformer', 'TappedTransformer',
  'QuartzCrystal', 'Memristor', 'PolarizedCap',
  'TransmissionLine', 'LDR', 'NTCThermistor', 'SparkGap',
];

const SEMICONDUCTORS = [
  'Diode', 'ZenerDiode', 'NpnBJT', 'PnpBJT',
  'NMOS', 'PMOS', 'NJFET', 'PJFET',
  'SCR', 'Triac', 'Diac', 'TunnelDiode', 'VaractorDiode', 'Triode',
];

const SOURCES = [
  'AcVoltageSource', 'DcVoltageSource', 'CurrentSource',
  'Ground', 'VariableRail',
];

const ACTIVE = [
  'OpAmp', 'RealOpAmp', 'OTA', 'Timer555',
  'VoltageComparator', 'SchmittInverting', 'SchmittNonInverting',
  'DAC', 'ADC', 'Optocoupler',
  'SwitchSPST', 'SwitchSPDT',
  'VCVS', 'VCCS', 'CCVS', 'CCCS',
];

const GRAPHICS = ['LedMatrix', 'VGA', 'GraphicCard'];

const TERMINAL = ['Keyboard', 'Terminal'];

// Representative 74XX sample (full series has 120+ types)
const SAMPLE_74XX = [
  '7400', '7402', '7404', '7408', '7432', '7486',
  '7474', '74138', '74161', '74245',
];

/** All component types for the placement sweep, grouped with category. */
const ALL_SWEEP_TYPES: Array<{ type: string; category: string }> = [
  ...LOGIC.map(t => ({ type: t, category: 'LOGIC' })),
  ...IO.map(t => ({ type: t, category: 'IO' })),
  ...FLIP_FLOPS.map(t => ({ type: t, category: 'FLIP_FLOPS' })),
  ...MEMORY.map(t => ({ type: t, category: 'MEMORY' })),
  ...ARITHMETIC.map(t => ({ type: t, category: 'ARITHMETIC' })),
  ...WIRING.map(t => ({ type: t, category: 'WIRING' })),
  ...SWITCHING.map(t => ({ type: t, category: 'SWITCHING' })),
  ...PLD.map(t => ({ type: t, category: 'PLD' })),
  ...PASSIVES.map(t => ({ type: t, category: 'PASSIVES' })),
  ...SEMICONDUCTORS.map(t => ({ type: t, category: 'SEMICONDUCTORS' })),
  ...SOURCES.map(t => ({ type: t, category: 'SOURCES' })),
  ...ACTIVE.map(t => ({ type: t, category: 'ACTIVE' })),
  ...GRAPHICS.map(t => ({ type: t, category: 'GRAPHICS' })),
  ...TERMINAL.map(t => ({ type: t, category: 'TERMINAL' })),
  ...SAMPLE_74XX.map(t => ({ type: t, category: '74XX' })),
];

// ===========================================================================
// 5B — Bit-width variation matrix
//
// Each entry defines: component type, internal property key for width,
// widths to test. Pin names are derived from the registry via resolveTestPins().
// inputPinWidth overrides the width set on the SRC In component (for components
// whose control pin, e.g. clock, is always 1-bit regardless of data width).
// ===========================================================================

interface WidthTestEntry {
  type: string;
  /** Internal property key, e.g. 'bitWidth', 'selectorBits'. */
  propKey: string;
  widths: number[];
  /** Override for the SRC In component width (e.g. clock pin is always 1-bit). */
  inputPinWidth?: number;
}

const WIDTH_MATRIX: WidthTestEntry[] = [
  // Gates — bitWidth controls all I/O pin widths
  { type: 'And',  propKey: 'bitWidth', widths: [1, 2, 4, 8, 16, 32] },
  { type: 'Or',   propKey: 'bitWidth', widths: [1, 2, 4, 8, 16, 32] },
  { type: 'XOr',  propKey: 'bitWidth', widths: [1, 2, 4, 8, 16, 32] },
  { type: 'NAnd', propKey: 'bitWidth', widths: [1, 2, 4, 8, 16, 32] },
  { type: 'NOr',  propKey: 'bitWidth', widths: [1, 2, 4, 8, 16, 32] },
  { type: 'XNOr', propKey: 'bitWidth', widths: [1, 2, 4, 8, 16, 32] },
  { type: 'Not',  propKey: 'bitWidth', widths: [1, 2, 4, 8, 16, 32] },

  // I/O
  { type: 'In',  propKey: 'bitWidth', widths: [1, 2, 4, 8, 16, 32] },
  { type: 'Out', propKey: 'bitWidth', widths: [1, 2, 4, 8, 16, 32] },

  // Arithmetic — bitWidth controls operand + result widths
  { type: 'Add',                propKey: 'bitWidth', widths: [1, 4, 8, 16, 32] },
  { type: 'Sub',                propKey: 'bitWidth', widths: [1, 4, 8, 16, 32] },
  { type: 'Mul',                propKey: 'bitWidth', widths: [1, 4, 8, 16, 32] },
  { type: 'Div',                propKey: 'bitWidth', widths: [1, 4, 8, 16, 32] },
  { type: 'MagnitudeComparator', propKey: 'bitWidth', widths: [1, 4, 8, 16] },

  // Counters — bitWidth controls output width, clock input is always 1-bit
  { type: 'Counter',       propKey: 'bitWidth', widths: [2, 4, 8, 16], inputPinWidth: 1 },
  { type: 'CounterPreset', propKey: 'bitWidth', widths: [2, 4, 8, 16], inputPinWidth: 1 },

  // Registers
  { type: 'Register', propKey: 'bitWidth', widths: [1, 4, 8, 16, 32] },

  // Flip-flops
  { type: 'D_FF',     propKey: 'bitWidth', widths: [1, 4, 8] },
  { type: 'D_FF_AS',  propKey: 'bitWidth', widths: [1, 4, 8] },
  { type: 'JK_FF',    propKey: 'bitWidth', widths: [1, 4, 8] },
  { type: 'JK_FF_AS', propKey: 'bitWidth', widths: [1, 4, 8] },

  // Wiring components
  { type: 'Decoder',         propKey: 'selectorBits', widths: [1, 2, 3, 4] },
  { type: 'BitSelector',     propKey: 'selectorBits', widths: [2, 3, 4, 5] },
  { type: 'PriorityEncoder', propKey: 'selectorBits',  widths: [2, 4] },
  { type: 'BarrelShifter',   propKey: 'bitWidth',     widths: [4, 8, 16, 32] },
  { type: 'Driver',          propKey: 'bitWidth',     widths: [1, 4, 8, 16] },
  { type: 'DriverInvSel',    propKey: 'bitWidth',     widths: [1, 4, 8, 16] },
  { type: 'Delay',           propKey: 'bitWidth',     widths: [1, 4, 8, 16] },
  { type: 'BusSplitter',     propKey: 'bitWidth',     widths: [2, 4, 8, 16] },

  // DAC/ADC — bits property (internal key: 'bits', label: 'Resolution (bits)')
  { type: 'DAC', propKey: 'bits', widths: [4, 8] },
  { type: 'ADC', propKey: 'bits', widths: [4, 8] },
];

// ---------------------------------------------------------------------------
// resolveTestPins — derives input/output pin labels from the registry
// ---------------------------------------------------------------------------

/**
 * Describes the wiring topology needed for a given WIDTH_MATRIX entry.
 * inputPin / outputPin are the pin labels on the DUT to wire.
 * srcWidth is the width to set on the SRC In component.
 * dstWidth is the width to set on the DST Out component.
 */
interface ResolvedPins {
  inputPin: string;
  outputPin: string;
  srcWidth: number;
  dstWidth: number;
}

/**
 * Derives which input and output pin to use for wiring a SRC→DUT→DST circuit.
 * Uses the registry to find the first INPUT and first OUTPUT pin, then applies
 * per-component overrides for components with non-obvious topologies.
 */
async function resolveTestPins(
  builder: UICircuitBuilder,
  entry: WidthTestEntry,
  width: number,
): Promise<ResolvedPins> {
  const desc = await builder.describeComponent(entry.type);

  // Per-component overrides for non-obvious pin layouts

  // BusSplitter: D pin is the wide aggregate bus. No output pin wired in this test.
  if (entry.type === 'BusSplitter') {
    return { inputPin: 'OE', outputPin: '', srcWidth: 1, dstWidth: width };
  }

  // MagnitudeComparator: output pins (>, =, <) are always 1-bit regardless of width.
  if (entry.type === 'MagnitudeComparator') {
    return { inputPin: 'a', outputPin: '>', srcWidth: width, dstWidth: 1 };
  }

  // Decoder: output pins out_0…out_N are always 1-bit; sel is selectorBits wide.
  if (entry.type === 'Decoder') {
    return { inputPin: 'sel', outputPin: 'out_0', srcWidth: width, dstWidth: 1 };
  }

  // BitSelector: input bus is 2^selectorBits wide; output is always 1-bit.
  if (entry.type === 'BitSelector') {
    const inputWidth = Math.pow(2, width);
    return { inputPin: 'in', outputPin: 'out', srcWidth: inputWidth, dstWidth: 1 };
  }

  // PriorityEncoder: selectorBits=N gives 2^N 1-bit inputs (in0..in(2^N-1));
  // output 'num' is N bits wide (same as selectorBits = width).
  if (entry.type === 'PriorityEncoder') {
    return { inputPin: 'in0', outputPin: 'num', srcWidth: 1, dstWidth: width };
  }

  // Mul: output is 2*bitWidth (capped at 32).
  if (entry.type === 'Mul') {
    const outWidth = Math.min(width * 2, 32);
    return { inputPin: 'a', outputPin: 'mul', srcWidth: width, dstWidth: outWidth };
  }

  // In: output-only component — no input pin to wire.
  if (entry.type === 'In') {
    return { inputPin: '', outputPin: 'out', srcWidth: width, dstWidth: width };
  }

  // Out: input-only component — no output pin to wire.
  if (entry.type === 'Out') {
    return { inputPin: 'in', outputPin: '', srcWidth: width, dstWidth: width };
  }

  // Counter/CounterPreset: clock pin is always 1-bit.
  if (entry.type === 'Counter' || entry.type === 'CounterPreset') {
    return { inputPin: 'C', outputPin: 'out', srcWidth: 1, dstWidth: width };
  }

  // D_FF_AS: first INPUT pin is 'Set' (1-bit), but data pin is 'D' (bitWidth wide).
  // Wire D→Q to exercise the data path at the configured width.
  if (entry.type === 'D_FF_AS') {
    return { inputPin: 'D', outputPin: 'Q', srcWidth: width, dstWidth: width };
  }

  // JK_FF_AS: first INPUT pin is 'Set' (1-bit), but data pin is 'J' (bitWidth wide).
  // Wire J→Q to exercise the data path at the configured width.
  if (entry.type === 'JK_FF_AS') {
    return { inputPin: 'J', outputPin: 'Q', srcWidth: width, dstWidth: width };
  }

  // DAC: digital input D0, analog output OUT (no Out component needed).
  if (entry.type === 'DAC') {
    return { inputPin: 'D0', outputPin: '', srcWidth: 1, dstWidth: width };
  }

  // ADC: analog input VIN (no In component), digital output D0.
  if (entry.type === 'ADC') {
    return { inputPin: '', outputPin: 'D0', srcWidth: width, dstWidth: 1 };
  }

  // Generic: first INPUT pin → inputPin, first OUTPUT pin → outputPin.
  if (!desc) {
    return { inputPin: '', outputPin: '', srcWidth: width, dstWidth: width };
  }

  const firstInput  = desc.pinLayout.find(p => p.direction === 'INPUT');
  const firstOutput = desc.pinLayout.find(p => p.direction === 'OUTPUT');

  return {
    inputPin:  firstInput?.label  ?? '',
    outputPin: firstOutput?.label ?? '',
    srcWidth:  entry.inputPinWidth ?? width,
    dstWidth:  width,
  };
}

// Selector-bits × data-bits matrix for Mux/Demux
interface MuxWidthEntry {
  type: string;
  selectorBits: number;
  dataBits: number;
}

const MUX_MATRIX: MuxWidthEntry[] = [
  // Multiplexer
  { type: 'Multiplexer', selectorBits: 1, dataBits: 1 },
  { type: 'Multiplexer', selectorBits: 1, dataBits: 4 },
  { type: 'Multiplexer', selectorBits: 1, dataBits: 8 },
  { type: 'Multiplexer', selectorBits: 2, dataBits: 1 },
  { type: 'Multiplexer', selectorBits: 2, dataBits: 4 },
  { type: 'Multiplexer', selectorBits: 3, dataBits: 1 },
  { type: 'Multiplexer', selectorBits: 4, dataBits: 1 },
  // Demultiplexer
  { type: 'Demultiplexer', selectorBits: 1, dataBits: 1 },
  { type: 'Demultiplexer', selectorBits: 1, dataBits: 4 },
  { type: 'Demultiplexer', selectorBits: 2, dataBits: 1 },
  { type: 'Demultiplexer', selectorBits: 2, dataBits: 4 },
  { type: 'Demultiplexer', selectorBits: 3, dataBits: 1 },
  { type: 'Demultiplexer', selectorBits: 4, dataBits: 1 },
];

// Memory width matrix: address bits × data bits
interface MemWidthEntry {
  type: string;
  addrBits: number;
  dataBits: number;
}

const MEM_MATRIX: MemWidthEntry[] = [
  { type: 'ROM', addrBits: 2, dataBits: 4 },
  { type: 'ROM', addrBits: 4, dataBits: 8 },
  { type: 'ROM', addrBits: 8, dataBits: 16 },
  { type: 'ROMDualPort', addrBits: 2, dataBits: 8 },
  { type: 'ROMDualPort', addrBits: 4, dataBits: 16 },
  { type: 'RAMSinglePort', addrBits: 2, dataBits: 4 },
  { type: 'RAMSinglePort', addrBits: 4, dataBits: 8 },
  { type: 'RAMSinglePort', addrBits: 8, dataBits: 16 },
  { type: 'RAMDualPort', addrBits: 2, dataBits: 8 },
  { type: 'RAMDualPort', addrBits: 4, dataBits: 16 },
  { type: 'RAMAsync', addrBits: 2, dataBits: 4 },
  { type: 'RAMAsync', addrBits: 4, dataBits: 8 },
  { type: 'EEPROM', addrBits: 2, dataBits: 4 },
  { type: 'EEPROM', addrBits: 4, dataBits: 8 },
  { type: 'EEPROM', addrBits: 8, dataBits: 16 },
];

// BitExtender: inputBits → outputBits pairs
interface ExtenderEntry {
  inputBits: number;
  outputBits: number;
}

const EXTENDER_MATRIX: ExtenderEntry[] = [
  { inputBits: 4, outputBits: 8 },
  { inputBits: 8, outputBits: 16 },
  { inputBits: 16, outputBits: 32 },
];

// Splitter patterns: total width and split pattern
interface SplitterEntry {
  inputSplitting: string;
  outputSplitting: string;
}

const SPLITTER_MATRIX: SplitterEntry[] = [
  { inputSplitting: '4,4', outputSplitting: '8' },
  { inputSplitting: '8,8', outputSplitting: '16' },
  { inputSplitting: '4,4,4,4', outputSplitting: '16' },
  { inputSplitting: '16,16', outputSplitting: '32' },
];

// Tunnel widths
const TUNNEL_WIDTHS = [1, 4, 8, 16];

// ===========================================================================
// 5C — Dual-engine component list
// ===========================================================================

interface DualEngineEntry {
  type: string;
  modes: string[];
}

const DUAL_ENGINE_TYPES: DualEngineEntry[] = [
  { type: 'And', modes: ['digital', 'analog'] },
  { type: 'Or', modes: ['digital', 'analog'] },
  { type: 'Not', modes: ['digital', 'analog'] },
  { type: 'NAnd', modes: ['digital', 'analog'] },
  { type: 'NOr', modes: ['digital', 'analog'] },
  { type: 'XOr', modes: ['digital', 'analog'] },
  { type: 'XNOr', modes: ['digital', 'analog'] },
  { type: 'D_FF', modes: ['digital', 'analog'] },
  { type: 'JK_FF', modes: ['digital', 'analog'] },
  { type: 'RS_FF', modes: ['digital', 'analog'] },
  { type: 'T_FF', modes: ['digital', 'analog'] },
  { type: 'VoltageComparator', modes: ['analog', 'mixed'] },
  { type: 'DAC', modes: ['mixed'] },
  { type: 'ADC', modes: ['mixed'] },
];

// ===========================================================================
// 5B — Per-component expected-output logic for signal propagation checks
//
// The WIDTH_MATRIX test wires SRC→DUT:inputPin and DUT:outputPin→DST.
// For multi-input components only ONE input is wired; the others default to 0.
// This function returns the expected output value, or null to skip the check.
// ===========================================================================

/**
 * Compute the expected output for a component with one input wired and
 * all other inputs at their default (0).  Returns null when the signal
 * check should be skipped (sequential components needing a clock edge,
 * components whose enable/select pin is not wired, division by zero, etc.).
 */
function expectedOutput(type: string, inputVal: number, width: number): number | null {
  const mask = width >= 32 ? 0xFFFFFFFF : (1 << width) - 1;
  switch (type) {
    // --- Logic gates (one input wired, other input(s) = 0) ---
    case 'And':   return 0;                       // AND(x, 0) = 0
    case 'Or':    return inputVal & mask;          // OR(x, 0) = x
    case 'XOr':   return inputVal & mask;          // XOR(x, 0) = x
    case 'NAnd':  return mask;                     // NAND(x, 0) = all-ones
    case 'NOr':   return ((~inputVal) & mask) >>> 0; // NOR(x, 0) = NOT(x)
    case 'XNOr':  return ((~inputVal) & mask) >>> 0; // XNOR(x, 0) = NOT(x)
    case 'Not':   return ((~inputVal) & mask) >>> 0; // NOT(x)

    // --- Arithmetic (a wired, b = 0) ---
    case 'Add':   return inputVal & mask;          // x + 0 = x
    case 'Sub':   return inputVal & mask;          // x - 0 = x
    case 'Mul':   return 0;                        // x * 0 = 0

    // --- Pass-through wiring ---
    case 'Delay':        return inputVal & mask;
    case 'BusSplitter':  return inputVal & mask;

    // --- Skip: division by zero ---
    case 'Div':          return null;

    // --- Skip: output pin width differs from input (1-bit flag output) ---
    case 'MagnitudeComparator':   return null;

    // --- Skip: sel/enable pin not wired → high-Z output ---
    case 'Driver':       return null;
    case 'DriverInvSel': return null;

    // --- Skip: shift/select pin not wired, output depends on unwired pin ---
    case 'BarrelShifter':    return null;
    case 'BitSelector':      return null;
    case 'Decoder':          return null;
    case 'PriorityEncoder':  return null;

    // --- Skip: sequential components need clock edges ---
    case 'Counter':        return null;
    case 'CounterPreset':  return null;
    case 'Register':       return null;
    case 'D_FF':           return null;
    case 'D_FF_AS':        return null;
    case 'JK_FF':          return null;
    case 'JK_FF_AS':       return null;

    // --- Skip: mixed-signal components (DAC/ADC) ---
    case 'DAC':  return null;
    case 'ADC':  return null;

    // --- Skip: I/O-only (In has no inputPin, Out has no outputPin) ---
    case 'In':   return null;
    case 'Out':  return null;

    // Unknown type — skip rather than guess wrong
    default:     return null;
  }
}

// ===========================================================================
// Tests
// ===========================================================================

test.describe('Component sweep tests', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
  });

  // =========================================================================
  // 5A — Placement + Compilation Sweep
  //
  // For every registered component type, verify it can be found in the
  // palette and placed on the canvas via a genuine UI click sequence.
  // =========================================================================

  test.describe('5A — Placement Sweep', () => {

    for (const { type, category } of ALL_SWEEP_TYPES) {
      test(`${category}/${type} can be placed from palette`, async () => {
        const before = await builder.getCircuitInfo();
        await builder.placeComponent(type, 5, 5);
        const after = await builder.getCircuitInfo();
        expect(
          after.elementCount,
          `Expected element count to increase by 1 after placing ${type}`,
        ).toBe(before.elementCount + 1);

        // Verify the placed element has the expected type
        const placed = after.elements[after.elements.length - 1];
        expect(placed.typeId).toBe(type);
      });
    }
  });

  // =========================================================================
  // 5B — Bit-Width Variation Sweep
  //
  // For width-configurable components, place the component, set its width
  // property via the property popup, wire matching-width In/Out, compile,
  // and verify no errors.
  // =========================================================================

  test.describe('5B — Bit-Width Variation Sweep', () => {

    // -----------------------------------------------------------------------
    // Standard width-property components (single property controls width)
    // -----------------------------------------------------------------------

    for (const entry of WIDTH_MATRIX) {
      for (const width of entry.widths) {
        test(`${entry.type} at ${entry.propKey}=${width}: set property and compile`, async () => {
          // Place the component under test with a label
          await builder.placeLabeled(entry.type, 10, 8, 'DUT');

          // Resolve display label for this property key from the registry
          const propLabel = await builder.resolvePropertyLabel(entry.type, entry.propKey);

          // Set width property via popup
          await builder.setComponentProperty('DUT', propLabel, width);

          // Resolve which pins to wire from the registry
          const pins = await resolveTestPins(builder, entry, width);

          // Resolve display label for the bitWidth property on In/Out
          const bitsLabel = await builder.resolvePropertyLabel('In', 'bitWidth');

          // Place matching-width In and Out (if pins exist for wiring)
          if (pins.inputPin) {
            await builder.placeLabeled('In', 3, 8, 'SRC');
            await builder.setComponentProperty('SRC', bitsLabel, pins.srcWidth);
            await builder.drawWire('SRC', 'out', 'DUT', pins.inputPin);
          }
          if (pins.outputPin) {
            await builder.placeLabeled('Out', 18, 8, 'DST');
            await builder.setComponentProperty('DST', bitsLabel, pins.dstWidth);
            await builder.drawWire('DUT', pins.outputPin, 'DST', 'in');
          }

          // Extra pins required by specific component types to avoid unconnected-input errors
          if (entry.type === 'D_FF_AS' || entry.type === 'JK_FF_AS') {
            // Clock pin must be driven — tie it low via a Const
            await builder.placeLabeled('Const', 3, 14, 'CLK_TIE');
            await builder.drawWire('CLK_TIE', 'out', 'DUT', 'C');
          }
          if (entry.type === 'Driver' || entry.type === 'DriverInvSel') {
            // sel pin must be driven — tie it high so signal passes through
            await builder.placeLabeled('Const', 3, 14, 'SEL_TIE');
            await builder.setComponentProperty('SEL_TIE', 'Value', 1);
            await builder.drawWire('SEL_TIE', 'out', 'DUT', 'sel');
          }
          if (entry.type === 'DAC') {
            // VREF and GND must be driven for the DAC analog model to compile
            await builder.placeLabeled('DcVoltageSource', 3, 14, 'VREF_SRC');
            await builder.drawWire('VREF_SRC', 'pos', 'DUT', 'VREF');
            await builder.placeLabeled('Ground', 3, 18, 'GND_TIE');
            await builder.drawWire('GND_TIE', 'out', 'DUT', 'GND');
          }

          // Compile and verify
          await builder.stepViaUI();
          await builder.verifyNoErrors();

          // Signal propagation check: drive SRC and read DST
          // Use per-component expected output (gates, arithmetic, etc. behave
          // differently when only one input is wired and others default to 0).
          if (pins.inputPin && pins.outputPin) {
            const testVal = Math.min(3, (1 << Math.min(width, 30)) - 1);
            const expected = expectedOutput(entry.type, testVal, width);
            if (expected !== null) {
              const result = await builder.runTestVectors(`SRC DST\n${testVal} ${expected}`);
              expect(result.failed, `Signal check failed for ${entry.type} at width=${width}: expected ${expected} for input ${testVal}, details: ${JSON.stringify(result.details)}`).toBe(0);
            }
          }
        });
      }
    }

    // -----------------------------------------------------------------------
    // Mux/Demux: selectorBits × dataBits combinations
    // -----------------------------------------------------------------------

    for (const entry of MUX_MATRIX) {
      test(`${entry.type} sel=${entry.selectorBits} data=${entry.dataBits}: set properties and compile`, async () => {
        await builder.placeLabeled(entry.type, 10, 8, 'DUT');
        const selLabel  = await builder.resolvePropertyLabel(entry.type, 'selectorBits');
        const dataLabel = await builder.resolvePropertyLabel(entry.type, 'bitWidth');
        await builder.setComponentProperty('DUT', selLabel, entry.selectorBits);
        await builder.setComponentProperty('DUT', dataLabel, entry.dataBits);

        // Resolve display label for the bitWidth property on In/Out
        const bitsLabel = await builder.resolvePropertyLabel('In', 'bitWidth');

        // Wire selector input
        await builder.placeLabeled('In', 3, 4, 'SEL');
        await builder.setComponentProperty('SEL', bitsLabel, entry.selectorBits);
        await builder.drawWire('SEL', 'out', 'DUT', 'sel');

        // Wire first data input/output
        if (entry.type === 'Multiplexer') {
          await builder.placeLabeled('In', 3, 10, 'D0');
          await builder.setComponentProperty('D0', bitsLabel, entry.dataBits);
          await builder.drawWire('D0', 'out', 'DUT', 'in_0');
          await builder.placeLabeled('Out', 18, 8, 'Y');
          await builder.setComponentProperty('Y', bitsLabel, entry.dataBits);
          await builder.drawWire('DUT', 'out', 'Y', 'in');
        } else {
          await builder.placeLabeled('In', 3, 10, 'DIN');
          await builder.setComponentProperty('DIN', bitsLabel, entry.dataBits);
          await builder.drawWire('DIN', 'out', 'DUT', 'in');
          await builder.placeLabeled('Out', 18, 8, 'Y0');
          await builder.setComponentProperty('Y0', bitsLabel, entry.dataBits);
          await builder.drawWire('DUT', 'out_0', 'Y0', 'in');
        }

        await builder.stepViaUI();
        await builder.verifyNoErrors();
      });
    }

    // -----------------------------------------------------------------------
    // Memory: addrBits × dataBits combinations
    // -----------------------------------------------------------------------

    for (const entry of MEM_MATRIX) {
      test(`${entry.type} addr=${entry.addrBits} data=${entry.dataBits}: set properties and compile`, async () => {
        await builder.placeLabeled(entry.type, 10, 8, 'DUT');
        const addrLabel = await builder.resolvePropertyLabel(entry.type, 'addrBits');
        const dataLabel = await builder.resolvePropertyLabel(entry.type, 'dataBits');
        await builder.setComponentProperty('DUT', addrLabel, entry.addrBits);
        await builder.setComponentProperty('DUT', dataLabel, entry.dataBits);

        // ROMDualPort has ports A1/D1 instead of A/D
        const addrPin = entry.type === 'ROMDualPort' ? 'A1' : 'A';
        const dataPin = entry.type === 'ROMDualPort' ? 'D1' : 'D';

        // Resolve display label for the bitWidth property on In/Out
        const bitsLabel = await builder.resolvePropertyLabel('In', 'bitWidth');

        // Wire address input
        await builder.placeLabeled('In', 3, 6, 'ADDR');
        await builder.setComponentProperty('ADDR', bitsLabel, entry.addrBits);
        await builder.drawWire('ADDR', 'out', 'DUT', addrPin);

        // Wire data output
        await builder.placeLabeled('Out', 18, 8, 'DOUT');
        await builder.setComponentProperty('DOUT', bitsLabel, entry.dataBits);
        await builder.drawWire('DUT', dataPin, 'DOUT', 'in');

        await builder.stepViaUI();
        await builder.verifyNoErrors();
      });
    }

    // -----------------------------------------------------------------------
    // BitExtender: inputBits → outputBits
    // -----------------------------------------------------------------------

    for (const entry of EXTENDER_MATRIX) {
      test(`BitExtender ${entry.inputBits}→${entry.outputBits}: set properties and compile`, async () => {
        await builder.placeLabeled('BitExtender', 10, 8, 'DUT');
        const inBitsLabel  = await builder.resolvePropertyLabel('BitExtender', 'inputBits');
        const outBitsLabel = await builder.resolvePropertyLabel('BitExtender', 'outputBits');
        await builder.setComponentProperty('DUT', inBitsLabel, entry.inputBits);
        await builder.setComponentProperty('DUT', outBitsLabel, entry.outputBits);

        const bitsLabel = await builder.resolvePropertyLabel('In', 'bitWidth');

        await builder.placeLabeled('In', 3, 8, 'SRC');
        await builder.setComponentProperty('SRC', bitsLabel, entry.inputBits);
        await builder.drawWire('SRC', 'out', 'DUT', 'in');

        await builder.placeLabeled('Out', 18, 8, 'DST');
        await builder.setComponentProperty('DST', bitsLabel, entry.outputBits);
        await builder.drawWire('DUT', 'out', 'DST', 'in');

        await builder.stepViaUI();
        await builder.verifyNoErrors();
      });
    }

    // -----------------------------------------------------------------------
    // Splitter: splitting pattern variations
    // -----------------------------------------------------------------------

    for (const entry of SPLITTER_MATRIX) {
      test(`Splitter ${entry.inputSplitting}→${entry.outputSplitting}: set properties and compile`, async () => {
        await builder.placeLabeled('Splitter', 10, 8, 'DUT');
        const inSplitLabel  = await builder.resolvePropertyLabel('Splitter', 'input splitting');
        const outSplitLabel = await builder.resolvePropertyLabel('Splitter', 'output splitting');
        await builder.setComponentProperty('DUT', inSplitLabel, entry.inputSplitting);
        await builder.setComponentProperty('DUT', outSplitLabel, entry.outputSplitting);

        await builder.stepViaUI();
        await builder.verifyNoErrors();
      });
    }

    // -----------------------------------------------------------------------
    // Tunnel: width variations
    // -----------------------------------------------------------------------

    for (const width of TUNNEL_WIDTHS) {
      test(`Tunnel at bitWidth=${width}: set property and compile`, async () => {
        // Resolve property labels from registry once (shared by T1 and T2)
        const bitsLabel = await builder.resolvePropertyLabel('Tunnel', 'bitWidth');
        const netLabel  = await builder.resolvePropertyLabel('Tunnel', 'NetName');

        // Place two tunnels with same net name for invisible wire
        await builder.placeLabeled('Tunnel', 5, 8, 'T1');
        await builder.setComponentProperty('T1', bitsLabel, width);
        await builder.setComponentProperty('T1', netLabel, 'net_a');

        await builder.placeLabeled('Tunnel', 15, 8, 'T2');
        await builder.setComponentProperty('T2', bitsLabel, width);
        await builder.setComponentProperty('T2', netLabel, 'net_a');

        // Wire In → T1, T2 → Out
        const inOutBitsLabel = await builder.resolvePropertyLabel('In', 'bitWidth');
        await builder.placeLabeled('In', 1, 8, 'SRC');
        await builder.setComponentProperty('SRC', inOutBitsLabel, width);
        await builder.drawWire('SRC', 'out', 'T1', 'in');

        await builder.placeLabeled('Out', 20, 8, 'DST');
        await builder.setComponentProperty('DST', inOutBitsLabel, width);
        await builder.drawWire('T2', 'in', 'DST', 'in');

        await builder.stepViaUI();
        await builder.verifyNoErrors();
      });
    }
  });

  // =========================================================================
  // 5C — Per-Component Engine Mode Sweep
  //
  // For every component with dual-engine support, test in each available
  // engine context. Place the component, optionally set simulation mode,
  // compile, and verify no errors.
  // =========================================================================

  test.describe('5C — Per-Component Engine Mode Sweep', () => {

    for (const entry of DUAL_ENGINE_TYPES) {
      for (const mode of entry.modes) {
        test(`${entry.type} works in ${mode} mode`, async () => {
          // Place the component
          await builder.placeLabeled(entry.type, 10, 8, 'DUT');

          // For gates/flip-flops in analog mode, set simulation model via the
          // property panel row labelled "Mode" (added dynamically by
          // showSimulationModeDropdown; internal key is 'simulationModel').
          const analogModeTypes = ['And', 'Or', 'Not', 'NAnd', 'NOr', 'XOr', 'XNOr',
                                   'D_FF', 'JK_FF', 'RS_FF', 'T_FF'];
          if (mode === 'analog' && analogModeTypes.includes(entry.type)) {
            await builder.setComponentProperty('DUT', 'Mode', 'analog');
          }

          // Verify placement succeeded
          const info = await builder.getCircuitInfo();
          const dut = info.elements.find(e => e.label === 'DUT');
          expect(dut, `Component ${entry.type} not found after placement`).toBeTruthy();
          expect(dut!.typeId).toBe(entry.type);

          // Compile and step — may produce unconnected-input warnings but
          // should not crash or produce type errors
          await builder.stepViaUI();
        });
      }
    }
  });
});
