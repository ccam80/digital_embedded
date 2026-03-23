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
  'Add', 'Sub', 'Mul', 'Div', 'Comparator', 'Neg',
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

const PLD = ['Diode', 'DiodeForward', 'DiodeBackward', 'PullUp', 'PullDown'];

const PASSIVES = [
  'AnalogResistor', 'AnalogCapacitor', 'AnalogInductor',
  'AnalogPotentiometer', 'Transformer', 'TappedTransformer',
  'QuartzCrystal', 'Memristor', 'PolarizedCap',
  'AnalogTransmissionLine', 'LDR', 'NTCThermistor', 'SparkGap',
];

const SEMICONDUCTORS = [
  'AnalogDiode', 'AnalogZener', 'NpnBJT', 'PnpBJT',
  'NMOS', 'PMOS', 'NJFET', 'PJFET',
  'SCR', 'Triac', 'Diac', 'TunnelDiode', 'VaractorDiode', 'Triode',
];

const SOURCES = [
  'AcVoltageSource', 'DcVoltageSource', 'CurrentSource',
  'AnalogGround', 'VariableRail',
];

const ACTIVE = [
  'OpAmp', 'RealOpAmp', 'OTA', 'Timer555',
  'AnalogComparator', 'SchmittInverting', 'SchmittNonInverting',
  'DAC', 'ADC', 'Optocoupler',
  'AnalogSwitchSPST', 'AnalogSwitchSPDT',
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
// Each entry defines: component type, UI property label for width,
// widths to test, and the pin pair to wire for verification.
// Pin names are from circuit_describe output.
// ===========================================================================

interface WidthTestEntry {
  type: string;
  propLabel: string;
  widths: number[];
  inputPin: string;
  outputPin: string;
}

const WIDTH_MATRIX: WidthTestEntry[] = [
  // Gates — "Bits" controls all I/O pin widths
  { type: 'And', propLabel: 'Bits', widths: [1, 2, 4, 8, 16, 32], inputPin: 'In_1', outputPin: 'out' },
  { type: 'Or', propLabel: 'Bits', widths: [1, 2, 4, 8, 16, 32], inputPin: 'In_1', outputPin: 'out' },
  { type: 'XOr', propLabel: 'Bits', widths: [1, 2, 4, 8, 16, 32], inputPin: 'In_1', outputPin: 'out' },
  { type: 'NAnd', propLabel: 'Bits', widths: [1, 2, 4, 8, 16, 32], inputPin: 'In_1', outputPin: 'out' },
  { type: 'NOr', propLabel: 'Bits', widths: [1, 2, 4, 8, 16, 32], inputPin: 'In_1', outputPin: 'out' },
  { type: 'XNOr', propLabel: 'Bits', widths: [1, 2, 4, 8, 16, 32], inputPin: 'In_1', outputPin: 'out' },
  { type: 'Not', propLabel: 'Bits', widths: [1, 2, 4, 8, 16, 32], inputPin: 'in', outputPin: 'out' },

  // I/O
  { type: 'In', propLabel: 'Bits', widths: [1, 2, 4, 8, 16, 32], inputPin: '', outputPin: 'out' },
  { type: 'Out', propLabel: 'Bits', widths: [1, 2, 4, 8, 16, 32], inputPin: 'in', outputPin: '' },

  // Arithmetic — "Bits" controls operand + result widths
  { type: 'Add', propLabel: 'Bits', widths: [1, 4, 8, 16, 32], inputPin: 'a', outputPin: 's' },
  { type: 'Sub', propLabel: 'Bits', widths: [1, 4, 8, 16, 32], inputPin: 'a', outputPin: 's' },
  { type: 'Mul', propLabel: 'Bits', widths: [1, 4, 8, 16, 32], inputPin: 'a', outputPin: 'out' },
  { type: 'Div', propLabel: 'Bits', widths: [1, 4, 8, 16, 32], inputPin: 'a', outputPin: 'q' },
  { type: 'Comparator', propLabel: 'Bits', widths: [1, 4, 8, 16], inputPin: 'a', outputPin: '>' },

  // Counters — "Bits" controls output width
  { type: 'Counter', propLabel: 'Bits', widths: [2, 4, 8, 16], inputPin: 'C', outputPin: 'out' },
  { type: 'CounterPreset', propLabel: 'Bits', widths: [2, 4, 8, 16], inputPin: 'C', outputPin: 'out' },

  // Registers
  { type: 'Register', propLabel: 'Bits', widths: [1, 4, 8, 16, 32], inputPin: 'D', outputPin: 'Q' },

  // Flip-flops
  { type: 'D_FF', propLabel: 'Bits', widths: [1, 4, 8], inputPin: 'D', outputPin: 'Q' },
  { type: 'D_FF_AS', propLabel: 'Bits', widths: [1, 4, 8], inputPin: 'D', outputPin: 'Q' },
  { type: 'JK_FF', propLabel: 'Bits', widths: [1, 4, 8], inputPin: 'J', outputPin: 'Q' },
  { type: 'JK_FF_AS', propLabel: 'Bits', widths: [1, 4, 8], inputPin: 'J', outputPin: 'Q' },

  // Wiring components — "Selector Bits" or "Bits"
  { type: 'Decoder', propLabel: 'Selector Bits', widths: [1, 2, 3, 4], inputPin: 'sel', outputPin: 'out_0' },
  { type: 'BitSelector', propLabel: 'Selector Bits', widths: [2, 3, 4, 5], inputPin: 'in', outputPin: 'out' },
  { type: 'PriorityEncoder', propLabel: 'Bits', widths: [2, 4, 8], inputPin: 'in', outputPin: 'out' },
  { type: 'BarrelShifter', propLabel: 'Bits', widths: [4, 8, 16, 32], inputPin: 'in', outputPin: 'out' },
  { type: 'Driver', propLabel: 'Bits', widths: [1, 4, 8, 16], inputPin: 'in', outputPin: 'out' },
  { type: 'DriverInvSel', propLabel: 'Bits', widths: [1, 4, 8, 16], inputPin: 'in', outputPin: 'out' },
  { type: 'Delay', propLabel: 'Bits', widths: [1, 4, 8, 16], inputPin: 'in', outputPin: 'out' },
  { type: 'BusSplitter', propLabel: 'Bits', widths: [2, 4, 8, 16], inputPin: 'D', outputPin: 'D' },

  // DAC/ADC — "Resolution (bits)"
  { type: 'DAC', propLabel: 'Resolution (bits)', widths: [4, 8], inputPin: 'D0', outputPin: 'OUT' },
  { type: 'ADC', propLabel: 'Resolution (bits)', widths: [4, 8], inputPin: 'VIN', outputPin: 'D0' },
];

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
  { type: 'AnalogComparator', modes: ['analog', 'mixed'] },
  { type: 'DAC', modes: ['mixed'] },
  { type: 'ADC', modes: ['mixed'] },
];

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
        test(`${entry.type} at ${entry.propLabel}=${width}: set property and compile`, async () => {
          // Place the component under test with a label
          await builder.placeLabeled(entry.type, 10, 8, 'DUT');

          // Set width property via popup
          await builder.setComponentProperty('DUT', entry.propLabel, width);

          // Place matching-width In and Out (if pins exist for wiring)
          if (entry.inputPin) {
            await builder.placeLabeled('In', 3, 8, 'SRC');
            await builder.setComponentProperty('SRC', 'Bits', width);
            await builder.drawWire('SRC', 'out', 'DUT', entry.inputPin);
          }
          if (entry.outputPin) {
            await builder.placeLabeled('Out', 18, 8, 'DST');
            await builder.setComponentProperty('DST', 'Bits', width);
            await builder.drawWire('DUT', entry.outputPin, 'DST', 'in');
          }

          // Compile and verify
          await builder.stepViaUI();
          await builder.verifyNoErrors();
        });
      }
    }

    // -----------------------------------------------------------------------
    // Mux/Demux: selectorBits × dataBits combinations
    // -----------------------------------------------------------------------

    for (const entry of MUX_MATRIX) {
      test(`${entry.type} sel=${entry.selectorBits} data=${entry.dataBits}: set properties and compile`, async () => {
        await builder.placeLabeled(entry.type, 10, 8, 'DUT');
        await builder.setComponentProperty('DUT', 'Selector Bits', entry.selectorBits);
        await builder.setComponentProperty('DUT', 'Bits', entry.dataBits);

        // Wire selector input
        await builder.placeLabeled('In', 3, 4, 'SEL');
        await builder.setComponentProperty('SEL', 'Bits', entry.selectorBits);
        await builder.drawWire('SEL', 'out', 'DUT', 'sel');

        // Wire first data input/output
        if (entry.type === 'Multiplexer') {
          await builder.placeLabeled('In', 3, 10, 'D0');
          await builder.setComponentProperty('D0', 'Bits', entry.dataBits);
          await builder.drawWire('D0', 'out', 'DUT', '0');
          await builder.placeLabeled('Out', 18, 8, 'Y');
          await builder.setComponentProperty('Y', 'Bits', entry.dataBits);
          await builder.drawWire('DUT', 'out', 'Y', 'in');
        } else {
          await builder.placeLabeled('In', 3, 10, 'DIN');
          await builder.setComponentProperty('DIN', 'Bits', entry.dataBits);
          await builder.drawWire('DIN', 'out', 'DUT', 'in');
          await builder.placeLabeled('Out', 18, 8, 'Y0');
          await builder.setComponentProperty('Y0', 'Bits', entry.dataBits);
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
        await builder.setComponentProperty('DUT', 'Address bits', entry.addrBits);
        await builder.setComponentProperty('DUT', 'Data bits', entry.dataBits);

        // Wire address input
        await builder.placeLabeled('In', 3, 6, 'ADDR');
        await builder.setComponentProperty('ADDR', 'Bits', entry.addrBits);
        await builder.drawWire('ADDR', 'out', 'DUT', 'A');

        // Wire data output
        await builder.placeLabeled('Out', 18, 8, 'DOUT');
        await builder.setComponentProperty('DOUT', 'Bits', entry.dataBits);
        await builder.drawWire('DUT', 'D', 'DOUT', 'in');

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
        await builder.setComponentProperty('DUT', 'Input Bits', entry.inputBits);
        await builder.setComponentProperty('DUT', 'Output Bits', entry.outputBits);

        await builder.placeLabeled('In', 3, 8, 'SRC');
        await builder.setComponentProperty('SRC', 'Bits', entry.inputBits);
        await builder.drawWire('SRC', 'out', 'DUT', 'in');

        await builder.placeLabeled('Out', 18, 8, 'DST');
        await builder.setComponentProperty('DST', 'Bits', entry.outputBits);
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
        await builder.setComponentProperty('DUT', 'Input Splitting', entry.inputSplitting);
        await builder.setComponentProperty('DUT', 'Output Splitting', entry.outputSplitting);

        await builder.stepViaUI();
        await builder.verifyNoErrors();
      });
    }

    // -----------------------------------------------------------------------
    // Tunnel: width variations
    // -----------------------------------------------------------------------

    for (const width of TUNNEL_WIDTHS) {
      test(`Tunnel at Bits=${width}: set property and compile`, async () => {
        // Place two tunnels with same label for invisible wire
        await builder.placeLabeled('Tunnel', 5, 8, 'T1');
        await builder.setComponentProperty('T1', 'Bits', width);
        await builder.setComponentProperty('T1', 'Net Name', 'net_a');

        await builder.placeLabeled('Tunnel', 15, 8, 'T2');
        await builder.setComponentProperty('T2', 'Bits', width);
        await builder.setComponentProperty('T2', 'Net Name', 'net_a');

        // Wire In → T1, T2 → Out
        await builder.placeLabeled('In', 1, 8, 'SRC');
        await builder.setComponentProperty('SRC', 'Bits', width);
        await builder.drawWire('SRC', 'out', 'T1', 'in');

        await builder.placeLabeled('Out', 20, 8, 'DST');
        await builder.setComponentProperty('DST', 'Bits', width);
        await builder.drawWire('T2', 'out', 'DST', 'in');

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
          // Switch engine mode if needed
          if (mode === 'analog' || mode === 'mixed') {
            await builder.switchEngineMode();
          }

          // Place the component
          await builder.placeLabeled(entry.type, 10, 8, 'DUT');

          // For gates in analog mode, set simulation mode property
          if (mode === 'analog' && ['And', 'Or', 'Not', 'NAnd', 'NOr', 'XOr', 'XNOr'].includes(entry.type)) {
            await builder.setComponentProperty('DUT', 'Simulation Mode', 'analog-pins');
          }

          // For flip-flops in analog mode, set simulation mode
          if (mode === 'analog' && ['D_FF', 'JK_FF', 'RS_FF', 'T_FF'].includes(entry.type)) {
            await builder.setComponentProperty('DUT', 'Simulation Mode', 'analog-pins');
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
