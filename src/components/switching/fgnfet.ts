/**
 * FGNFET — N-channel floating-gate MOSFET.
 *
 * Behaves like NFET (G=1 → conducting) except when the floating gate is
 * "programmed" (blown=true). A programmed FGNFET is permanently non-conducting
 * regardless of the gate input — it acts as a one-time programmable fuse-like
 * element used in PLD/ROM arrays.
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: D (drain), S (source)
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
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
import type { AnalogElementCore } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { FETLayout } from "./nfet.js";
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
const FGNFET_GMIN = 1e-12;
/** Maximum safe exponential argument (defines.h MAX_EXP_ARG). */
const FGNFET_MAX_EXP_ARG = 709.0;
/** Boltzmann constant / elementary charge (CONSTKoverQ). */
const FGNFET_KoverQ = 1.3806226e-23 / 1.6021918e-19;
/** Reference temperature (REFTEMP). */
const FGNFET_REFTEMP = 300.15;
/** Default floating-gate coupling capacitance (F). Used by FGNFETCapSubElement. */
const FGNFET_CAP_DEFAULT = 1e-15;
/** Default MOS1 VTO for NFET (V). */
const FGNFET_VTO = 1.0;
/** Default MOS1 KP for NFET (A/V²). */
const FGNFET_KP = 2e-5;
/** Default MOS1 PHI (V). */
const FGNFET_PHI = 0.6;
/** Default MOS1 W (m). */
const FGNFET_W = 1e-4;
/** Default MOS1 L (m). */
const FGNFET_L = 1e-4;
/** Default MOS1 IS (A). */
const FGNFET_IS = 1e-14;

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

// Java FETShapeN: Gate at (0,SIZE*2)=(0,2), Drain at (SIZE,0)=(1,0), Source at (SIZE,SIZE*2)=(1,2)
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const FGNFET_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "G",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 1, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: 1, y: 2 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// FGNFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FGNFETElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("FGNFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(FGNFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Drawn geometry: oxide bar at x=0.05 (min), gate lead to x=1.15 (max).
    // Arrow tip at x=0.75, base at x=1.0. Drain/source leads at x=1.
    // Height: y=0 to y=2.
    return { x: this.position.x + 0.05, y: this.position.y, width: 1.1, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    const blown = this._properties.getOrDefault<boolean>("blown", false);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Drain lead: (1,0) → (0.55,0) → (0.55,0.25)
    ctx.drawLine(1, 0, 0.55, 0);
    ctx.drawLine(0.55, 0, 0.55, 0.25);

    // Source lead: (1,2) → (0.55,2) → (0.55,1.75)
    ctx.drawLine(1, 2, 0.55, 2);
    ctx.drawLine(0.55, 2, 0.55, 1.75);

    // Channel gap line: (0.55,0.75) to (0.55,1.25)
    ctx.drawLine(0.55, 0.75, 0.55, 1.25);

    // Gate oxide bar: vertical line at x=0.05 from y=0 to y=2
    ctx.drawLine(0.05, 0, 0.05, 2);

    // Floating gate bar (THIN): (0.3,1.8) to (0.3,0.2)
    ctx.setLineWidth(0.5);
    ctx.drawLine(0.3, 1.8, 0.3, 0.2);

    // Gate lead (THIN): (0.9,1) to (1.15,1) — extends to x=1.15 per Java fixture
    ctx.drawLine(0.9, 1, 1.15, 1);

    // N-channel arrow (THIN_FILLED): tip at (0.75,1), base at (1,0.9)→(1,1.1)
    ctx.drawPolygon([
      { x: 0.75, y: 1 },
      { x: 1, y: 0.9 },
      { x: 1, y: 1.1 },
    ], true);
    ctx.setLineWidth(1);

    // Blown indicator: X mark
    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.drawLine(0.5, 0.5, 1.0, 1.0);
      ctx.drawLine(1.0, 0.5, 0.5, 1.0);
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
// executeFGNFET — flat simulation function
//
// G=1 and not blown → closed=1; else closed=0
// The blown flag is baked into propertyDefs; not available here directly.
// The engine reads blown from component properties during compilation and
// writes it to state[stBase + 1]. We read it from there.
//
// State layout: [closedFlag=0, blownFlag=1]
// ---------------------------------------------------------------------------

export function executeFGNFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const blown = state[stBase + 1]! & 1;
  const closed = blown ? 0 : gate;
  state[stBase] = closed;

  const classification = layout.getSwitchClassification?.(index) ?? 1;
  if (classification !== 2) {
    const drainNet = wt[outBase]!;
    const sourceNet = wt[outBase + 1]!;
    if (closed) {
      state[sourceNet] = state[drainNet]!;
      highZs[sourceNet] = 0;
    } else {
      highZs[sourceNet] = 0xffffffff;
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const FGNFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "blown", propertyKey: "blown", convert: (v) => v === "true" },
];

const FGNFET_PROPERTY_DEFS: PropertyDefinition[] = [
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

// ---------------------------------------------------------------------------
// FGNFETCapSubElement — CAP sub-element for floating-gate coupling
//
// Port of capsetup.c:114-117. Positive terminal wired to the floating-gate
// internal node; negative terminal wired to ground (0).
// ---------------------------------------------------------------------------

class FGNFETCapSubElement implements AnalogElementCore {
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
    const C = FGNFET_CAP_DEFAULT;
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
// FGNFETMosSubElement — MOS sub-element for the floating-gate NMOS channel
//
// Port of mos1set.c:186-207. Gate wired to the floating-gate internal node;
// drain/source wired to the composite D/S pins; bulk tied to source.
// For the 3-terminal digital FGNFET: RD=0, RS=0 so dNodePrime=dNode and
// sNodePrime=sNode (the conditional CKTmkVolt at mos1set.c:134-178 is skipped).
// ---------------------------------------------------------------------------

class FGNFETMosSubElement implements AnalogElementCore {
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
    const fgNode    = this._pinNodes.get("G")!;
    const drainNode = this._pinNodes.get("D")!;
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
    // Port of mos1load.c MOS1load — NFET: MOS1type = NMOS, polarity = +1.
    // 3-terminal digital model: RD=RS=0 (dNodePrime=dNode, sNodePrime=sNode),
    // no junction capacitances (CBD=CBS=CJ=CJSW=0), no overlap caps (CGDO=CGSO=CGBO=0).
    // All stamps via pre-allocated handles. No allocElement calls.
    const polarity = 1;  // NMOS: MOS1type = +1
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

    // mos1load.c:107: vt = CONSTKoverQ * MOS1temp (circuit temperature).
    const vt = FGNFET_KoverQ * (ctx.temp > 0 ? ctx.temp : FGNFET_REFTEMP);

    // mos1load.c:130-147: precomputed device constants.
    // 3-terminal digital FGNFET: W=L=1e-4, no RD/RS, M=1.
    const m = 1.0;  // multiplicity
    const lde = FGNFET_L;  // EffectiveLength = L - 2*LD; LD=0 default
    const Beta = FGNFET_KP * m * FGNFET_W / lde;
    // No drain/source sat current from density; use IS directly.
    const drainSatCur  = m * FGNFET_IS;
    const sourceSatCur = m * FGNFET_IS;
    // Overlap caps zero (default CGSO=CGDO=CGBO=0).
    const GateSourceOverlapCap = 0.0;
    const GateDrainOverlapCap  = 0.0;
    const GateBulkOverlapCap   = 0.0;
    // OxideCap zero (no TOX set in digital model).
    const OxideCap = 0.0;

    // Node indices.
    const nodeG = this._pinNodes.get("G")!;  // floating-gate node
    const nodeD = this._pinNodes.get("D")!;
    const nodeS = this._pinNodes.get("S")!;
    const nodeB = nodeS;  // bulk tied to source (3-terminal)

    // mos1load.c:201-204: mode dispatch.
    let vbs: number, vgs: number, vds: number, vbd: number, vgd: number;
    let bypassed = false;
    let bypassCapgs = 0, bypassCapgd = 0, bypassCapgb = 0;

    const simpleGate =
      (mode & (MODEINITFLOAT | MODEINITPRED | MODEINITSMSIG | MODEINITTRAN)) !== 0
      || ((mode & MODEINITFIX) !== 0);  // 3-terminal model has no OFF flag

    if (simpleGate) {
      if (mode & (MODEINITPRED | MODEINITTRAN)) {
        // mos1load.c:205-225: predictor step.
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
        // mos1load.c:226-239: general iteration from CKTrhsOld.
        vbs = polarity * (voltages[nodeB] - voltages[nodeS]);
        vgs = polarity * (voltages[nodeG] - voltages[nodeS]);
        vds = polarity * (voltages[nodeD] - voltages[nodeS]);
      }

      vbd = vbs - vds;
      vgd = vgs - vds;

      // mos1load.c:258-348: bypass gate (NOBYPASS not defined — bypass enabled).
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
        const vonForLim = vonStored !== 0 ? vonStored : polarity * FGNFET_VTO;
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

        // pnjlim on bulk junctions.
        if (vds >= 0) {
          const vbsOldStored = s0[base + MOS_SLOT_VBS];
          const vbsResult = pnjlim(vbs, vbsOldStored, vt, vt * Math.log(vt / (Math.SQRT2 * FGNFET_IS)));
          vbs = vbsResult.value;
          vbd = vbs - vds;
          if (vbsResult.limited) ctx.noncon.value++;
        } else {
          const vbdOldStored = s0[base + MOS_SLOT_VBD];
          const vbdResult = pnjlim(vbd, vbdOldStored, vt, vt * Math.log(vt / (Math.SQRT2 * FGNFET_IS)));
          vbd = vbdResult.value;
          vbs = vbd + vds;
          if (vbdResult.limited) ctx.noncon.value++;
        }
      }
    } else {
      // mos1load.c:412-434: MODEINITJCT / MODEINITFIX+OFF / default-zero.
      if ((mode & MODEINITJCT) !== 0) {
        // No IC values in digital model; fall back to default seed.
        vbs = -1;
        vgs = polarity * FGNFET_VTO;
        vds = 0;
      } else {
        vbs = 0; vgs = 0; vds = 0;
      }
      vbd = vbs - vds;
      vgd = vgs - vds;
    }

    // mos1load.c:443-445: recompute post-limiting.
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
      // mos1load.c:453-468: bulk junction currents.
      if (vbs <= -3 * vt) {
        gbs = FGNFET_GMIN;
        cbs = gbs * vbs - sourceSatCur;
      } else {
        const evbs = Math.exp(Math.min(FGNFET_MAX_EXP_ARG, vbs / vt));
        gbs = sourceSatCur * evbs / vt + FGNFET_GMIN;
        cbs = sourceSatCur * (evbs - 1) + FGNFET_GMIN * vbs;
      }
      if (vbd <= -3 * vt) {
        gbd = FGNFET_GMIN;
        cbd = gbd * vbd - drainSatCur;
      } else {
        const evbd = Math.exp(Math.min(FGNFET_MAX_EXP_ARG, vbd / vt));
        gbd = drainSatCur * evbd / vt + FGNFET_GMIN;
        cbd = drainSatCur * (evbd - 1) + FGNFET_GMIN * vbd;
      }

      // mos1load.c:483-546: Shichman-Hodges drain current.
      const tPhi = FGNFET_PHI;
      const vbEffective = opMode === 1 ? vbs : vbd;
      let sarg: number;
      if (vbEffective <= 0) {
        sarg = Math.sqrt(tPhi - vbEffective);
      } else {
        sarg = Math.sqrt(tPhi);
        sarg = sarg - vbEffective / (sarg + sarg);
        sarg = Math.max(0, sarg);
      }
      // mos1load.c:507: von = tVbi * MOS1type + gamma * sarg. GAMMA=0 default.
      // tVbi = VTO - polarity*(GAMMA*sqrt(PHI)) + ... ≈ VTO for GAMMA=0.
      const von = FGNFET_VTO * polarity;
      const vgst = (opMode === 1 ? vgs : vgd) - von;
      const vdsat = Math.max(vgst, 0);
      const argBE = sarg <= 0 ? 0 : 0;  // GAMMA=0, so arg = GAMMA/(2*sarg) = 0

      if (vgst <= 0) {
        cdrain = 0; gmNR = 0; gdsNR = 0; gmbsNR = 0;
      } else {
        const betap = Beta * (1 + 0 * (vds * opMode));  // LAMBDA=0 default
        if (vgst <= vds * opMode) {
          cdrain = betap * vgst * vgst * 0.5;
          gmNR = betap * vgst;
          gdsNR = 0;  // LAMBDA=0
          gmbsNR = gmNR * argBE;
        } else {
          const vdsMode = vds * opMode;
          cdrain = betap * vdsMode * (vgst - 0.5 * vdsMode);
          gmNR = betap * vdsMode;
          gdsNR = betap * (vgst - vdsMode);  // LAMBDA=0, second term = 0
          gmbsNR = gmNR * argBE;
        }
      }

      // mos1load.c:557-563: write von, vdsat, cd with polarity.
      s0[base + MOS_SLOT_VON]   = polarity * von;
      s0[base + MOS_SLOT_VDSAT] = polarity * vdsat;
      cd = opMode * cdrain - cbd;
      s0[base + MOS_SLOT_CD]    = cd;

      // mos1load.c:565: cap gate.
      capGate = (mode & (MODETRAN | MODETRANOP | MODEINITSMSIG)) !== 0;

      // mos1load.c:586-694: bulk depletion caps — zero for digital model (CBD=CBS=CJ=0).
      let capbd = 0, capbs = 0;
      if (capGate) {
        s0[base + MOS_SLOT_QBS] = 0;
        s0[base + MOS_SLOT_QBD] = 0;
        capbs = 0;
        capbd = 0;

        // mos1load.c:701-725: NIintegrate bulk junctions (zero caps, no-op).
        const runBulkNI = (mode & MODETRAN) !== 0
          || ((mode & MODEINITTRAN) !== 0 && (mode & MODEUIC) === 0);
        if (runBulkNI) {
          // capbd=capbs=0 so geq=0, ccap=ag[0]*0=0 — bulk integrations are no-ops.
        }
      }

      // mos1load.c:750-753: save state.
      s0[base + MOS_SLOT_VBS] = vbs;
      s0[base + MOS_SLOT_VBD] = vbd;
      s0[base + MOS_SLOT_VGS] = vgs;
      s0[base + MOS_SLOT_VDS] = vds;

      // mos1load.c:759-856: Meyer caps + charges.
      if (capGate) {
        // DEVqmeyer: OxideCap=0, so all Meyer caps are zero.
        // capgs = capgd = capgb = 0 + overlap = 0.
        s0[base + MOS_SLOT_CAPGS] = 0;
        s0[base + MOS_SLOT_CAPGD] = 0;
        s0[base + MOS_SLOT_CAPGB] = 0;
        capgs = 0 + GateSourceOverlapCap;
        capgd = 0 + GateDrainOverlapCap;
        capgb = 0 + GateBulkOverlapCap;

        // mos1load.c:827-852: charge update (all zero since caps=0).
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

      // mos1load.c:860-894: NIintegrate gate caps.
      const initOrNoTran = (mode & MODEINITTRAN) !== 0 || (mode & MODETRAN) === 0;
      if (initOrNoTran) {
        gcgs = 0; ceqgs = 0;
        gcgd = 0; ceqgd = 0;
        gcgb = 0; ceqgb = 0;
      } else {
        // capgs=capgd=capgb=0 for digital model — all companions are zero.
        if (capgs === 0) s0[base + MOS_SLOT_CQGS] = 0;
        if (capgd === 0) s0[base + MOS_SLOT_CQGD] = 0;
        if (capgb === 0) s0[base + MOS_SLOT_CQGB] = 0;
        gcgs = 0; ceqgs = 0;
        gcgd = 0; ceqgd = 0;
        gcgb = 0; ceqgb = 0;
      }
    } // end !bypassed

    // mos1load.c:902-916: ceqbs, ceqbd, cdreq RHS terms.
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

    // mos1load.c:750-753: save DC-op scalars.
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
    // With RD=RS=0: dNodePrime=dNode, sNodePrime=sNode; handles alias as in setup().
    // mos1load.c:929: *(MOS1DdPtr)    += drainConductance  — zero for RD=0
    // mos1load.c:930: *(MOS1GgPtr)    += gcgd+gcgs+gcgb
    // mos1load.c:931: *(MOS1SsPtr)    += sourceConductance — zero for RS=0
    // mos1load.c:932: *(MOS1BbPtr)    += gbd+gbs+gcgb
    // mos1load.c:933: *(MOS1DPdpPtr)  += drainCond+gds+gbd+xrev*(gm+gmbs)+gcgd
    // mos1load.c:935: *(MOS1SPspPtr)  += sourceCond+gds+gbs+xnrm*(gm+gmbs)+gcgs
    // mos1load.c:937: *(MOS1DdpPtr)   += -drainCond
    // mos1load.c:938: *(MOS1GbPtr)    -= gcgb
    // mos1load.c:939: *(MOS1GdpPtr)   -= gcgd
    // mos1load.c:940: *(MOS1GspPtr)   -= gcgs
    // mos1load.c:941: *(MOS1SspPtr)   += -sourceCond
    // mos1load.c:942: *(MOS1BgPtr)    -= gcgb
    // mos1load.c:943: *(MOS1BdpPtr)   -= gbd
    // mos1load.c:944: *(MOS1BspPtr)   -= gbs
    // mos1load.c:945: *(MOS1DPdPtr)   += -drainCond
    // mos1load.c:946: *(MOS1DPgPtr)   += (xnrm-xrev)*gm - gcgd
    // mos1load.c:947: *(MOS1DPbPtr)   += -gbd + (xnrm-xrev)*gmbs
    // mos1load.c:948: *(MOS1DPspPtr)  += -gds - xnrm*(gm+gmbs)
    // mos1load.c:950: *(MOS1SPgPtr)   += -(xnrm-xrev)*gm - gcgs
    // mos1load.c:951: *(MOS1SPsPtr)   += -sourceCond
    // mos1load.c:952: *(MOS1SPbPtr)   += -gbs - (xnrm-xrev)*gmbs
    // mos1load.c:953: *(MOS1SPdpPtr)  += -gds - xrev*(gm+gmbs)
    //
    // RD=RS=0: drainConductance=0, sourceConductance=0. Handles that are
    // duplicates (e.g., _hDd and _hDPdp both map to (D,D)) accumulate additively.
    solver.stampElement(this._hDd,   0);                                                      // Dd: += drainCond = 0
    solver.stampElement(this._hGg,   gcgd + gcgs + gcgb);                                    // Gg
    solver.stampElement(this._hSs,   0);                                                      // Ss: += sourceCond = 0
    solver.stampElement(this._hBb,   gbd + gbs + gcgb);                                      // Bb = (S,S)
    solver.stampElement(this._hDPdp, gdsNR + gbd + xrev * (gmNR + gmbsNR) + gcgd);          // DPdp
    solver.stampElement(this._hSPsp, gdsNR + gbs + xnrm * (gmNR + gmbsNR) + gcgs);          // SPsp
    solver.stampElement(this._hDdp,  0);                                                      // Ddp: += -drainCond = 0
    solver.stampElement(this._hGb,   -gcgb);                                                  // Gb
    solver.stampElement(this._hGdp,  -gcgd);                                                  // Gdp
    solver.stampElement(this._hGsp,  -gcgs);                                                  // Gsp
    solver.stampElement(this._hSsp,  0);                                                      // Ssp: += -sourceCond = 0
    solver.stampElement(this._hBdp,  -gbd);                                                   // Bdp
    solver.stampElement(this._hBsp,  -gbs);                                                   // Bsp
    solver.stampElement(this._hDPsp, -gdsNR - xnrm * (gmNR + gmbsNR));                      // DPsp
    solver.stampElement(this._hDPd,  0);                                                      // DPd: += -drainCond = 0
    solver.stampElement(this._hBg,   -gcgb);                                                  // Bg
    solver.stampElement(this._hDPg,  (xnrm - xrev) * gmNR - gcgd);                          // DPg
    solver.stampElement(this._hSPg,  -(xnrm - xrev) * gmNR - gcgs);                         // SPg
    solver.stampElement(this._hSPs,  0);                                                      // SPs: += -sourceCond = 0
    solver.stampElement(this._hDPb,  -gbd + (xnrm - xrev) * gmbsNR);                        // DPb
    solver.stampElement(this._hSPb,  -gbs - (xnrm - xrev) * gmbsNR);                        // SPb
    solver.stampElement(this._hSPdp, -gdsNR - xrev * (gmNR + gmbsNR));                      // SPdp
  }

  setParam(_key: string, _value: number): void {}

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0];
  }
}

// ---------------------------------------------------------------------------
// FGNFETAnalogElement — MNA composite for floating-gate NMOS (MOS + CAP)
//
// FGNFET is a composite: a MOS sub-element (gate wired to floating-gate node)
// and a CAP sub-element (floating-gate node to ground). The floating-gate node
// is allocated via ctx.makeVolt(label, "fg") in setup().
//
// This class carries no ngspiceNodeMap — composites leave that to sub-elements.
// ngspiceLoadOrder = MOS (35): the higher of MOS and CAP, so the composite
// bucket sorts after capacitors in cktLoad order.
// ---------------------------------------------------------------------------

export class FGNFETAnalogElement implements AnalogElementCore {
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.MOS;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = true;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;
  _fgNode: number = -1;

  readonly _cap: FGNFETCapSubElement;
  readonly _mos: FGNFETMosSubElement;

  constructor(pinNodes: ReadonlyMap<string, number>) {
    this._pinNodes = new Map(pinNodes);
    const drainNode = this._pinNodes.get("D")!;
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

    this._cap = new FGNFETCapSubElement(capPinNodes);
    this._mos = new FGNFETMosSubElement(mosPinNodes);
  }

  setup(ctx: SetupContext): void {
    // Allocate the floating-gate internal node first.
    // MOS gate and CAP positive terminal both reference this node.
    this._fgNode = ctx.makeVolt(this.label ?? "FGNFET", "fg");

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

const fgnfetAnalogFactory: AnalogFactory = (
  pinNodes: ReadonlyMap<string, number>,
  _props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore => new FGNFETAnalogElement(pinNodes);

function fgnfetFactory(props: PropertyBag): FGNFETElement {
  return new FGNFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const FGNFETDefinition: ComponentDefinition = {
  name: "FGNFET",
  typeId: -1,
  factory: fgnfetFactory,
  pinLayout: FGNFET_PIN_DECLARATIONS,
  propertyDefs: FGNFET_PROPERTY_DEFS,
  attributeMap: FGNFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "FGNFET — N-channel floating-gate MOSFET. Programmed (blown) gate permanently disables conduction.",
  models: {
    digital: {
      executeFn: executeFGNFET,
      inputSchema: ["G"],
      outputSchema: ["D", "S"],
      stateSlotCount: 2,
      switchPins: [1, 2],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "spice-l1": {
      kind: "inline",
      factory: fgnfetAnalogFactory,
      paramDefs: [],
      params: {},
      mayCreateInternalNodes: true,
    },
  },
};
