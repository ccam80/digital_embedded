/**
 * ADCDriverElement- internal-only behavioral driver leaf for the N-bit ADC
 * composite. Reads one analog input (VIN), a clock (CLK), and a reference
 * voltage (VREF) relative to GND; runs an SAR or instant-conversion FSM
 * advanced by rising CLK edges.
 *
 * Per Composite (phase-composite-architecture.md), J-018
 * (contracts_group_01.md). Canonical shape: Template A-multi-bit-schema
 * (counter-driver.ts). No MNA stamps- pure behavioral slot writer.
 *
 * Modes (selected by parent via `sar` and `bipolar` model params):
 *   - sar=1 (default): true successive-approximation. Each rising CLK edge
 *     advances the FSM. Total cycles per conversion: 1 (idle->sample) + 1
 *     (sample->convert init) + N (per-bit decisions) + 1 (ready->idle) = N+3.
 *   - sar=0: instant conversion. Each rising CLK edge produces a full code
 *     in a single load() step.
 *   - bipolar=1: offset-binary encoding. vIn in [-vRef, +vRef] maps to
 *     code in [0, 2^N - 1] with vIn=0 -> code = 2^(N-1).
 *   - bipolar=0: unipolar. vIn in [0, vRef] maps to [0, 2^N - 1].
 *
 * FSM phases: 0=idle / 1=sample / 2=convert / 3=ready.
 * SAR_BITS is a single packed integer slot holding the in-progress SAR
 * register during the convert phase (Component ss3.1 packed-bitmask
 * convention). OUTPUT_CODE is the latched final code.
 *
 * Variable-arity schema is realised via a module-scope memoised factory
 * (getAdcSchema(bits)), following the counter-driver.ts pattern exactly.
 * stateSchema and stateSize are per-instance fields.
 */

import {
  defineStateSchema,
  type StateSchema,
  type SlotDescriptor,
} from "../../solver/analog/state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { allocNortonStamp, stampNortonValue } from "../../solver/analog/stamp-helpers.js";
import type { ComponentDefinition } from "../../core/registry.js";
import type { PropertyBag } from "../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { detectRisingEdge } from "../../solver/analog/behavioral-drivers/edge-detect.js";

// ---------------------------------------------------------------------------
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//
// Slot layout for bits N:
//   [0]          PREV_CLK             (NaN-init sentinel for first-sample)
//   [1]          FSM_PHASE            (0=idle/1=sample/2=convert/3=ready)
//   [2]          SAR_BITS             (packed bitmask, internal SAR register)
//   [3]          SAR_BIT_INDEX        (current bit-under-test in convert phase)
//   [4]          OUTPUT_CODE          (latched final code, packed integer)
//   [5]          EOC_LATCH            (end-of-conversion, 0 or 1; held across NR
//                                       iterations and timesteps until the FSM
//                                       updates it)

const ADC_SCHEMAS = new Map<number, StateSchema>();

function getAdcSchema(bits: number): StateSchema {
  let cached = ADC_SCHEMAS.get(bits);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [
    {
      name: "PREV_CLK",
      doc: "Clock voltage at last accepted timestep- NaN sentinel on first sample prevents spurious rising-edge on a circuit that boots with CLK already high.",
    },
    {
      name: "FSM_PHASE",
      doc: "SAR FSM phase: 0=idle, 1=sample, 2=convert, 3=ready. Advances on rising CLK edge.",
    },
    {
      name: "SAR_BITS",
      doc: "Packed SAR register (single integer, Component ss3.1). During convert phase, contains decided bits plus the trial bit at SAR_BIT_INDEX. At end of convert, equals OUTPUT_CODE.",
    },
    {
      name: "SAR_BIT_INDEX",
      doc: "Current bit being tested during SAR convert phase. Initialised to N-1 on entry, decremented each cycle. Negative when not converting.",
    },
    {
      name: "OUTPUT_CODE",
      doc: "Latched final conversion code. Written when FSM transitions to ready; held until the next conversion completes.",
    },
    {
      name: "EOC_LATCH",
      doc: "End-of-conversion handshake (0 or 1). In SAR mode, asserts 1 when phase transitions 2→3 (LSB decided), held through phase 3, clears to 0 on phase 3→0. In instant mode, asserts 1 on rising CLK edge, clears when CLK falls below vIL. Held between branches that don't update it.",
    },
  ];
  const schema = defineStateSchema(`ADCDriver_${bits}b`, slots);
  ADC_SCHEMAS.set(bits, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout factory- inputs VIN, CLK, VREF, GND plus ctrl_d_0..ctrl_d_{N-1}.
// Order MUST match the parent's buildAdcNetlist connectivity row for drv.
// ---------------------------------------------------------------------------

function buildAdcDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const bits = props.getOrDefault<number>("bits", 8);
  const pins: PinDeclaration[] = [
    { direction: PinDirection.INPUT, label: "VIN",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "CLK",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
    { direction: PinDirection.INPUT, label: "VREF", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "GND",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "ctrl_eoc", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
  for (let i = 0; i < bits; i++) {
    pins.push({
      direction: PinDirection.OUTPUT,
      label: `ctrl_d_${i}`,
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    });
  }
  return pins;
}

// ---------------------------------------------------------------------------
// ADCDriverElement
// ---------------------------------------------------------------------------

export class ADCDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  // Per-instance schema- one per distinct bits value (memoised module-scope).
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _bits: number;
  private readonly _maxCode: number;
  private readonly _bipolar: boolean;
  private readonly _sar: boolean;
  // Slot indices cached at construction so load() avoids repeated Map lookups.
  private readonly _slotPrevClk:     number;
  private readonly _slotFsmPhase:    number;
  private readonly _slotSarBits:     number;
  private readonly _slotSarBitIndex: number;
  private readonly _slotOutputCode:  number;
  private readonly _slotOutputEoc:   number;
  private readonly _vinNode:  number;
  private readonly _clkNode:  number;
  private readonly _vrefNode: number;
  private readonly _gndNode:  number;
  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;
  private _firstSample: boolean = true;
  private _ctrlNodes: number[] = [];
  private _ctrlEocNode: number = -1;
  private _handlesByBit: Array<readonly [number, number, number, number]> = [];
  private _handleEoc: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._bits    = props.getModelParam<number>("bits");
    this._maxCode = this._bits >= 32 ? 0xFFFFFFFF : ((1 << this._bits) - 1);
    this._bipolar = props.getModelParam<number>("bipolar") !== 0;
    this._sar     = props.getModelParam<number>("sar")     !== 0;

    this.stateSchema = getAdcSchema(this._bits);
    this.stateSize   = this.stateSchema.size;

    this._slotPrevClk     = this.stateSchema.indexOf.get("PREV_CLK")!;
    this._slotFsmPhase    = this.stateSchema.indexOf.get("FSM_PHASE")!;
    this._slotSarBits     = this.stateSchema.indexOf.get("SAR_BITS")!;
    this._slotSarBitIndex = this.stateSchema.indexOf.get("SAR_BIT_INDEX")!;
    this._slotOutputCode  = this.stateSchema.indexOf.get("OUTPUT_CODE")!;
    this._slotOutputEoc   = this.stateSchema.indexOf.get("EOC_LATCH")!;

    this._vinNode  = pinNodes.get("VIN")!;
    this._clkNode  = pinNodes.get("CLK")!;
    this._vrefNode = pinNodes.get("VREF")!;
    this._gndNode  = pinNodes.get("GND")!;
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH = props.getModelParam<number>("vOH");
    this._vOL = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._ctrlNodes = [];
    this._handlesByBit = [];
    for (let i = 0; i < this._bits; i++) {
      const ctrlNode = this.pinNodes.get(`ctrl_d_${i}`)!;
      this._ctrlNodes.push(ctrlNode);
      this._handlesByBit.push(allocNortonStamp(ctx.solver, ctrlNode, this._gndNode));
    }
    this._ctrlEocNode = this.pinNodes.get("ctrl_eoc")!;
    this._handleEoc   = allocNortonStamp(ctx.solver, this._ctrlEocNode, this._gndNode);
  }

  /**
   * SAR ADC FSM- advances on rising CLK edge.
   *
   * SAR mode: standard textbook successive-approximation. Phase 0 (idle) -> 1
   * (sample) -> 2 (convert, held for N edges, one bit decided per edge) -> 3
   * (ready, EOC asserted) -> 0 (next edge clears EOC). Total cycles per
   * conversion = N+3.
   *
   * Instant mode: whole code computed on the rising edge that triggers it;
   * EOC pulses from rising edge until CLK falls below vIL.
   *
   * Bipolar encoding (offset binary): vIn in [-vRef, +vRef] -> code in
   * [0, 2^N - 1] with vIn = 0 -> code = 2^(N-1). Code-to-DAC inverse used
   * during SAR trials so the comparison is symmetric.
   *
   * No MNA stamps. Reads rhsOld[VIN], rhsOld[CLK], rhsOld[VREF] relative to
   * rhsOld[GND].
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd    = rhsOld[this._gndNode];
    const vClock = rhsOld[this._clkNode] - gnd;
    const prevClock = s1[base + this._slotPrevClk];

    let fsmPhase    = s1[base + this._slotFsmPhase];
    let sarBits     = s1[base + this._slotSarBits];
    let sarBitIndex = s1[base + this._slotSarBitIndex];
    let outputCode  = s1[base + this._slotOutputCode];
    // Hold prior EOC across calls; FSM branches that change it write a new
    // value below. Without this hold, EOC would collapse to 0 every load()
    // even though the SAR FSM specifies it stays high through phase 3.
    let outputEoc   = s1[base + this._slotOutputEoc] >= 0.5 ? 1 : 0;

    const edge = !this._firstSample && detectRisingEdge(prevClock, vClock, this._vIH);
    this._firstSample = false;

    if (edge) {
      const vIn  = rhsOld[this._vinNode]  - gnd;
      const vRef = rhsOld[this._vrefNode] - gnd;

      if (this._sar) {
        // Multi-cycle SAR FSM.
        switch (fsmPhase) {
          case 0: { // idle -> sample
            fsmPhase    = 1;
            outputEoc   = 0;
            sarBits     = 0;
            sarBitIndex = -1;
            break;
          }
          case 1: { // sample -> convert; load MSB trial
            fsmPhase    = 2;
            sarBitIndex = this._bits - 1;
            sarBits     = 1 << sarBitIndex;
            break;
          }
          case 2: { // convert: decide current trial bit, advance
            // Encode the trial register as a DAC voltage and compare to vIn.
            // If the trial overshoots, clear this bit; otherwise keep it.
            const trialDacV = this._codeToDacVoltage(sarBits, vRef);
            if (trialDacV > vIn) sarBits &= ~(1 << sarBitIndex);
            sarBitIndex -= 1;
            if (sarBitIndex < 0) {
              // Last bit decided- latch and assert EOC.
              outputCode = sarBits;
              outputEoc  = 1;
              fsmPhase   = 3;
            } else {
              // Set the next trial bit for the next CLK edge.
              sarBits |= 1 << sarBitIndex;
            }
            break;
          }
          case 3: { // ready -> idle
            fsmPhase  = 0;
            outputEoc = 0;
            break;
          }
        }
      } else {
        // Instant-conversion model: full code in one step.
        outputCode  = this._instantConvert(vIn, vRef);
        sarBits     = outputCode;
        sarBitIndex = -1;
        outputEoc   = 1;
        fsmPhase    = 3;
      }
    } else if (!this._sar && vClock < this._vIL) {
      // Instant mode only: clear EOC on CLK low so it pulses rather than
      // latching high until the next sample. SAR mode keeps state across
      // edges and must not be reset mid-conversion.
      outputEoc = 0;
      fsmPhase  = 0;
    }

    // Bottom-of-load writes- every slot mutated this step writes to s0 once.
    s0[base + this._slotPrevClk]     = vClock;
    s0[base + this._slotFsmPhase]    = fsmPhase;
    s0[base + this._slotSarBits]     = sarBits;
    s0[base + this._slotSarBitIndex] = sarBitIndex;
    s0[base + this._slotOutputCode]  = outputCode;
    s0[base + this._slotOutputEoc]   = outputEoc;

    // Norton stamp at each ctrl_d_<i>: drive each bit of the output code.
    for (let i = 0; i < this._bits; i++) {
      const bit = (outputCode >> i) & 1;
      const target = bit ? this._vOH : this._vOL;
      stampNortonValue(ctx, this._handlesByBit[i]!, this._ctrlNodes[i]!, this._gndNode, this._rOut, target);
    }
    // Norton stamp at ctrl_eoc: drive EOC handshake.
    stampNortonValue(ctx, this._handleEoc, this._ctrlEocNode, this._gndNode, this._rOut, outputEoc ? this._vOH : this._vOL);
  }

  /**
   * Instant-mode encoder: vIn -> code in [0, 2^N - 1].
   * Unipolar: vIn in [0, vRef]. Bipolar (offset binary): vIn in [-vRef, +vRef].
   * vRef <= 0 collapses to code=0 (topology error caught upstream; not
   * defensive validation).
   */
  private _instantConvert(vIn: number, vRef: number): number {
    if (vRef <= 0) return 0;
    const span = this._maxCode + 1;
    let code: number;
    if (this._bipolar) {
      code = Math.floor(((vIn / vRef) + 1) * span / 2);
    } else {
      code = Math.floor((vIn / vRef) * span);
    }
    if (code < 0) return 0;
    if (code > this._maxCode) return this._maxCode;
    return code;
  }

  /**
   * SAR-mode trial encoder: code (interpretation matching _instantConvert) ->
   * DAC voltage for comparison against vIn. Inverse of _instantConvert.
   */
  private _codeToDacVoltage(code: number, vRef: number): number {
    const span = this._maxCode + 1;
    if (this._bipolar) {
      return ((code / span) * 2 - 1) * vRef;
    }
    return (code / span) * vRef;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    else if (key === "rOut") this._rOut = value;
    else if (key === "vOH") this._vOH = value;
    else if (key === "vOL") this._vOL = value;
    // bits, bipolar, sar are structural (drive schema, _maxCode, FSM shape);
    // not setParam-able.
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const ADCDriverDefinition: ComponentDefinition = {
  name: "ADCDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildAdcDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "bits",    default: 8 },
        { key: "vIH",     default: 2.0 },
        { key: "vIL",     default: 0.8 },
        { key: "bipolar", default: 0 },
        { key: "sar",     default: 1 },
        { key: "rOut",    default: 100 },
        { key: "vOH",     default: 5 },
        { key: "vOL",     default: 0 },
      ],
      params: { bits: 8, vIH: 2.0, vIL: 0.8, bipolar: 0, sar: 1, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new ADCDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
