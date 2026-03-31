/**
 * Lossy Transmission Line — lumped RLCG model.
 *
 * Models a transmission line as N cascaded RLCG segments. Each segment has:
 *   - Series resistance R_seg (conductor loss)
 *   - Series inductance L_seg (magnetic storage)
 *   - Shunt conductance G_seg (dielectric loss)
 *   - Shunt capacitance C_seg (electric storage)
 *
 * High-level user parameters (Z₀, τ, loss per metre, length, segment count N)
 * are converted to per-segment RLCG values at instantiation.
 *
 * Internal topology for N segments (segments 0..N-2 have a mid-node):
 *
 *   Port1 ─R─L─ junction[0] ─R─L─ junction[1] ─ ... ─R─L─ Port2
 *                   |                  |
 *                  G,C                G,C
 *                   |                  |
 *                  GND               GND
 *
 * Segments 0..N-2: inputNode → R → rlMid[k] → L → junction[k], shunt G+C at junction[k]
 * Segment N-1 (last): junction[N-2] → CombinedRL → Port2 (no shunt at Port2)
 *
 * Internal node allocation (matches getInternalNodeCount = 2*(N-1)):
 *   nodeIds[0]             = Port1 (external)
 *   nodeIds[1]             = Port2 (external)
 *   nodeIds[2..N]          = N-1 RL mid-nodes (rlMidNodes[0..N-2])
 *   nodeIds[N+1..2N-1]     = N-1 junction nodes (junctionNodes[0..N-2])
 *
 * Branch variables: N consecutive indices starting at firstBranchIdx (one per inductor).
 *
 * MNA stamp conventions:
 *   Inductor with nodes A, B, branch row k:
 *     B sub-matrix: G[A-1, k] += 1,  G[B-1, k] -= 1   (KCL: I_k flows A→B)
 *     C sub-matrix: G[k, A-1] += ..., G[k, B-1] -= ... (KVL + companion)
 *     D sub-matrix: G[k, k] -= geq
 *     RHS[k] += ieq
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG } from "../../solver/analog/stamp-helpers.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
  inductorConductance,
  inductorHistoryCurrent,
} from "../../solver/analog/integration.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_CONDUCTANCE = 1e-12;
const SHORT_CIRCUIT_CONDUCTANCE = 1e9;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRANSMISSION_LINE_PARAM_DEFS, defaults: TRANSMISSION_LINE_DEFAULTS } = defineModelParams({
  primary: {
    impedance:    { default: 50,    description: "Characteristic impedance Z\u2080 in ohms", min: 1 },
    delay:        { default: 1e-9,  unit: "s", description: "Total one-way propagation delay in seconds", min: 1e-15 },
  },
  secondary: {
    lossPerMeter: { default: 0,     description: "Conductor and dielectric loss in dB per metre", min: 0 },
    length:       { default: 1.0,   description: "Physical length of the transmission line in metres", min: 1e-6 },
    segments:     { default: 10,    description: "Number of lumped RLCG segments (more segments = more accurate, slower)", min: 2, max: 100 },
  },
});

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped), 1-based → 0-based solver index
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTransmissionLinePinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "P1b",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P2b",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P1a",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P2a",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// TransmissionLineCircuitElement — CircuitElement for rendering
// ---------------------------------------------------------------------------

export class TransmissionLineCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("TransmissionLine", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTransmissionLinePinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Falstad: fillRect(0, 0, 66, 18) px → (0,0) to (4.125, 1.125) grid units
    // Component spans from top rail (y=0) to bottom rail (y=1), x from 0 to 4
    return {
      x: this.position.x,
      y: this.position.y,
      width: 4,
      height: 1,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");

    // Falstad TransLineElm: ladder network symbol
    // 4 zero-length thick dot lines at pin corners (fixture order: P1b, P2b, P1a, P2a)
    ctx.setLineWidth(2);
    ctx.drawLine(0, 1, 0, 1); // P1b
    ctx.drawLine(4, 1, 4, 1); // P2b
    ctx.drawLine(0, 0, 0, 0); // P1a
    ctx.drawLine(4, 0, 4, 0); // P2a

    // 32 iterations: thin vertical rung + thick horizontal top segment
    const step = 2 / 16; // 0.125 grid units (2px ÷ 16)
    for (let i = 0; i <= 31; i++) {
      const x = i * step;
      // Thin vertical rung from bottom rail to top rail
      ctx.setLineWidth(1);
      ctx.drawLine(x, 1, x, 0);
      // Thick horizontal top conductor segment
      ctx.setLineWidth(2);
      ctx.drawLine(x, 0, x + step, 0);
    }

    // Thick bottom conductor (full width)
    ctx.setLineWidth(2);
    ctx.drawLine(0, 1, 4, 1);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// SegmentResistorElement — series R within one segment
// ---------------------------------------------------------------------------

class SegmentResistorElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = false;
  setParam(_key: string, _value: number): void {}

  private readonly G: number;

  constructor(nA: number, nB: number, resistance: number) {
    this.pinNodeIds = [nA, nB];
    this.allNodeIds = [nA, nB];
    this.G = resistance > 0 ? 1 / resistance : SHORT_CIRCUIT_CONDUCTANCE;
  }

  stamp(solver: SparseSolver): void {
    stampG(solver, this.pinNodeIds[0], this.pinNodeIds[0], this.G);
    stampG(solver, this.pinNodeIds[0], this.pinNodeIds[1], -this.G);
    stampG(solver, this.pinNodeIds[1], this.pinNodeIds[0], -this.G);
    stampG(solver, this.pinNodeIds[1], this.pinNodeIds[1], this.G);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const vA = nA > 0 ? voltages[nA - 1] : 0;
    const vB = nB > 0 ? voltages[nB - 1] : 0;
    const I = this.G * (vA - vB);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// SegmentShuntConductanceElement — shunt G from junction to GND
// ---------------------------------------------------------------------------

class SegmentShuntConductanceElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = false;
  setParam(_key: string, _value: number): void {}

  private readonly G: number;

  constructor(node: number, G: number) {
    this.pinNodeIds = [node, 0];
    this.allNodeIds = [node, 0];
    this.G = Math.max(G, MIN_CONDUCTANCE);
  }

  stamp(solver: SparseSolver): void {
    stampG(solver, this.pinNodeIds[0], this.pinNodeIds[0], this.G);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const n0 = this.pinNodeIds[0];
    const v = n0 > 0 ? voltages[n0 - 1] : 0;
    const I = this.G * v;
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// SegmentInductorElement — series L with proper B+C MNA stamp
//
// Uses explicit B-sub-matrix stamping so the inductor branch current appears
// in KCL equations at both nodes. This avoids singularity at DC (geq=0).
//
// DC model (before first stampCompanion, companionActive=false):
//   B sub-matrix: G[nA-1, b] += 1, G[nB-1, b] -= 1
//   C sub-matrix: G[b, nA-1] = 1, G[b, nB-1] = -1
//   (enforces V_A = V_B — short circuit at DC)
//
// Transient model (after stampCompanion):
//   G-block:  geq contribution (conductance equivalent of companion model)
//   B sub-matrix: I_b flows into nA, out of nB
//   C sub-matrix: V_A - V_B - geq*I_b = ieq
// ---------------------------------------------------------------------------

class SegmentInductorElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  setParam(_key: string, _value: number): void {}

  private readonly L: number;
  private geq: number = 0;
  private ieq: number = 0;
  private iPrev: number = 0;

  constructor(nA: number, nB: number, branchIdx: number, inductance: number) {
    this.pinNodeIds = [nA, nB];
    this.allNodeIds = [nA, nB];
    this.branchIndex = branchIdx;
    this.L = inductance;
  }

  stamp(solver: SparseSolver): void {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const b = this.branchIndex;

    // B sub-matrix: I_b flows into nA, out of nB (KCL at both nodes).
    if (nA !== 0) solver.stamp(nA - 1, b, 1);
    if (nB !== 0) solver.stamp(nB - 1, b, -1);

    // C sub-matrix: branch equation V_A - V_B - geq*I_b = ieq
    // When geq=0 this reduces to V_A = V_B (short circuit at DC).
    if (nA !== 0) solver.stamp(b, nA - 1, 1);
    if (nB !== 0) solver.stamp(b, nB - 1, -1);
    solver.stamp(b, b, -this.geq);
    solver.stampRHS(b, this.ieq);
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const iNow = voltages[this.branchIndex];
    const v0 = this.pinNodeIds[0] > 0 ? voltages[this.pinNodeIds[0] - 1] : 0;
    const v1 = this.pinNodeIds[1] > 0 ? voltages[this.pinNodeIds[1] - 1] : 0;
    const vNow = v0 - v1;

    this.geq = inductorConductance(this.L, dt, method);
    this.ieq = inductorHistoryCurrent(this.L, dt, method, iNow, this.iPrev, vNow);

    this.iPrev = iNow;
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const I = voltages[this.branchIndex];
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// SegmentCapacitorElement — shunt C from junction to GND
//
// Companion model: geq in parallel with ieq current source (Norton).
// RHS convention at node A: KCL requires the history current to push
// charge onto the node, so the sign is -ieq (current leaving node A via cap).
// ---------------------------------------------------------------------------

class SegmentCapacitorElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  setParam(_key: string, _value: number): void {}

  private readonly C: number;
  private geq: number = 0;
  private ieq: number = 0;
  private vPrev: number = 0;

  constructor(node: number, capacitance: number) {
    this.pinNodeIds = [node, 0];
    this.allNodeIds = [node, 0];
    this.C = capacitance;
  }

  stamp(solver: SparseSolver): void {
    const n0 = this.pinNodeIds[0];
    if (n0 !== 0) {
      solver.stamp(n0 - 1, n0 - 1, this.geq);
      solver.stampRHS(n0 - 1, -this.ieq);
    }
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const n0 = this.pinNodeIds[0];
    const vNow = n0 > 0 ? voltages[n0 - 1] : 0;
    const iNow = this.geq * vNow + this.ieq;

    this.geq = capacitorConductance(this.C, dt, method);
    this.ieq = capacitorHistoryCurrent(this.C, dt, method, vNow, this.vPrev, iNow);
    this.vPrev = vNow;
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const n0 = this.pinNodeIds[0];
    const v = n0 > 0 ? voltages[n0 - 1] : 0;
    const I = this.geq * v + this.ieq;
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// CombinedRLElement — series R + L with proper B+C MNA stamp (no mid-node)
//
// Used for the last segment. The series R is absorbed into the branch equation:
//   V_A - V_B = (R + geqL) * I_b - ieq
//
// DC model: enforces V_A = V_B (short circuit). R is included in the branch
// diagonal only during transient.
// ---------------------------------------------------------------------------

class CombinedRLElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  setParam(_key: string, _value: number): void {}

  private readonly R: number;
  private readonly L: number;
  private geqL: number = 0;
  private ieq: number = 0;
  private iPrev: number = 0;

  constructor(nA: number, nB: number, branchIdx: number, resistance: number, inductance: number) {
    this.pinNodeIds = [nA, nB];
    this.allNodeIds = [nA, nB];
    this.branchIndex = branchIdx;
    this.R = resistance;
    this.L = inductance;
  }

  stamp(solver: SparseSolver): void {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const b = this.branchIndex;

    // B sub-matrix: I_b flows into nA, out of nB.
    if (nA !== 0) solver.stamp(nA - 1, b, 1);
    if (nB !== 0) solver.stamp(nB - 1, b, -1);

    // C sub-matrix: branch equation V_A - V_B - (R + geqL)*I_b = ieq
    // When geqL=0 and R=0 this reduces to V_A = V_B (short circuit at DC).
    if (nA !== 0) solver.stamp(b, nA - 1, 1);
    if (nB !== 0) solver.stamp(b, nB - 1, -1);
    solver.stamp(b, b, -(this.R + this.geqL));
    solver.stampRHS(b, this.ieq);
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const iNow = voltages[this.branchIndex];
    const v0 = this.pinNodeIds[0] > 0 ? voltages[this.pinNodeIds[0] - 1] : 0;
    const v1 = this.pinNodeIds[1] > 0 ? voltages[this.pinNodeIds[1] - 1] : 0;
    const vNow = v0 - v1;

    this.geqL = inductorConductance(this.L, dt, method);
    this.ieq = inductorHistoryCurrent(this.L, dt, method, iNow, this.iPrev, vNow);

    this.iPrev = iNow;
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const I = voltages[this.branchIndex];
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// TransmissionLineElement — composite AnalogElement
// ---------------------------------------------------------------------------

export class TransmissionLineElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  setParam(_key: string, _value: number): void {}

  private readonly _subElements: AnalogElement[];
  /** Branch index of the last segment's CombinedRL element. */
  private readonly _lastBranchIdx: number;
  /** Branch index of the first segment's inductor (= firstBranchIdx). */
  private readonly _firstBranchIdx: number;

  constructor(
    nodeIds: number[],
    firstBranchIdx: number,
    z0: number,
    delay: number,
    lossDb: number,
    length: number,
    segments: number,
  ) {
    this.pinNodeIds = nodeIds;
    this.allNodeIds = nodeIds;
    this.branchIndex = firstBranchIdx;

    const N = segments;

    // Per-segment L and C derived from transmission line parameters.
    // L_total = Z₀ × τ,  C_total = τ / Z₀
    // Divide by N for per-segment values (length factor already in τ).
    const lSeg = (z0 * delay) / N;
    const cSeg = delay / (z0 * N);

    // Convert dB/m loss to per-segment R and G.
    // α (Np/m) = lossDb × ln(10) / 20
    // R ≈ 2α Z₀ per unit length,  G ≈ 2α / Z₀ per unit length
    let rSeg = 0;
    let gSeg = 0;
    if (lossDb > 0) {
      const alphaNpPerM = (lossDb * Math.LN10) / 20;
      rSeg = (2 * alphaNpPerM * z0 * length) / N;
      gSeg = (2 * alphaNpPerM * length) / (z0 * N);
    }

    // Internal node layout (2*(N-1) nodes total):
    //   rlMidNodes[k]     = nodeIds[2 + k]            for k = 0..N-2
    //   junctionNodes[k]  = nodeIds[2 + (N-1) + k]    for k = 0..N-2
    const rlMidNodes: number[] = [];
    const junctionNodes: number[] = [];
    for (let k = 0; k < N - 1; k++) {
      rlMidNodes.push(nodeIds[2 + k]);
      junctionNodes.push(nodeIds[2 + (N - 1) + k]);
    }

    this._subElements = [];

    for (let k = 0; k < N; k++) {
      const inputNode = k === 0 ? nodeIds[0] : junctionNodes[k - 1];
      const branchIdxForL = firstBranchIdx + k;

      if (k < N - 1) {
        const rlMid = rlMidNodes[k];
        const junctionNode = junctionNodes[k];

        // Series R: inputNode → rlMid
        this._subElements.push(new SegmentResistorElement(inputNode, rlMid, rSeg));

        // Series L: rlMid → junctionNode
        this._subElements.push(
          new SegmentInductorElement(rlMid, junctionNode, branchIdxForL, lSeg),
        );

        // Shunt G: junctionNode → GND (lossy only)
        if (gSeg > 0) {
          this._subElements.push(new SegmentShuntConductanceElement(junctionNode, gSeg));
        }

        // Shunt C: junctionNode → GND
        this._subElements.push(new SegmentCapacitorElement(junctionNode, cSeg));
      } else {
        // Last segment: combined RL to Port2, no shunt at Port2.
        this._subElements.push(
          new CombinedRLElement(inputNode, nodeIds[1], branchIdxForL, rSeg, lSeg),
        );
      }
    }

    // Branch indices for getPinCurrents.
    this._firstBranchIdx = firstBranchIdx;
    this._lastBranchIdx = firstBranchIdx + N - 1;
  }

  stamp(solver: SparseSolver): void {
    for (const el of this._subElements) {
      el.stamp(solver);
    }
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    for (const el of this._subElements) {
      if (el.isReactive && el.stampCompanion) {
        el.stampCompanion(dt, method, voltages);
      }
    }
  }

  /**
   * Per-pin currents for the 4 external pins in pinLayout order:
   *   [0] P1b — Port1 high side
   *   [1] P2b — Port2 high side
   *   [2] P1a — Port1 return (ground side)
   *   [3] P2a — Port2 return (ground side)
   *
   * Current into Port1 = branch current of first segment's inductor (rlMid0 → junction0).
   * The series R and L in segment 0 are in series, so I_R = I_L = I_firstBranch.
   * This holds for both lossless (R=0) and lossy cases.
   *
   * Current into Port2 = -I_lastBranch: the last CombinedRL branch current flows
   * from the last junction INTO Port2 (nA→nB), so it exits the element externally
   * at Port2 → negative from the element's perspective.
   *
   * P1a and P2a are the ground-return pins: they carry the equal-and-opposite
   * return current relative to their corresponding high-side pin.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    // First segment inductor branch current = current entering Port1 from external.
    const iPort1 = voltages[this._firstBranchIdx];

    // Last CombinedRL branch flows from last junction → Port2 (exits externally).
    const iPort2 = -voltages[this._lastBranchIdx];

    // Return pins carry equal-and-opposite ground return current.
    return [iPort1, iPort2, -iPort1, -iPort2];
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

function buildTransmissionLineElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  impedance: number,
  delay: number,
  lossPerMeter: number,
  length: number,
  segments: number,
): AnalogElementCore {
  const p = { impedance, delay, lossPerMeter, length, segments };
  const nodeIds = [
    pinNodes.get("P1b")!,
    pinNodes.get("P2b")!,
    ...internalNodeIds,
  ];
  const el = new TransmissionLineElement(nodeIds, branchIdx, p.impedance, p.delay, p.lossPerMeter, p.length, p.segments);
  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
    }
  };
  return el;
}

function createTransmissionLineElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  return buildTransmissionLineElement(
    pinNodes,
    internalNodeIds,
    branchIdx,
    props.getModelParam<number>("impedance"),
    props.getModelParam<number>("delay"),
    props.getModelParam<number>("lossPerMeter"),
    props.getModelParam<number>("length"),
    props.getModelParam<number>("segments"),
  );
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRANSMISSION_LINE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "impedance",
    type: PropertyType.FLOAT,
    label: "Characteristic Impedance (\u03A9)",
    defaultValue: 50,
    min: 1,
    description: "Characteristic impedance Z\u2080 in ohms",
  },
  {
    key: "delay",
    type: PropertyType.FLOAT,
    label: "Propagation Delay (s)",
    unit: "s",
    defaultValue: 1e-9,
    min: 1e-15,
    description: "Total one-way propagation delay in seconds",
  },
  {
    key: "lossPerMeter",
    type: PropertyType.FLOAT,
    label: "Loss (dB/m)",
    defaultValue: 0,
    min: 0,
    description: "Conductor and dielectric loss in dB per metre",
  },
  {
    key: "length",
    type: PropertyType.FLOAT,
    label: "Length (m)",
    defaultValue: 1.0,
    min: 1e-6,
    description: "Physical length of the transmission line in metres",
  },
  {
    key: "segments",
    type: PropertyType.INT,
    label: "Segments (N)",
    defaultValue: 10,
    min: 2,
    max: 100,
    description: "Number of lumped RLCG segments (more segments = more accurate, slower)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown on the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "impedance",
    propertyKey: "impedance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "delay",
    propertyKey: "delay",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "lossPerMeter",
    propertyKey: "lossPerMeter",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "length",
    propertyKey: "length",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "segments",
    propertyKey: "segments",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// TransmissionLineDefinition
// ---------------------------------------------------------------------------

function transmissionLineCircuitFactory(props: PropertyBag): TransmissionLineCircuitElement {
  return new TransmissionLineCircuitElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const TransmissionLineDefinition: ComponentDefinition = {
  name: "TransmissionLine",
  typeId: -1,
  factory: transmissionLineCircuitFactory,
  pinLayout: buildTransmissionLinePinDeclarations(),
  propertyDefs: TRANSMISSION_LINE_PROPERTY_DEFS,
  attributeMap: TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Lossy Transmission Line — lumped RLCG model.\n" +
    "N cascaded segments with series RL and shunt GC. " +
    "Parameterised by Z\u2080, propagation delay, loss, and segment count.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTransmissionLineElement,
      paramDefs: TRANSMISSION_LINE_PARAM_DEFS,
      params: TRANSMISSION_LINE_DEFAULTS,
      branchCount: 1,
    },
  },
  defaultModel: "behavioral",
};
