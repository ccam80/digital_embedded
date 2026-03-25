/**
 * MOSFET analog components — N-channel and P-channel MOSFETs.
 *
 * Implements the Level 2 SPICE MOSFET model with:
 *   - Three operating regions: cutoff, linear (triode), saturation
 *   - Body effect via GAMMA and PHI parameters
 *   - Channel-length modulation via LAMBDA
 *   - Gate-source voltage limiting via fetlim()
 *   - Source/drain swap detection for symmetric device
 *   - Junction capacitances (CBD, CBS) and overlap capacitances (CGDO, CGSO)
 *
 * PMOS is implemented as the NMOS model with polarity = -1, which inverts
 * all junction voltage signs and current directions.
 *
 * I-V equations (NMOS, polarity = +1):
 *   Vth = VTO + GAMMA * (sqrt(PHI + Vsb) - sqrt(PHI))
 *   Cutoff (Vgs < Vth):        Id = 0
 *   Linear (Vds < Vgs - Vth): Id = KP*(W/L)*((Vgs-Vth)*Vds - Vds²/2)*(1+LAMBDA*Vds)
 *   Saturation (Vds >= Vgs-Vth): Id = KP/2*(W/L)*(Vgs-Vth)²*(1+LAMBDA*Vds)
 *
 * MNA stamp convention (3-terminal: D, G, S):
 *   The linearized MOSFET produces conductances between terminals plus
 *   Norton current sources at D and S.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { IntegrationMethod } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import { fetlim } from "../../analog/newton-raphson.js";
import { MOSFET_NMOS_DEFAULTS, MOSFET_PMOS_DEFAULTS } from "../../analog/model-defaults.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "../../analog/integration.js";
import { AbstractFetElement } from "../../analog/fet-base.js";
import type { FetCapacitances } from "../../analog/fet-base.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------

function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    solver.stamp(row - 1, col - 1, val);
  }
}

function stampRHS(solver: SparseSolver, row: number, val: number): void {
  if (row !== 0) {
    solver.stampRHS(row - 1, val);
  }
}

// ---------------------------------------------------------------------------
// MosfetParams — resolved model parameters
// ---------------------------------------------------------------------------

interface MosfetParams {
  VTO: number;
  KP: number;
  LAMBDA: number;
  PHI: number;
  GAMMA: number;
  CBD: number;
  CBS: number;
  CGDO: number;
  CGSO: number;
  W: number;
  L: number;
}

function resolveParams(
  props: PropertyBag,
  defaults: Record<string, number>,
  propsW: number | undefined,
  propsL: number | undefined,
): MosfetParams {
  const hasFn = typeof props.has === "function";
  const modelParams = hasFn
    ? (props.has("_modelParams") ? props.get<Record<string, number>>("_modelParams") : undefined)
    : (props as unknown as Record<string, unknown>)["_modelParams"] as Record<string, number> | undefined;
  const mp = modelParams ?? defaults;

  return {
    VTO: mp["VTO"] ?? defaults["VTO"],
    KP: mp["KP"] ?? defaults["KP"],
    LAMBDA: mp["LAMBDA"] ?? defaults["LAMBDA"],
    PHI: mp["PHI"] ?? defaults["PHI"],
    GAMMA: mp["GAMMA"] ?? defaults["GAMMA"],
    CBD: mp["CBD"] ?? defaults["CBD"],
    CBS: mp["CBS"] ?? defaults["CBS"],
    CGDO: mp["CGDO"] ?? defaults["CGDO"],
    CGSO: mp["CGSO"] ?? defaults["CGSO"],
    // W and L can be overridden by component properties
    W: propsW ?? mp["W"] ?? defaults["W"],
    L: propsL ?? mp["L"] ?? defaults["L"],
  };
}

// ---------------------------------------------------------------------------
// computeIds — drain current for three operating regions
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET drain-source current and threshold voltage.
 *
 * @param vgs  - Gate-source voltage (polarity-corrected)
 * @param vds  - Drain-source voltage (polarity-corrected, always >= 0 after swap)
 * @param vsb  - Source-bulk voltage (polarity-corrected, >= 0 for NMOS)
 * @param p    - Resolved model parameters
 * @returns    - { ids, vth } drain current and threshold voltage
 */
export function computeIds(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): { ids: number; vth: number } {
  const phi = Math.max(p.PHI, 0.1);
  const vsbSafe = Math.max(vsb, 0);
  const vth = p.VTO + p.GAMMA * (Math.sqrt(phi + vsbSafe) - Math.sqrt(phi));

  const vgst = vgs - vth;

  if (vgst <= 0) {
    return { ids: 0, vth };
  }

  const wl = p.W / p.L;
  const lambda = p.LAMBDA;

  if (vds < vgst) {
    // Linear (triode) region: Vds < Vgs - Vth
    const ids = p.KP * wl * ((vgst * vds) - (vds * vds) / 2) * (1 + lambda * vds);
    return { ids, vth };
  } else {
    // Saturation region: Vds >= Vgs - Vth
    const ids = (p.KP / 2) * wl * vgst * vgst * (1 + lambda * vds);
    return { ids, vth };
  }
}

// ---------------------------------------------------------------------------
// computeGm — transconductance dId/dVgs
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET transconductance gm = dId/dVgs.
 */
export function computeGm(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): number {
  const phi = Math.max(p.PHI, 0.1);
  const vsbSafe = Math.max(vsb, 0);
  const vth = p.VTO + p.GAMMA * (Math.sqrt(phi + vsbSafe) - Math.sqrt(phi));
  const vgst = vgs - vth;

  if (vgst <= 0) {
    return GMIN;
  }

  const wl = p.W / p.L;
  const lambda = p.LAMBDA;

  if (vds < vgst) {
    // Linear: dId/dVgs = KP*(W/L)*Vds*(1+LAMBDA*Vds)
    return p.KP * wl * vds * (1 + lambda * vds) + GMIN;
  } else {
    // Saturation: dId/dVgs = KP*(W/L)*(Vgs-Vth)*(1+LAMBDA*Vds)
    return p.KP * wl * vgst * (1 + lambda * vds) + GMIN;
  }
}

// ---------------------------------------------------------------------------
// computeGds — output conductance dId/dVds
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET output conductance gds = dId/dVds.
 */
export function computeGds(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): number {
  const phi = Math.max(p.PHI, 0.1);
  const vsbSafe = Math.max(vsb, 0);
  const vth = p.VTO + p.GAMMA * (Math.sqrt(phi + vsbSafe) - Math.sqrt(phi));
  const vgst = vgs - vth;

  if (vgst <= 0) {
    return GMIN;
  }

  const wl = p.W / p.L;
  const lambda = p.LAMBDA;

  if (vds < vgst) {
    // Linear: dId/dVds = KP*(W/L)*(Vgs-Vth - Vds)*(1+LAMBDA*Vds) + KP*(W/L)*((Vgs-Vth)*Vds - Vds²/2)*LAMBDA
    const term1 = p.KP * wl * (vgst - vds) * (1 + lambda * vds);
    const term2 = p.KP * wl * (vgst * vds - vds * vds / 2) * lambda;
    return term1 + term2 + GMIN;
  } else {
    // Saturation: dId/dVds = KP/2*(W/L)*(Vgs-Vth)²*LAMBDA
    return (p.KP / 2) * wl * vgst * vgst * lambda + GMIN;
  }
}

// ---------------------------------------------------------------------------
// computeGmbs — bulk transconductance dId/dVbs
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET bulk transconductance gmbs = dId/dVbs.
 *
 * Body effect modulates threshold: dVth/dVbs = -GAMMA/(2*sqrt(PHI+Vsb))
 * gmbs = -gm * dVth/dVsb = gm * GAMMA / (2*sqrt(PHI+Vsb))
 */
export function computeGmbs(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): number {
  const phi = Math.max(p.PHI, 0.1);
  const vsbSafe = Math.max(vsb, 0);
  const vth = p.VTO + p.GAMMA * (Math.sqrt(phi + vsbSafe) - Math.sqrt(phi));
  const vgst = vgs - vth;

  if (vgst <= 0 || p.GAMMA <= 0) {
    return 0;
  }

  const gm = computeGm(vgs, vds, vsb, p);
  const dVthdVsb = p.GAMMA / (2 * Math.sqrt(phi + vsbSafe));
  return gm * dVthdVsb;
}

// ---------------------------------------------------------------------------
// limitVoltages — fetlim on Vgs with source/drain swap detection
// ---------------------------------------------------------------------------

/**
 * Apply fetlim() voltage limiting to Vgs, and handle source/drain swap.
 *
 * A symmetric MOSFET can have its source and drain swapped if Vds < 0.
 * In that case we swap so that the mathematical source (lower potential) is
 * always used for Vgs computation.
 */
export function limitVoltages(
  vgsOld: number,
  vgsNew: number,
  vdsOld: number,
  vdsNew: number,
  vto: number,
): { vgs: number; vds: number; swapped: boolean } {
  let vgs = fetlim(vgsNew, vgsOld, vto);
  let vds = vdsNew;
  let swapped = false;

  // Source/drain swap: if Vds < 0, the drain and source roles are reversed
  if (vds < 0) {
    vds = -vds;
    vgs = vgs - vdsNew; // Vgd becomes the new Vgs
    swapped = true;
  }

  return { vgs, vds, swapped };
}

// ---------------------------------------------------------------------------
// computeCapacitances — junction and overlap capacitances
// ---------------------------------------------------------------------------

/**
 * Compute gate and junction capacitances from model parameters.
 *
 * Returns zero for all capacitances when the relevant parameters are zero.
 * Overlap capacitances scale with channel width W.
 */
export function computeCapacitances(
  p: MosfetParams,
): { cgs: number; cgd: number; cbd: number; cbs: number } {
  return {
    cgs: p.CGSO * p.W,
    cgd: p.CGDO * p.W,
    cbd: p.CBD,
    cbs: p.CBS,
  };
}

// ---------------------------------------------------------------------------
// MosfetAnalogElement — AbstractFetElement subclass
// ---------------------------------------------------------------------------

/**
 * Concrete FET analog element for MOSFET (N-channel or P-channel).
 *
 * Extends AbstractFetElement with the Level 2 SPICE MOSFET I-V model,
 * body effect, junction/overlap capacitances, and source/drain swap detection.
 */
class MosfetAnalogElement extends AbstractFetElement {
  readonly polaritySign: 1 | -1;

  private readonly _p: MosfetParams;
  private readonly _nodeB: number;

  // Body-effect state
  private _vsb: number = 0;
  private _gmbs: number = 0;

  // Junction capacitance companion model state (drain-bulk and source-bulk)
  private _capGeqDB: number = 0;
  private _capIeqDB: number = 0;
  private _capGeqSB: number = 0;
  private _capIeqSB: number = 0;
  private _vdbPrev: number = NaN;
  private _vsbCapPrev: number = NaN;
  private _capJunctionFirstCall: boolean = true;

  constructor(
    polarity: 1 | -1,
    nodeD: number,
    nodeG: number,
    nodeS: number,
    nodeB: number,
    p: MosfetParams,
  ) {
    // Pass nodeB as extra node so pinNodeIds = [D, G, S, B] (bulk always included)
    super(nodeG, nodeD, nodeS, [nodeB]);
    this.polaritySign = polarity;
    this._p = p;
    this._nodeB = nodeB;

    // For PMOS, VTO is stored as magnitude; polarity inversion applies sign during I-V evaluation
    if (polarity === -1) {
      this._p.VTO = Math.abs(this._p.VTO);
    }

    const caps = computeCapacitances(p);
    const hasCaps = caps.cbd > 0 || caps.cbs > 0 || caps.cgs > 0 || caps.cgd > 0;
    this._initReactive(hasCaps);
  }

  limitVoltages(
    vgsOld: number,
    _vdsOld: number,
    vgsNew: number,
    vdsNew: number,
  ): { vgs: number; vds: number; swapped: boolean } {
    return limitVoltages(vgsOld, vgsNew, _vdsOld, vdsNew, this._p.VTO);
  }

  computeIds(vgs: number, vds: number): number {
    const { ids } = computeIds(vgs, vds, this._vsb, this._p);
    return ids;
  }

  computeGm(vgs: number, vds: number): number {
    return computeGm(vgs, vds, this._vsb, this._p);
  }

  computeGds(vgs: number, vds: number): number {
    return computeGds(vgs, vds, this._vsb, this._p);
  }

  computeCapacitances(_vgs: number, _vds: number): FetCapacitances {
    const caps = computeCapacitances(this._p);
    return { cgs: caps.cgs, cgd: caps.cgd };
  }

  override updateOperatingPoint(voltages: Float64Array): void {
    const nodeD = this.drainNode;
    const nodeG = this.gateNode;
    const nodeS = this.sourceNode;
    const nodeB = this._nodeB;

    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;
    const vBulk = nodeB > 0 ? voltages[nodeB - 1] : 0;

    // Apply polarity for PMOS (negate all voltages relative to device)
    const vGraw = this.polaritySign * (vG - vS);
    const vDraw = this.polaritySign * (vD - vS);
    const vBraw = this.polaritySign * (vBulk - vS);

    // Voltage limiting on Vgs via fetlim: (vgsOld, vgsNew, vdsOld, vdsNew, vto)
    const limited = limitVoltages(this._vgs, vGraw, this._vds, vDraw, this._p.VTO);
    this._vgs = limited.vgs;
    this._vds = limited.vds;
    this._swapped = limited.swapped;

    // Source-bulk voltage (body effect): Vsb = Vs - Vb (always >= 0 for normal bias)
    this._vsb = Math.max(-vBraw, 0);

    // Recompute operating point at limited voltages
    const result = computeIds(this._vgs, this._vds, this._vsb, this._p);
    this._ids = result.ids;
    this._gm = computeGm(this._vgs, this._vds, this._vsb, this._p);
    this._gds = computeGds(this._vgs, this._vds, this._vsb, this._p);
    this._gmbs = computeGmbs(this._vgs, this._vds, this._vsb, this._p);
  }

  override stampNonlinear(solver: SparseSolver): void {
    const nodeG = this.gateNode;
    const effectiveD = this._swapped ? this.sourceNode : this.drainNode;
    const effectiveS = this._swapped ? this.drainNode : this.sourceNode;
    const nodeB = this._nodeB;

    const gmS = this._gm * this._sourceScale;
    const gdsS = this._gds * this._sourceScale;
    const gmbsS = this._gmbs * this._sourceScale;

    // Transconductance gm (Vgs): current from S to D
    stampG(solver, effectiveD, nodeG, gmS);
    stampG(solver, effectiveD, effectiveS, -gmS);
    stampG(solver, effectiveS, nodeG, -gmS);
    stampG(solver, effectiveS, effectiveS, gmS);

    // Output conductance gds (Vds): current from S to D
    stampG(solver, effectiveD, effectiveD, gdsS);
    stampG(solver, effectiveD, effectiveS, -gdsS);
    stampG(solver, effectiveS, effectiveD, -gdsS);
    stampG(solver, effectiveS, effectiveS, gdsS);

    // Body transconductance gmbs (Vbs = Vb - Vs): only when bulk ≠ source
    if (nodeB !== effectiveS && gmbsS > 0) {
      stampG(solver, effectiveD, nodeB, gmbsS);
      stampG(solver, effectiveD, effectiveS, -gmbsS);
      stampG(solver, effectiveS, nodeB, -gmbsS);
      stampG(solver, effectiveS, effectiveS, gmbsS);
    }

    // Norton current sources (KCL at drain and source)
    // Signed by polarity: positive Id flows from D to S in NMOS
    const vbsOp = -this._vsb; // Vbs = -Vsb
    const nortonId = this.polaritySign * (this._ids - this._gm * this._vgs - this._gds * this._vds - this._gmbs * vbsOp) * this._sourceScale;

    stampRHS(solver, effectiveD, -nortonId);
    stampRHS(solver, effectiveS, nortonId);
  }

  override stamp(solver: SparseSolver): void {
    // Stamp base gate overlap capacitances (Cgs, Cgd)
    super.stamp(solver);

    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;
    const nodeB = this._nodeB;

    // Drain-bulk junction capacitance
    if (this._capGeqDB !== 0 || this._capIeqDB !== 0) {
      stampG(solver, nodeD, nodeD, this._capGeqDB);
      stampG(solver, nodeD, nodeB, -this._capGeqDB);
      stampG(solver, nodeB, nodeD, -this._capGeqDB);
      stampG(solver, nodeB, nodeB, this._capGeqDB);
      stampRHS(solver, nodeD, -this._capIeqDB);
      stampRHS(solver, nodeB, this._capIeqDB);
    }

    // Source-bulk junction capacitance
    if (this._capGeqSB !== 0 || this._capIeqSB !== 0) {
      stampG(solver, nodeS, nodeS, this._capGeqSB);
      stampG(solver, nodeS, nodeB, -this._capGeqSB);
      stampG(solver, nodeB, nodeS, -this._capGeqSB);
      stampG(solver, nodeB, nodeB, this._capGeqSB);
      stampRHS(solver, nodeS, -this._capIeqSB);
      stampRHS(solver, nodeB, this._capIeqSB);
    }
  }

  override stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    // Gate overlap capacitances (Cgs, Cgd) via base class
    super.stampCompanion(dt, method, voltages);

    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;
    const nodeB = this._nodeB;

    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;
    const vBulkV = nodeB > 0 ? voltages[nodeB - 1] : 0;

    const vdb = vD - vBulkV;
    const vsbCap = vS - vBulkV;

    const prevVdb = this._capJunctionFirstCall ? vdb : this._vdbPrev;
    const prevVsb = this._capJunctionFirstCall ? vsbCap : this._vsbCapPrev;

    const iDB = this._capGeqDB * vdb + this._capIeqDB;
    const iSB = this._capGeqSB * vsbCap + this._capIeqSB;

    this._vdbPrev = vdb;
    this._vsbCapPrev = vsbCap;
    this._capJunctionFirstCall = false;

    const caps = computeCapacitances(this._p);

    if (caps.cbd > 0) {
      this._capGeqDB = capacitorConductance(caps.cbd, dt, method);
      this._capIeqDB = capacitorHistoryCurrent(caps.cbd, dt, method, vdb, prevVdb, iDB);
    }

    if (caps.cbs > 0) {
      this._capGeqSB = capacitorConductance(caps.cbs, dt, method);
      this._capIeqSB = capacitorHistoryCurrent(caps.cbs, dt, method, vsbCap, prevVsb, iSB);
    }
  }

}

// ---------------------------------------------------------------------------
// createMosfetElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createMosfetElement(
  polarity: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): MosfetAnalogElement {
  const nodeG = pinNodes.get("G")!; // gate
  const nodeS = pinNodes.get("S")!; // source
  const nodeD = pinNodes.get("D")!; // drain
  // Bulk node: use internalNodeIds[0] if provided (4-terminal body), else treat bulk = source
  const nodeB = internalNodeIds.length >= 1 ? internalNodeIds[0] : nodeS;

  const defaults = polarity === 1 ? MOSFET_NMOS_DEFAULTS : MOSFET_PMOS_DEFAULTS;

  // W and L can be set directly on the component instance.
  // Support both PropertyBag (has/get API) and plain objects (tests cast {} as PropertyBag).
  const hasFn = typeof props.has === "function";
  const propsW = hasFn
    ? (props.has("W") ? props.get<number>("W") : undefined)
    : (props as unknown as Record<string, unknown>)["W"] as number | undefined;
  const propsL = hasFn
    ? (props.has("L") ? props.get<number>("L") : undefined)
    : (props as unknown as Record<string, unknown>)["L"] as number | undefined;

  const p = resolveParams(props, defaults, propsW, propsL);

  return new MosfetAnalogElement(polarity, nodeD, nodeG, nodeS, nodeB, p);
}

// ---------------------------------------------------------------------------
// NmosfetElement + PmosfetElement — CircuitElement implementations
// ---------------------------------------------------------------------------

export class NmosfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NMOS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildNmosPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1.3125,
      width: 4,
      height: 2.625,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vD = signals?.getPinVoltage("D");
    const vG = signals?.getPinVoltage("G");
    const vS = signals?.getPinVoltage("S");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const chanX = 2.625;
    const gateBarX = 2.25;

    // Body (channel segments, gate bar, body connection line, arrow) stays COMPONENT color
    // Channel segments (with gap in middle for depletion-mode styling)
    ctx.drawLine(chanX, 1, chanX, 0.6875);
    ctx.drawLine(chanX, 0.3125, chanX, 0);
    ctx.drawLine(chanX, 0, chanX, -0.3125);
    ctx.drawLine(chanX, -0.6875, chanX, -1);

    // Stub extensions at drain/source sides
    ctx.drawLine(chanX, 1, chanX, 1.3125);
    ctx.drawLine(chanX, -1, chanX, -1.3125);

    // Gate bar
    ctx.drawLine(gateBarX, -0.5, gateBarX, 0.5);

    // Body connection line (channel to body node)
    ctx.drawLine(chanX, 0, 2.625, 0);

    // Arrow (pointing inward for N-channel)
    ctx.drawPolygon([
      { x: 2.625, y: 0 },
      { x: 3.375, y: 0.3125 },
      { x: 3.375, y: -0.3125 },
    ], true);

    // Gate lead (horizontal from pin to gate bar)
    if (signals && vG !== undefined) {
      ctx.setRawColor(signals.voltageColor(vG));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, gateBarX, 0);

    // Drain lead (horizontal stub from channel to drain pin)
    if (signals && vD !== undefined) {
      ctx.setRawColor(signals.voltageColor(vD));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(4, -1, chanX, -1);

    // Source lead (horizontal stub + vertical to body + body horizontal)
    if (signals && vS !== undefined) {
      ctx.setRawColor(signals.voltageColor(vS));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(4, 1, chanX, 1);
    ctx.drawLine(4, 1, 4, 0);
    ctx.drawLine(4, 0, chanX, 0);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "N-channel MOSFET — Level 2 model with body effect and channel-length modulation.\n" +
      "Pins: D (drain), G (gate), S (source).\n" +
      "Model parameters: VTO, KP, LAMBDA, PHI, GAMMA, W, L."
    );
  }
}

export class PmosfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PMOS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPmosPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1.3125,
      width: 4.0,
      height: 2.625,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vD = signals?.getPinVoltage("D");
    const vG = signals?.getPinVoltage("G");
    const vS = signals?.getPinVoltage("S");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const chanX = 2.625;
    const gateBarX = 2.25;

    // Line 1: D lead (signal D color)
    if (signals && vD !== undefined) {
      ctx.setRawColor(signals.voltageColor(vD));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(4, 1, chanX, 1);

    // Line 2: S stub horizontal (signal S color)
    if (signals && vS !== undefined) {
      ctx.setRawColor(signals.voltageColor(vS));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(4, -1, chanX, -1);

    // Lines 3-6: channel segments (COMPONENT color)
    ctx.setColor("COMPONENT");
    ctx.drawLine(chanX, 1, chanX, 0.6875);
    ctx.drawLine(chanX, 0.3125, chanX, 0);
    ctx.drawLine(chanX, 0, chanX, -0.3125);
    ctx.drawLine(chanX, -0.6875, chanX, -1);

    // Lines 7-8: extended stubs beyond D/S (COMPONENT color)
    ctx.drawLine(chanX, 1, chanX, 1.3125);
    ctx.drawLine(chanX, -1, chanX, -1.3125);

    // Lines 9-10: S body vertical + horizontal (signal S color)
    if (signals && vS !== undefined) {
      ctx.setRawColor(signals.voltageColor(vS));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(4, -1, 4, 0);
    ctx.drawLine(4, 0, chanX, 0);

    // Line 11: arrow (COMPONENT color)
    ctx.setColor("COMPONENT");
    ctx.fillPolygon([
      { x: 4, y: 0 },
      { x: 3.25, y: -0.3125 },
      { x: 3.25, y: 0.3125 },
    ]);

    // Line 12: gate lead (signal G color)
    if (signals && vG !== undefined) {
      ctx.setRawColor(signals.voltageColor(vG));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, gateBarX, 0);

    // Line 13: gate bar (COMPONENT color)
    ctx.setColor("COMPONENT");
    ctx.drawLine(gateBarX, -0.5, gateBarX, 0.5);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "P-channel MOSFET — Level 2 model with body effect and channel-length modulation.\n" +
      "Pins: D (drain), G (gate), S (source).\n" +
      "Model parameters: VTO, KP, LAMBDA, PHI, GAMMA, W, L."
    );
  }
}

// ---------------------------------------------------------------------------
// Pin layouts
// ---------------------------------------------------------------------------

function buildNmosPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "S",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "D",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

function buildPmosPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D",
      defaultBitWidth: 1,
      position: { x: 4.0, y: 1.0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "S",
      defaultBitWidth: 1,
      position: { x: 4.0, y: -1.0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MOSFET_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "model",
    type: PropertyType.STRING,
    label: "Model",
    defaultValue: "",
    description: "SPICE model name (blank = use built-in defaults)",
  },
  {
    key: "W",
    type: PropertyType.INT,
    label: "Width",
    defaultValue: 1e-6,
    description: "Channel width in meters",
  },
  {
    key: "L",
    type: PropertyType.INT,
    label: "Length",
    defaultValue: 1e-6,
    description: "Channel length in meters",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const MOSFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "model",
    propertyKey: "model",
    convert: (v) => v,
  },
  {
    xmlName: "W",
    propertyKey: "W",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "L",
    propertyKey: "L",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

function nmosCircuitFactory(props: PropertyBag): NmosfetElement {
  return new NmosfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function pmosCircuitFactory(props: PropertyBag): PmosfetElement {
  return new PmosfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NmosfetDefinition: ComponentDefinition = {
  name: "NMOS",
  typeId: -1,
  factory: nmosCircuitFactory,
  pinLayout: buildNmosPinDeclarations(),
  propertyDefs: MOSFET_PROPERTY_DEFS,
  attributeMap: MOSFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "N-channel MOSFET — Level 2 model with body effect and channel-length modulation.\n" +
    "Pins: D (drain), G (gate), S (source).\n" +
    "Model parameters: VTO, KP, LAMBDA, PHI, GAMMA, W, L.",
  models: {
    analog: {
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props),
      deviceType: "NMOS",
    },
  },
};

export const PmosfetDefinition: ComponentDefinition = {
  name: "PMOS",
  typeId: -1,
  factory: pmosCircuitFactory,
  pinLayout: buildPmosPinDeclarations(),
  propertyDefs: MOSFET_PROPERTY_DEFS,
  attributeMap: MOSFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "P-channel MOSFET — Level 2 model with body effect and channel-length modulation (PMOS polarity).\n" +
    "Pins: D (drain), G (gate), S (source).\n" +
    "Model parameters: VTO, KP, LAMBDA, PHI, GAMMA, W, L.",
  models: {
    analog: {
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      deviceType: "PMOS",
    },
  },
};
