/**
 * FGPFET — P-channel floating-gate MOSFET.
 *
 * Behaves like PFET (G=0 → conducting) except when the floating gate is
 * "programmed" (blown=true). A programmed FGPFET is permanently non-conducting
 * regardless of gate input.
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: S (source), D (drain)
 *
 * internalStateCount: 2 (closedFlag=0, blownFlag=1)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AnalogFactory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { FETLayout } from "./nfet.js";
import type { AnalogElementCore } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { fetlim, limvds, pnjlim } from "../../solver/analog/newton-raphson.js";
import {
  MODEINITFLOAT, MODEINITJCT, MODEINITFIX, MODEINITSMSIG,
  MODEINITTRAN, MODEINITPRED, MODETRAN, MODEAC, MODETRANOP,
  MODEDC, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";

// ---------------------------------------------------------------------------
// Physical constants (ngspice const.h / defines.h)
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability (CKTgmin default). */
const FGPFET_GMIN = 1e-12;
/** Maximum safe exponential argument (defines.h MAX_EXP_ARG). */
const FGPFET_MAX_EXP_ARG = 709.0;
/** Boltzmann constant / elementary charge (CONSTKoverQ). */
const FGPFET_KoverQ = 1.3806226e-23 / 1.6021918e-19;
/** Reference temperature (REFTEMP). */
const FGPFET_REFTEMP = 300.15;
/** Default floating-gate coupling capacitance (F). Used by FGPFETCapSubElement. */
const FGPFET_CAP_DEFAULT = 1e-15;
/** Default MOS1 VTO magnitude for PFET (V). ngspice MOS1type=-1 applies sign at load time. */
const FGPFET_VTO = 1.0;
/** Default MOS1 KP for PFET (A/V²). */
const FGPFET_KP = 2e-5;
/** Default MOS1 PHI (V). */
const FGPFET_PHI = 0.6;
/** Default MOS1 W (m). */
const FGPFET_W = 1e-4;
/** Default MOS1 L (m). */
const FGPFET_L = 1e-4;
/** Default MOS1 IS (A). */
const FGPFET_IS = 1e-14;

// ---------------------------------------------------------------------------
// MOS1 state slot indices — matches mos1defs.h:269-291 MOS1numStates=17
// plus 11 DC-OP scalars (total 28 slots).
// Slot order mirrors src/components/semiconductors/mosfet.ts exactly.
// ---------------------------------------------------------------------------

const MOS_SLOT_VBD   =  0;
const MOS_SLOT_VBS   =  1;
const MOS_SLOT_VGS   =  2;
const MOS_SLOT_VDS   =  3;
const MOS_SLOT_CAPGS =  4;
const MOS_SLOT_QGS   =  5;
const MOS_SLOT_CQGS  =  6;
const MOS_SLOT_CAPGD =  7;
const MOS_SLOT_QGD   =  8;
const MOS_SLOT_CQGD  =  9;
const MOS_SLOT_CAPGB = 10;
const MOS_SLOT_QGB   = 11;
const MOS_SLOT_CQGB  = 12;
const MOS_SLOT_QBD   = 13;
const MOS_SLOT_CQBD  = 14;
const MOS_SLOT_QBS   = 15;
const MOS_SLOT_CQBS  = 16;
const MOS_SLOT_CD    = 17;
const MOS_SLOT_CBD   = 18;
const MOS_SLOT_CBS   = 19;
const MOS_SLOT_GBD   = 20;
const MOS_SLOT_GBS   = 21;
const MOS_SLOT_GM    = 22;
const MOS_SLOT_GDS   = 23;
const MOS_SLOT_GMBS  = 24;
const MOS_SLOT_MODE  = 25;
const MOS_SLOT_VON   = 26;
const MOS_SLOT_VDSAT = 27;

// ---------------------------------------------------------------------------
// CAP state slot indices — matches AnalogCapacitorElement slots
// (capload.c: CAPqcap=0, CAPccap=1)
// ---------------------------------------------------------------------------

const CAP_SLOT_QCAP = 0;
const CAP_SLOT_CCAP = 1;

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java FETShapeP: Gate at (0,0), Source at (SIZE,0)=(1,0), Drain at (SIZE,SIZE*2)=(1,2)
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const FGPFET_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "G",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: 1, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 1, y: 2 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// FGPFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FGPFETElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("FGPFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(FGPFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Drawn geometry: oxide bar at x=0.05 (min x), arrow tip at x=1.1 (max x).
    // Drain/source leads reach x=1. Height: y=0 to y=2.
    return { x: this.position.x + 0.05, y: this.position.y, width: 1.05, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    // Java FGPFETShape fixture coordinates (grid units):
    // Drain path (open):    (1,0) -> (0.55,0) -> (0.55,0.25)
    // Source path (open):   (1,2) -> (0.55,2) -> (0.55,1.75)
    // Channel gap:          (0.55,0.75) to (0.55,1.25)  NORMAL
    // Gate oxide bar:       (0.05,0)    to (0.05,2)      NORMAL
    // Floating gate (THIN): (0.3,1.8)   to (0.3,0.2)
    // Gate lead (THIN):     (0.55,1)    to (0.85,1)
    // Arrow (THIN_FILLED):  (1.1,1) -> (0.85,0.9) -> (0.85,1.1)  pointing LEFT
    const blown = this._properties.getOrDefault<boolean>("blown", false);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Drain path (open L): use drawPath so rasterizer treats it as open polyline
    // matching Java fixture (closed=false).
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 1, y: 0 },
      { op: "lineTo", x: 0.55, y: 0 },
      { op: "lineTo", x: 0.55, y: 0.25 },
    ] });
    // Source path (open L)
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 1, y: 2 },
      { op: "lineTo", x: 0.55, y: 2 },
      { op: "lineTo", x: 0.55, y: 1.75 },
    ] });
    // Channel gap
    ctx.drawLine(0.55, 0.75, 0.55, 1.25);
    // Gate oxide bar
    ctx.drawLine(0.05, 0, 0.05, 2);

    // Floating gate bar
    ctx.drawLine(0.3, 1.8, 0.3, 0.2);
    // Gate lead: from channel to arrow
    ctx.drawLine(0.55, 1, 0.85, 1);
    // P-channel arrow: filled triangle pointing LEFT
    ctx.drawPolygon([{ x: 1.1, y: 1 }, { x: 0.85, y: 0.9 }, { x: 0.85, y: 1.1 }], true);

    // Blown indicator
    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.drawLine(0.2, 0.5, 0.7, 1.0);
      ctx.drawLine(0.7, 0.5, 0.2, 1.0);
    }

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  get blown(): boolean {
    return this._properties.getOrDefault<boolean>("blown", false);
  }
}

// ---------------------------------------------------------------------------
// executeFGPFET — flat simulation function
//
// G=0 and not blown → closed=1; else closed=0
// State layout: [closedFlag=0, blownFlag=1]
// ---------------------------------------------------------------------------

export function executeFGPFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const blown = state[stBase + 1]! & 1;
  const closed = blown ? 0 : (gate ^ 1);
  state[stBase] = closed;

  const classification = layout.getSwitchClassification?.(index) ?? 1;
  if (classification !== 2) {
    const sourceNet = wt[outBase]!;
    const drainNet = wt[outBase + 1]!;
    if (closed) {
      state[drainNet] = state[sourceNet]!;
      highZs[drainNet] = 0;
    } else {
      highZs[drainNet] = 0xffffffff;
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const FGPFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "blown", propertyKey: "blown", convert: (v) => v === "true" },
];

const FGPFET_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the switched signal",
    structural: true,
  },
  {
    key: "blown",
    type: PropertyType.BOOLEAN,
    label: "Blown",
    defaultValue: false,
    description: "When true, floating gate is programmed — FET is permanently non-conducting",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
  },
];

function fgpfetFactory(props: PropertyBag): FGPFETElement {
  return new FGPFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// FGPFETCapSubElement — CAP sub-element for floating-gate coupling
//
// Port of capsetup.c:114-117. Positive terminal wired to the floating-gate
// internal node; negative terminal wired to ground (0).
// Identical structure to FGNFET CAP sub-element.
// ---------------------------------------------------------------------------

class FGPFETCapSubElement implements AnalogElementCore {
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.CAP;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  // Matrix handles allocated during setup() — capsetup.c:114-117
  _hPP: number = -1;
  _hNN: number = -1;
  _hPN: number = -1;
  _hNP: number = -1;

  constructor(pinNodes: Map<string, number>) {
    this._pinNodes = pinNodes;
  }

  setup(ctx: SetupContext): void {
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;
    this._stateBase = ctx.allocStates(2);
    // capsetup.c:114-117 — 4 TSTALLOC entries
    this._hPP = ctx.solver.allocElement(posNode, posNode);
    this._hNN = ctx.solver.allocElement(negNode, negNode);
    this._hPN = ctx.solver.allocElement(posNode, negNode);
    this._hNP = ctx.solver.allocElement(negNode, posNode);
  }

  load(ctx: LoadContext): void {
    // Port of capload.c CAPload — value-side stamps via cached handles.
    // capload.c:30: participate only in MODETRAN | MODEAC | MODETRANOP.
    const mode = ctx.cktMode;
    if (!(mode & (MODETRAN | MODEAC | MODETRANOP))) return;

    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;
    const C = FGPFET_CAP_DEFAULT;
    // capload.c:44: m = CAPm (multiplicity, default 1.0).
    const m = 1.0;
    const base = this._stateBase;
    const s0 = ctx.state0;
    const s1 = ctx.state1;

    // capload.c:32-36: IC gate condition.
    const cond1 =
      (((mode & MODEDC) !== 0) && ((mode & MODEINITJCT) !== 0)) ||
      (((mode & MODEUIC) !== 0) && ((mode & MODEINITTRAN) !== 0));

    // capload.c:46-51: read terminal voltage.
    let vcap: number;
    if (cond1) {
      vcap = 0.0;  // CAPinitCond default = 0
    } else {
      vcap = ctx.rhsOld[posNode] - ctx.rhsOld[negNode];
    }

    if (mode & (MODETRAN | MODEAC)) {
      // capload.c:53-65: #ifndef PREDICTOR charge update.
      if (mode & MODEINITPRED) {
        // capload.c:55-56: copy state1 charge to state0.
        s0[base + CAP_SLOT_QCAP] = s1[base + CAP_SLOT_QCAP];
      } else {
        // capload.c:58: Q = C * V.
        s0[base + CAP_SLOT_QCAP] = C * vcap;
        if (mode & MODEINITTRAN) {
          // capload.c:60-62: seed state1 from state0.
          s1[base + CAP_SLOT_QCAP] = s0[base + CAP_SLOT_QCAP];
        }
      }

      // capload.c:67-68: NIintegrate.
      const q0 = s0[base + CAP_SLOT_QCAP];
      const q1 = s1[base + CAP_SLOT_QCAP];
      const ccapPrev = s1[base + CAP_SLOT_CCAP];
      const { ccap, ceq, geq } = niIntegrate(
        ctx.method, ctx.order, C, ctx.ag,
        q0, q1, [0, 0, 0, 0, 0], ccapPrev,
      );
      s0[base + CAP_SLOT_CCAP] = ccap;

      // capload.c:70-72: seed state1 companion current on first tran step.
      if (mode & MODEINITTRAN) {
        s1[base + CAP_SLOT_CCAP] = s0[base + CAP_SLOT_CCAP];
      }

      // capload.c:74-79: stamp companion model via cached handles (scaled by m).
      // _hPP -> *(here->CAPposPosptr) += m * geq
      // _hNN -> *(here->CAPnegNegptr) += m * geq
      // _hPN -> *(here->CAPposNegptr) -= m * geq
      // _hNP -> *(here->CAPnegPosptr) -= m * geq
      ctx.solver.stampElement(this._hPP, m * geq);
      ctx.solver.stampElement(this._hNN, m * geq);
      ctx.solver.stampElement(this._hPN, -m * geq);
      ctx.solver.stampElement(this._hNP, -m * geq);
      // capload.c:78-79: RHS stamps.
      stampRHS(ctx.rhs, posNode, -m * ceq);
      stampRHS(ctx.rhs, negNode,  m * ceq);
    } else {
      // capload.c:84: DC operating point — store charge only, no stamp.
      s0[base + CAP_SLOT_QCAP] = C * vcap;
    }
  }

  setParam(_key: string, _value: number): void {}

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0];
  }
}

// ---------------------------------------------------------------------------
// FGPFETMosSubElement — MOS sub-element for the floating-gate PMOS channel
//
// Port of mos1set.c:186-207. Gate wired to the floating-gate internal node;
// drain/source wired to the composite D/S pins; bulk tied to source.
// MOS1type = PMOS; TSTALLOC sequence is type-independent (mos1set.c:186-207
// is unconditional). Polarity sign applied only in load().
// For the 3-terminal digital FGPFET: RD=0, RS=0 so dNodePrime=dNode and
// sNodePrime=sNode (the conditional CKTmkVolt at mos1set.c:134-178 is skipped).
// ---------------------------------------------------------------------------

class FGPFETMosSubElement implements AnalogElementCore {
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.MOS;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  // Matrix handles allocated during setup() — mos1set.c:186-207 (22 entries)
  _hDd: number = -1;
  _hGg: number = -1;
  _hSs: number = -1;
  _hBb: number = -1;
  _hDPdp: number = -1;
  _hSPsp: number = -1;
  _hDdp: number = -1;
  _hGb: number = -1;
  _hGdp: number = -1;
  _hGsp: number = -1;
  _hSsp: number = -1;
  _hBdp: number = -1;
  _hBsp: number = -1;
  _hDPsp: number = -1;
  _hDPd: number = -1;
  _hBg: number = -1;
  _hDPg: number = -1;
  _hSPg: number = -1;
  _hSPs: number = -1;
  _hDPb: number = -1;
  _hSPb: number = -1;
  _hSPdp: number = -1;

  constructor(pinNodes: Map<string, number>) {
    this._pinNodes = pinNodes;
  }

  setup(ctx: SetupContext): void {
    const fgNode     = this._pinNodes.get("G")!;
    const drainNode  = this._pinNodes.get("D")!;
    const sourceNode = this._pinNodes.get("S")!;
    // bulk = source (3-terminal: no separate bulk pin)
    // dNodePrime = dNode, sNodePrime = sNode (RD=0, RS=0)

    // MOS1numStates = 17 state slots (mos1defs.h:269-291: MOS1vbd..MOS1cqbs)
    // plus 11 DC-OP scalars (cd, cbd, cbs, gbd, gbs, gm, gds, gmbs, mode, von, vdsat) = 28 total
    this._stateBase = ctx.allocStates(28);

    // mos1set.c:186-207 — 22 TSTALLOC entries, in order
    this._hDd   = ctx.solver.allocElement(drainNode,  drainNode);
    this._hGg   = ctx.solver.allocElement(fgNode,     fgNode);
    this._hSs   = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hBb   = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hDPdp = ctx.solver.allocElement(drainNode,  drainNode);
    this._hSPsp = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hDdp  = ctx.solver.allocElement(drainNode,  drainNode);
    this._hGb   = ctx.solver.allocElement(fgNode,     sourceNode);
    this._hGdp  = ctx.solver.allocElement(fgNode,     drainNode);
    this._hGsp  = ctx.solver.allocElement(fgNode,     sourceNode);
    this._hSsp  = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hBdp  = ctx.solver.allocElement(sourceNode, drainNode);
    this._hBsp  = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hDPsp = ctx.solver.allocElement(drainNode,  sourceNode);
    this._hDPd  = ctx.solver.allocElement(drainNode,  drainNode);
    this._hBg   = ctx.solver.allocElement(sourceNode, fgNode);
    this._hDPg  = ctx.solver.allocElement(drainNode,  fgNode);
    this._hSPg  = ctx.solver.allocElement(sourceNode, fgNode);
    this._hSPs  = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hDPb  = ctx.solver.allocElement(drainNode,  sourceNode);
    this._hSPb  = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hSPdp = ctx.solver.allocElement(sourceNode, drainNode);
  }

  load(ctx: LoadContext): void {
    // Port of mos1load.c MOS1load — PFET: MOS1type = PMOS, polarity = -1.
    // 3-terminal digital model: RD=RS=0 (dNodePrime=dNode, sNodePrime=sNode),
    // no junction capacitances (CBD=CBS=CJ=CJSW=0), no overlap caps (CGDO=CGSO=CGBO=0).
    // PMOS polarity: vbs=polarity*(vB-vS), vgs=polarity*(vG-vS), vds=polarity*(vD-vS).
    // All stamps via pre-allocated handles. No allocElement calls.
    const polarity = -1;  // PMOS: MOS1type = -1
    const mode = ctx.cktMode;
    const voltages = ctx.rhsOld;
    const solver = ctx.solver;
    const s0 = ctx.state0;
    const s1 = ctx.state1;
    // ngspice integrates over CKTstate2 for order-2 Gear/TRAP (niinteg.c).
    // Now a live getter into pool.states[2] (cktdefs.h:82-85), no longer a
    // ctx.state1 placeholder.
    const s2 = ctx.state2;
    const base = this._stateBase;

    // mos1load.c:107: vt = CONSTKoverQ * MOS1temp.
    const vt = FGPFET_KoverQ * (ctx.temp > 0 ? ctx.temp : FGPFET_REFTEMP);

    // mos1load.c:130-147: precomputed device constants.
    const m = 1.0;
    const lde = FGPFET_L;
    const Beta = FGPFET_KP * m * FGPFET_W / lde;
    const drainSatCur  = m * FGPFET_IS;
    const sourceSatCur = m * FGPFET_IS;
    const GateSourceOverlapCap = 0.0;
    const GateDrainOverlapCap  = 0.0;
    const GateBulkOverlapCap   = 0.0;
    const OxideCap = 0.0;

    // Node indices.
    const nodeG = this._pinNodes.get("G")!;  // floating-gate node
    const nodeD = this._pinNodes.get("D")!;
    const nodeS = this._pinNodes.get("S")!;
    const nodeB = nodeS;  // bulk tied to source (3-terminal)

    let vbs: number, vgs: number, vds: number, vbd: number, vgd: number;
    let bypassed = false;
    let bypassCapgs = 0, bypassCapgd = 0, bypassCapgb = 0;

    const simpleGate =
      (mode & (MODEINITFLOAT | MODEINITPRED | MODEINITSMSIG | MODEINITTRAN)) !== 0
      || ((mode & MODEINITFIX) !== 0);

    if (simpleGate) {
      if (mode & (MODEINITPRED | MODEINITTRAN)) {
        const xfact = ctx.deltaOld[1] > 0 ? ctx.dt / ctx.deltaOld[1] : 0;
        const vbs1 = s1[base + MOS_SLOT_VBS];
        const vgs1 = s1[base + MOS_SLOT_VGS];
        const vds1 = s1[base + MOS_SLOT_VDS];
        s0[base + MOS_SLOT_VBS] = vbs1;
        vbs = (1 + xfact) * vbs1 - xfact * s2[base + MOS_SLOT_VBS];
        s0[base + MOS_SLOT_VGS] = vgs1;
        vgs = (1 + xfact) * vgs1 - xfact * s2[base + MOS_SLOT_VGS];
        s0[base + MOS_SLOT_VDS] = vds1;
        vds = (1 + xfact) * vds1 - xfact * s2[base + MOS_SLOT_VDS];
        s0[base + MOS_SLOT_VBD] = s0[base + MOS_SLOT_VBS] - s0[base + MOS_SLOT_VDS];
      } else {
        // mos1load.c:231-239: polarity=-1 flips sign of all terminal voltages.
        vbs = polarity * (voltages[nodeB] - voltages[nodeS]);
        vgs = polarity * (voltages[nodeG] - voltages[nodeS]);
        vds = polarity * (voltages[nodeD] - voltages[nodeS]);
      }

      vbd = vbs - vds;
      vgd = vgs - vds;

      {
        const prevCd   = s0[base + MOS_SLOT_CD];
        const prevCbs  = s0[base + MOS_SLOT_CBS];
        const prevCbd  = s0[base + MOS_SLOT_CBD];
        const prevGm   = s0[base + MOS_SLOT_GM];
        const prevGds  = s0[base + MOS_SLOT_GDS];
        const prevGmbs = s0[base + MOS_SLOT_GMBS];
        const prevGbd  = s0[base + MOS_SLOT_GBD];
        const prevGbs  = s0[base + MOS_SLOT_GBS];
        const prevVbs  = s0[base + MOS_SLOT_VBS];
        const prevVbd  = s0[base + MOS_SLOT_VBD];
        const prevVgs  = s0[base + MOS_SLOT_VGS];
        const prevVds  = s0[base + MOS_SLOT_VDS];
        const prevMode = s0[base + MOS_SLOT_MODE];

        const delvbs = vbs - prevVbs;
        const delvbd = vbd - prevVbd;
        const delvgs = vgs - prevVgs;
        const delvds = vds - prevVds;

        let cdhat: number;
        if (prevMode >= 0) {
          cdhat = prevCd + prevGm * delvgs + prevGds * delvds + prevGmbs * delvbs - prevGbd * delvbd;
        } else {
          const delvgd = delvgs - delvds;
          cdhat = prevCd - (prevGbd - prevGmbs) * delvbd - prevGm * delvgd + prevGds * delvds;
        }
        const cbhat = prevCbs + prevCbd + prevGbd * delvbd + prevGbs * delvbs;

        if (
          !(mode & (MODEINITPRED | MODEINITTRAN | MODEINITSMSIG))
          && ctx.bypass
          && (Math.abs(cbhat - (prevCbs + prevCbd)) < ctx.reltol * (Math.max(Math.abs(cbhat), Math.abs(prevCbs + prevCbd)) + ctx.iabstol))
          && Math.abs(delvbs) < ctx.reltol * Math.max(Math.abs(vbs), Math.abs(prevVbs)) + ctx.voltTol
          && Math.abs(delvbd) < ctx.reltol * Math.max(Math.abs(vbd), Math.abs(prevVbd)) + ctx.voltTol
          && Math.abs(delvgs) < ctx.reltol * Math.max(Math.abs(vgs), Math.abs(prevVgs)) + ctx.voltTol
          && Math.abs(delvds) < ctx.reltol * Math.max(Math.abs(vds), Math.abs(prevVds)) + ctx.voltTol
          && Math.abs(cdhat - prevCd) < ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(prevCd)) + ctx.iabstol
        ) {
          vbs = prevVbs; vbd = prevVbd; vgs = prevVgs; vds = prevVds;
          vgd = vgs - vds;
          if (mode & (MODETRAN | MODETRANOP)) {
            bypassCapgs = s0[base + MOS_SLOT_CAPGS] + s1[base + MOS_SLOT_CAPGS] + GateSourceOverlapCap;
            bypassCapgd = s0[base + MOS_SLOT_CAPGD] + s1[base + MOS_SLOT_CAPGD] + GateDrainOverlapCap;
            bypassCapgb = s0[base + MOS_SLOT_CAPGB] + s1[base + MOS_SLOT_CAPGB] + GateBulkOverlapCap;
          }
          bypassed = true;
        }
      }

      if (!bypassed) {
        // mos1load.c:356-406: voltage limiting (NODELIMITING not defined).
        const vonStored = s0[base + MOS_SLOT_VON];
        const vonForLim = vonStored !== 0 ? vonStored : polarity * FGPFET_VTO;
        const vgsOldStored = s0[base + MOS_SLOT_VGS];
        const vdsOldStored = s0[base + MOS_SLOT_VDS];

        if (vdsOldStored >= 0) {
          vgs = fetlim(vgs, vgsOldStored, vonForLim);
          vds = vgs - vgd;
          vds = limvds(vds, vdsOldStored);
          vgd = vgs - vds;
        } else {
          const vgdOldStored = vgsOldStored - vdsOldStored;
          vgd = fetlim(vgd, vgdOldStored, vonForLim);
          vds = vgs - vgd;
          if (!ctx.cktFixLimit) {
            vds = -limvds(-vds, -vdsOldStored);
          }
          vgs = vgd + vds;
        }

        if (vds >= 0) {
          const vbsOldStored = s0[base + MOS_SLOT_VBS];
          const vbsResult = pnjlim(vbs, vbsOldStored, vt, vt * Math.log(vt / (Math.SQRT2 * FGPFET_IS)));
          vbs = vbsResult.value;
          vbd = vbs - vds;
          if (vbsResult.limited) ctx.noncon.value++;
        } else {
          const vbdOldStored = s0[base + MOS_SLOT_VBD];
          const vbdResult = pnjlim(vbd, vbdOldStored, vt, vt * Math.log(vt / (Math.SQRT2 * FGPFET_IS)));
          vbd = vbdResult.value;
          vbs = vbd + vds;
          if (vbdResult.limited) ctx.noncon.value++;
        }
      }
    } else {
      if ((mode & MODEINITJCT) !== 0) {
        // PMOS initial seed: vbs=-1, vgs=polarity*VTO (negative), vds=0.
        vbs = -1;
        vgs = polarity * FGPFET_VTO;
        vds = 0;
      } else {
        vbs = 0; vgs = 0; vds = 0;
      }
      vbd = vbs - vds;
      vgd = vgs - vds;
    }

    vbd = vbs - vds;
    vgd = vgs - vds;

    let capgs = bypassCapgs, capgd = bypassCapgd, capgb = bypassCapgb;
    const opMode = vds >= 0 ? 1 : -1;
    let capGate = false;

    let gmNR: number, gdsNR: number, gmbsNR: number;
    let gbs: number, cbs: number;
    let gbd: number, cbd: number;
    let cd: number;
    let cdrain: number;
    let ceqgs = 0, ceqgd = 0, ceqgb = 0;
    let gcgs = 0, gcgd = 0, gcgb = 0;

    if (bypassed) {
      gmNR  = s0[base + MOS_SLOT_GM];
      gdsNR = s0[base + MOS_SLOT_GDS];
      gmbsNR= s0[base + MOS_SLOT_GMBS];
      gbd   = s0[base + MOS_SLOT_GBD];
      gbs   = s0[base + MOS_SLOT_GBS];
      cbd   = s0[base + MOS_SLOT_CBD];
      cbs   = s0[base + MOS_SLOT_CBS];
      cd    = s0[base + MOS_SLOT_CD];
      cdrain = opMode * (cd + cbd);
    } else {
      if (vbs <= -3 * vt) {
        gbs = FGPFET_GMIN;
        cbs = gbs * vbs - sourceSatCur;
      } else {
        const evbs = Math.exp(Math.min(FGPFET_MAX_EXP_ARG, vbs / vt));
        gbs = sourceSatCur * evbs / vt + FGPFET_GMIN;
        cbs = sourceSatCur * (evbs - 1) + FGPFET_GMIN * vbs;
      }
      if (vbd <= -3 * vt) {
        gbd = FGPFET_GMIN;
        cbd = gbd * vbd - drainSatCur;
      } else {
        const evbd = Math.exp(Math.min(FGPFET_MAX_EXP_ARG, vbd / vt));
        gbd = drainSatCur * evbd / vt + FGPFET_GMIN;
        cbd = drainSatCur * (evbd - 1) + FGPFET_GMIN * vbd;
      }

      const tPhi = FGPFET_PHI;
      const vbEffective = opMode === 1 ? vbs : vbd;
      let sarg: number;
      if (vbEffective <= 0) {
        sarg = Math.sqrt(tPhi - vbEffective);
      } else {
        sarg = Math.sqrt(tPhi);
        sarg = sarg - vbEffective / (sarg + sarg);
        sarg = Math.max(0, sarg);
      }
      // PMOS polarity: von = VTO * polarity (negative for PMOS). GAMMA=0.
      const von = FGPFET_VTO * polarity;
      const vgst = (opMode === 1 ? vgs : vgd) - von;
      const vdsat = Math.max(vgst, 0);
      const argBE = 0;  // GAMMA=0

      if (vgst <= 0) {
        cdrain = 0; gmNR = 0; gdsNR = 0; gmbsNR = 0;
      } else {
        const betap = Beta;  // LAMBDA=0
        if (vgst <= vds * opMode) {
          cdrain = betap * vgst * vgst * 0.5;
          gmNR = betap * vgst;
          gdsNR = 0;
          gmbsNR = gmNR * argBE;
        } else {
          const vdsMode = vds * opMode;
          cdrain = betap * vdsMode * (vgst - 0.5 * vdsMode);
          gmNR = betap * vdsMode;
          gdsNR = betap * (vgst - vdsMode);
          gmbsNR = gmNR * argBE;
        }
      }

      s0[base + MOS_SLOT_VON]   = polarity * von;
      s0[base + MOS_SLOT_VDSAT] = polarity * vdsat;
      cd = opMode * cdrain - cbd;
      s0[base + MOS_SLOT_CD]    = cd;

      capGate = (mode & (MODETRAN | MODETRANOP | MODEINITSMSIG)) !== 0;

      if (capGate) {
        s0[base + MOS_SLOT_QBS] = 0;
        s0[base + MOS_SLOT_QBD] = 0;
      }

      s0[base + MOS_SLOT_VBS] = vbs;
      s0[base + MOS_SLOT_VBD] = vbd;
      s0[base + MOS_SLOT_VGS] = vgs;
      s0[base + MOS_SLOT_VDS] = vds;

      if (capGate) {
        s0[base + MOS_SLOT_CAPGS] = 0;
        s0[base + MOS_SLOT_CAPGD] = 0;
        s0[base + MOS_SLOT_CAPGB] = 0;
        capgs = 0 + GateSourceOverlapCap;
        capgd = 0 + GateDrainOverlapCap;
        capgb = 0 + GateBulkOverlapCap;

        if (mode & (MODEINITPRED | MODEINITTRAN)) {
          s0[base + MOS_SLOT_QGS] = 0;
          s0[base + MOS_SLOT_QGD] = 0;
          s0[base + MOS_SLOT_QGB] = 0;
        } else if (mode & MODETRAN) {
          const vgs1 = s1[base + MOS_SLOT_VGS];
          const vgd1 = vgs1 - s1[base + MOS_SLOT_VDS];
          const vgb1 = vgs1 - s1[base + MOS_SLOT_VBS];
          s0[base + MOS_SLOT_QGS] = (vgs - vgs1) * capgs + s1[base + MOS_SLOT_QGS];
          s0[base + MOS_SLOT_QGD] = (vgd - vgd1) * capgd + s1[base + MOS_SLOT_QGD];
          s0[base + MOS_SLOT_QGB] = (vgs - vbs - vgb1) * capgb + s1[base + MOS_SLOT_QGB];
        } else {
          s0[base + MOS_SLOT_QGS] = vgs * capgs;
          s0[base + MOS_SLOT_QGD] = vgd * capgd;
          s0[base + MOS_SLOT_QGB] = (vgs - vbs) * capgb;
        }
      }

      const initOrNoTran = (mode & MODEINITTRAN) !== 0 || (mode & MODETRAN) === 0;
      if (initOrNoTran) {
        gcgs = 0; ceqgs = 0;
        gcgd = 0; ceqgd = 0;
        gcgb = 0; ceqgb = 0;
      } else {
        if (capgs === 0) s0[base + MOS_SLOT_CQGS] = 0;
        if (capgd === 0) s0[base + MOS_SLOT_CQGD] = 0;
        if (capgb === 0) s0[base + MOS_SLOT_CQGB] = 0;
        gcgs = 0; ceqgs = 0;
        gcgd = 0; ceqgd = 0;
        gcgb = 0; ceqgb = 0;
      }
    }

    // mos1load.c:902-916: RHS terms (polarity=-1 applies here).
    const ceqbs = polarity * (cbs - gbs * vbs);
    const ceqbd = polarity * (cbd - gbd * vbd);
    let xnrm: number, xrev: number, cdreq: number;
    if (opMode >= 0) {
      xnrm = 1; xrev = 0;
      cdreq = polarity * (cdrain - gdsNR * vds - gmNR * vgs - gmbsNR * vbs);
    } else {
      xnrm = 0; xrev = 1;
      cdreq = -polarity * (cdrain - gdsNR * (-vds) - gmNR * vgd - gmbsNR * vbd);
    }

    s0[base + MOS_SLOT_CBD]  = cbd;
    s0[base + MOS_SLOT_CBS]  = cbs;
    s0[base + MOS_SLOT_GBD]  = gbd;
    s0[base + MOS_SLOT_GBS]  = gbs;
    s0[base + MOS_SLOT_GM]   = gmNR;
    s0[base + MOS_SLOT_GDS]  = gdsNR;
    s0[base + MOS_SLOT_GMBS] = gmbsNR;
    s0[base + MOS_SLOT_MODE] = opMode;

    // mos1load.c:917-924: RHS stamps.
    stampRHS(ctx.rhs, nodeG, -(polarity * (ceqgs + ceqgb + ceqgd)));
    stampRHS(ctx.rhs, nodeB, -(ceqbs + ceqbd - polarity * ceqgb));
    stampRHS(ctx.rhs, nodeD,  (ceqbd - cdreq + polarity * ceqgd));
    stampRHS(ctx.rhs, nodeS,  (cdreq + ceqbs + polarity * ceqgs));

    // mos1load.c:929-956: Y-matrix stamps via pre-allocated handles.
    // PMOS: same stamp equations as NMOS — polarity enters via ceqbs/ceqbd/cdreq.
    solver.stampElement(this._hDd,   0);
    solver.stampElement(this._hGg,   gcgd + gcgs + gcgb);
    solver.stampElement(this._hSs,   0);
    solver.stampElement(this._hBb,   gbd + gbs + gcgb);
    solver.stampElement(this._hDPdp, gdsNR + gbd + xrev * (gmNR + gmbsNR) + gcgd);
    solver.stampElement(this._hSPsp, gdsNR + gbs + xnrm * (gmNR + gmbsNR) + gcgs);
    solver.stampElement(this._hDdp,  0);
    solver.stampElement(this._hGb,   -gcgb);
    solver.stampElement(this._hGdp,  -gcgd);
    solver.stampElement(this._hGsp,  -gcgs);
    solver.stampElement(this._hSsp,  0);
    solver.stampElement(this._hBdp,  -gbd);
    solver.stampElement(this._hBsp,  -gbs);
    solver.stampElement(this._hDPsp, -gdsNR - xnrm * (gmNR + gmbsNR));
    solver.stampElement(this._hDPd,  0);
    solver.stampElement(this._hBg,   -gcgb);
    solver.stampElement(this._hDPg,  (xnrm - xrev) * gmNR - gcgd);
    solver.stampElement(this._hSPg,  -(xnrm - xrev) * gmNR - gcgs);
    solver.stampElement(this._hSPs,  0);
    solver.stampElement(this._hDPb,  -gbd + (xnrm - xrev) * gmbsNR);
    solver.stampElement(this._hSPb,  -gbs - (xnrm - xrev) * gmbsNR);
    solver.stampElement(this._hSPdp, -gdsNR - xrev * (gmNR + gmbsNR));
  }

  setParam(_key: string, _value: number): void {}

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0];
  }
}

// ---------------------------------------------------------------------------
// FGPFETAnalogElement — MNA composite for floating-gate PMOS (MOS + CAP)
//
// FGPFET is a composite: a MOS sub-element (gate wired to floating-gate node,
// MOS1type=PMOS) and a CAP sub-element (floating-gate node to ground). The
// floating-gate node is allocated via ctx.makeVolt(label, "fg") in setup().
//
// This class carries no ngspiceNodeMap — composites leave that to sub-elements.
// ngspiceLoadOrder = MOS (35): the higher of MOS and CAP, so the composite
// bucket sorts after capacitors in cktLoad order.
// PFET polarity inversion (MOS1type=PMOS, polarity=-1) is applied in load() only.
// ---------------------------------------------------------------------------

export class FGPFETAnalogElement implements AnalogElementCore {
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.MOS;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = true;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;
  _fgNode: number = -1;

  readonly _cap: FGPFETCapSubElement;
  readonly _mos: FGPFETMosSubElement;

  constructor(pinNodes: ReadonlyMap<string, number>) {
    this._pinNodes = new Map(pinNodes);
    const drainNode  = this._pinNodes.get("D")!;
    const sourceNode = this._pinNodes.get("S")!;

    // Sub-element pin maps use placeholder 0 for the floating-gate node;
    // setup() overwrites with the allocated fgNode before calling sub.setup().
    const capPinNodes = new Map<string, number>([
      ["pos", 0],
      ["neg", 0],
    ]);
    const mosPinNodes = new Map<string, number>([
      ["G", 0],
      ["D", drainNode],
      ["S", sourceNode],
    ]);

    this._cap = new FGPFETCapSubElement(capPinNodes);
    this._mos = new FGPFETMosSubElement(mosPinNodes);
  }

  setup(ctx: SetupContext): void {
    // Allocate the floating-gate internal node first.
    this._fgNode = ctx.makeVolt(this.label ?? "FGPFET", "fg");

    // Patch fgNode into sub-element pin maps before calling their setup().
    this._cap._pinNodes.set("pos", this._fgNode);
    this._cap._pinNodes.set("neg", 0);
    this._mos._pinNodes.set("G", this._fgNode);

    // Sort sub-elements by ngspiceLoadOrder; ascending order = ngspice cktLoad order.
    // CAP (17) loads before MOS (35), so CAP's state slots and handles come first.
    for (const sub of [this._cap, this._mos].sort((a, b) => a.ngspiceLoadOrder - b.ngspiceLoadOrder)) {
      sub.setup(ctx);
    }
  }

  load(ctx: LoadContext): void {
    this._cap.load(ctx);
    this._mos.load(ctx);
  }

  setParam(_key: string, _value: number): void {}

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0];
  }
}

const fgpfetAnalogFactory: AnalogFactory = (
  pinNodes: ReadonlyMap<string, number>,
  _props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore => new FGPFETAnalogElement(pinNodes);

export const FGPFETDefinition: ComponentDefinition = {
  name: "FGPFET",
  typeId: -1,
  factory: fgpfetFactory,
  pinLayout: FGPFET_PIN_DECLARATIONS,
  propertyDefs: FGPFET_PROPERTY_DEFS,
  attributeMap: FGPFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "FGPFET — P-channel floating-gate MOSFET. Programmed (blown) gate permanently disables conduction.",
  models: {
    digital: {
      executeFn: executeFGPFET,
      inputSchema: ["G"],
      outputSchema: ["S", "D"],
      stateSlotCount: 2,
      switchPins: [1, 2],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "spice-l1": {
      kind: "inline",
      factory: fgpfetAnalogFactory,
      paramDefs: [],
      params: {},
      mayCreateInternalNodes: true,
    },
  },
};
