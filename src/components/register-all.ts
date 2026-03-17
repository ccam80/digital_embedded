/**
 * Register all built-in component definitions into a ComponentRegistry.
 *
 * This is the single entry point for populating the registry at app startup.
 * Import order determines type-ID assignment order (stable within a session).
 */

import { ComponentRegistry } from "@/core/registry";

// Gates
import { AndDefinition } from "./gates/and.js";
import { OrDefinition } from "./gates/or.js";
import { NotDefinition } from "./gates/not.js";
import { NAndDefinition } from "./gates/nand.js";
import { NOrDefinition } from "./gates/nor.js";
import { XOrDefinition } from "./gates/xor.js";
import { XNOrDefinition } from "./gates/xnor.js";

// I/O
import { InDefinition } from "./io/in.js";
import { OutDefinition } from "./io/out.js";
import { ClockDefinition } from "./io/clock.js";
import { ConstDefinition } from "./io/const.js";
import { GroundDefinition } from "./io/ground.js";
import { VddDefinition } from "./io/vdd.js";
import { NotConnectedDefinition } from "./io/not-connected.js";
import { LedDefinition } from "./io/led.js";
import { PolarityLedDefinition } from "./io/polarity-led.js";
import { LightBulbDefinition } from "./io/light-bulb.js";
import { RgbLedDefinition } from "./io/rgb-led.js";
import { ButtonDefinition } from "./io/button.js";
import { ButtonLEDDefinition } from "./io/button-led.js";
import { DipSwitchDefinition } from "./io/dip-switch.js";
import { ProbeDefinition } from "./io/probe.js";
import { ScopeDefinition } from "./io/scope.js";
import { ScopeTriggerDefinition } from "./io/scope-trigger.js";
import { SevenSegDefinition } from "./io/seven-seg.js";
import { SevenSegHexDefinition } from "./io/seven-seg-hex.js";
import { SixteenSegDefinition } from "./io/sixteen-seg.js";
import { MidiDefinition } from "./io/midi.js";
import { RotaryEncoderDefinition } from "./io/rotary-encoder.js";
import { StepperMotorBipolarDefinition, StepperMotorUnipolarDefinition } from "./io/stepper-motor.js";
import { PowerSupplyDefinition } from "./io/power-supply.js";

// Flip-flops
import { DDefinition } from "./flipflops/d.js";
import { DAsyncDefinition } from "./flipflops/d-async.js";
import { JKDefinition } from "./flipflops/jk.js";
import { JKAsyncDefinition } from "./flipflops/jk-async.js";
import { RSDefinition } from "./flipflops/rs.js";
import { RSAsyncDefinition } from "./flipflops/rs-async.js";
import { TDefinition } from "./flipflops/t.js";
import { MonoflopDefinition } from "./flipflops/monoflop.js";

// Memory
import { CounterDefinition } from "./memory/counter.js";
import { CounterPresetDefinition } from "./memory/counter-preset.js";
import { RegisterDefinition } from "./memory/register.js";
import { RegisterFileDefinition } from "./memory/register-file.js";
import { ROMDefinition, ROMDualPortDefinition } from "./memory/rom.js";
import { EEPROMDefinition, EEPROMDualPortDefinition } from "./memory/eeprom.js";
import { LookUpTableDefinition } from "./memory/lookup-table.js";
import { ProgramCounterDefinition } from "./memory/program-counter.js";
import { ProgramMemoryDefinition } from "./memory/program-memory.js";
import {
  RAMSinglePortDefinition,
  RAMSinglePortSelDefinition,
  RAMDualPortDefinition,
  RAMDualAccessDefinition,
  RAMAsyncDefinition,
  BlockRAMDualPortDefinition,
} from "./memory/ram.js";

// Arithmetic
import { AddDefinition } from "./arithmetic/add.js";
import { SubDefinition } from "./arithmetic/sub.js";
import { MulDefinition } from "./arithmetic/mul.js";
import { DivDefinition } from "./arithmetic/div.js";
import { ComparatorDefinition } from "./arithmetic/comparator.js";
import { NegDefinition } from "./arithmetic/neg.js";
import { BitExtenderDefinition } from "./arithmetic/bit-extender.js";
import { BarrelShifterDefinition } from "./arithmetic/barrel-shifter.js";
import { BitCountDefinition } from "./arithmetic/bit-count.js";
import { PRNGDefinition } from "./arithmetic/prng.js";

// Wiring
import { MuxDefinition } from "./wiring/mux.js";
import { DemuxDefinition } from "./wiring/demux.js";
import { DecoderDefinition } from "./wiring/decoder.js";
import { BitSelectorDefinition } from "./wiring/bit-selector.js";
import { PriorityEncoderDefinition } from "./wiring/priority-encoder.js";
import { SplitterDefinition } from "./wiring/splitter.js";
import { BusSplitterDefinition } from "./wiring/bus-splitter.js";
import { DriverDefinition } from "./wiring/driver.js";
import { DriverInvSelDefinition } from "./wiring/driver-inv.js";
import { DelayDefinition } from "./wiring/delay.js";
import { StopDefinition } from "./wiring/stop.js";
import { BreakDefinition } from "./wiring/break.js";
import { AsyncSeqDefinition } from "./wiring/async-seq.js";
import { TunnelDefinition } from "./wiring/tunnel.js";
import { ResetDefinition } from "./wiring/reset.js";

// Switching
import { RelayDefinition } from "./switching/relay.js";
import { RelayDTDefinition } from "./switching/relay-dt.js";
import { NFETDefinition } from "./switching/nfet.js";
import { PFETDefinition } from "./switching/pfet.js";
import { FGNFETDefinition } from "./switching/fgnfet.js";
import { FGPFETDefinition } from "./switching/fgpfet.js";
import { TransGateDefinition } from "./switching/trans-gate.js";
import { FuseDefinition } from "./switching/fuse.js";
import { SwitchDefinition } from "./switching/switch.js";
import { SwitchDTDefinition } from "./switching/switch-dt.js";
import { PlainSwitchDefinition } from "./switching/plain-switch.js";
import { PlainSwitchDTDefinition } from "./switching/plain-switch-dt.js";

// PLD
import { DiodeDefinition, DiodeForwardDefinition, DiodeBackwardDefinition } from "./pld/diode.js";
import { PullUpDefinition } from "./pld/pull-up.js";
import { PullDownDefinition } from "./pld/pull-down.js";

// Misc
import { TextDefinition } from "./misc/text.js";
import { RectangleDefinition } from "./misc/rectangle.js";
import { TestcaseDefinition } from "./misc/testcase.js";

// Graphics
import { LedMatrixDefinition } from "./graphics/led-matrix.js";
import { VGADefinition } from "./graphics/vga.js";
import { GraphicCardDefinition } from "./graphics/graphic-card.js";

// Terminal
import { TerminalDefinition } from "./terminal/terminal.js";
import { KeyboardDefinition } from "./terminal/keyboard.js";

// Analog passives
import { ResistorDefinition } from "./passives/resistor.js";

// Analog sources
import { AnalogGroundDefinition } from "./sources/ground.js";

// Basic
import { BooleanFunctionDefinition } from "./basic/function.js";

// 74xx library
import { register74xxLibrary } from "./library-74xx.js";

/**
 * Create a ComponentRegistry populated with every built-in component type.
 *
 * @param pinMap74xx - Optional pre-scanned pin declarations for 74xx ICs.
 *   When provided, 74xx stub entries include real pin metadata so that
 *   `describeComponent()` returns pins without loading the full subcircuit.
 *   Use `scan74xxPinMap()` from `io/dig-pin-scanner.ts` to build this.
 */
export function createDefaultRegistry(
  pinMap74xx?: ReadonlyMap<string, import('../core/pin.js').PinDeclaration[]>,
): ComponentRegistry {
  const registry = new ComponentRegistry();

  // Gates
  registry.register(AndDefinition);
  registry.register(OrDefinition);
  registry.register(NotDefinition);
  registry.register(NAndDefinition);
  registry.register(NOrDefinition);
  registry.register(XOrDefinition);
  registry.register(XNOrDefinition);

  // I/O
  registry.register(InDefinition);
  registry.register(OutDefinition);
  registry.register(ClockDefinition);
  registry.register(ConstDefinition);
  registry.register(GroundDefinition);
  registry.register(VddDefinition);
  registry.register(NotConnectedDefinition);
  registry.register(LedDefinition);
  registry.register(PolarityLedDefinition);
  registry.register(LightBulbDefinition);
  registry.register(RgbLedDefinition);
  registry.register(ButtonDefinition);
  registry.register(ButtonLEDDefinition);
  registry.register(DipSwitchDefinition);
  registry.register(ProbeDefinition);
  registry.register(ScopeDefinition);
  registry.register(ScopeTriggerDefinition);
  registry.register(SevenSegDefinition);
  registry.register(SevenSegHexDefinition);
  registry.register(SixteenSegDefinition);
  registry.register(MidiDefinition);
  registry.register(RotaryEncoderDefinition);
  registry.register(StepperMotorBipolarDefinition);
  registry.register(StepperMotorUnipolarDefinition);
  registry.register(PowerSupplyDefinition);

  // Flip-flops
  registry.register(DDefinition);
  registry.register(DAsyncDefinition);
  registry.register(JKDefinition);
  registry.register(JKAsyncDefinition);
  registry.register(RSDefinition);
  registry.register(RSAsyncDefinition);
  registry.register(TDefinition);
  registry.register(MonoflopDefinition);

  // Memory
  registry.register(CounterDefinition);
  registry.register(CounterPresetDefinition);
  registry.register(RegisterDefinition);
  registry.register(RegisterFileDefinition);
  registry.register(ROMDefinition);
  registry.register(ROMDualPortDefinition);
  registry.register(EEPROMDefinition);
  registry.register(EEPROMDualPortDefinition);
  registry.register(LookUpTableDefinition);
  registry.register(ProgramCounterDefinition);
  registry.register(ProgramMemoryDefinition);
  registry.register(RAMSinglePortDefinition);
  registry.register(RAMSinglePortSelDefinition);
  registry.register(RAMDualPortDefinition);
  registry.register(RAMDualAccessDefinition);
  registry.register(RAMAsyncDefinition);
  registry.register(BlockRAMDualPortDefinition);

  // Arithmetic
  registry.register(AddDefinition);
  registry.register(SubDefinition);
  registry.register(MulDefinition);
  registry.register(DivDefinition);
  registry.register(ComparatorDefinition);
  registry.register(NegDefinition);
  registry.register(BitExtenderDefinition);
  registry.register(BarrelShifterDefinition);
  registry.register(BitCountDefinition);
  registry.register(PRNGDefinition);

  // Wiring
  registry.register(MuxDefinition);
  registry.register(DemuxDefinition);
  registry.register(DecoderDefinition);
  registry.register(BitSelectorDefinition);
  registry.register(PriorityEncoderDefinition);
  registry.register(SplitterDefinition);
  registry.register(BusSplitterDefinition);
  registry.register(DriverDefinition);
  registry.register(DriverInvSelDefinition);
  registry.register(DelayDefinition);
  registry.register(StopDefinition);
  registry.register(BreakDefinition);
  registry.register(AsyncSeqDefinition);
  registry.register(TunnelDefinition);
  registry.register(ResetDefinition);

  // Switching
  registry.register(RelayDefinition);
  registry.register(RelayDTDefinition);
  registry.register(NFETDefinition);
  registry.register(PFETDefinition);
  registry.register(FGNFETDefinition);
  registry.register(FGPFETDefinition);
  registry.register(TransGateDefinition);
  registry.register(FuseDefinition);
  registry.register(SwitchDefinition);
  registry.register(SwitchDTDefinition);
  registry.register(PlainSwitchDefinition);
  registry.register(PlainSwitchDTDefinition);

  // PLD
  registry.register(DiodeDefinition);
  registry.register(DiodeForwardDefinition);
  registry.register(DiodeBackwardDefinition);
  registry.register(PullUpDefinition);
  registry.register(PullDownDefinition);

  // Misc
  registry.register(TextDefinition);
  registry.register(RectangleDefinition);
  registry.register(TestcaseDefinition);

  // Graphics
  registry.register(LedMatrixDefinition);
  registry.register(VGADefinition);
  registry.register(GraphicCardDefinition);

  // Terminal
  registry.register(TerminalDefinition);
  registry.register(KeyboardDefinition);

  // Analog passives
  registry.register(ResistorDefinition);

  // Analog sources
  registry.register(AnalogGroundDefinition);

  // Basic
  registry.register(BooleanFunctionDefinition);

  // 74xx ICs
  register74xxLibrary(registry, pinMap74xx);

  return registry;
}
