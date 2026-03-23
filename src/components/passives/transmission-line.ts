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
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, IntegrationMethod } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
  inductorConductance,
  inductorHistoryCurrent,
} from "../../analog/integration.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_CONDUCTANCE = 1e-12;
const SHORT_CIRCUIT_CONDUCTANCE = 1e9;

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped), 1-based → 0-based solver index
// ---------------------------------------------------------------------------

/** Stamp a conductance value into G-sub-matrix position (row, col). */
function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    solver.stamp(row - 1, col - 1, val);
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTransmissionLinePinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "Port1",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "Port2",
      defaultBitWidth: 1,
      position: { x: 6, y: 0 },
      isNegatable: false,
      isClockCapable: false,
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
    // Falstad: rect from (0,-1) to (6,0), pins at (0,0) and (6,0)
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 6,
      height: 1,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Falstad TransLineElm: filled rect between two conductors + outline
    // Top conductor at y=0 (pin level), bottom conductor at y=-1
    // Left end x=0, right end x=6

    // Filled rectangle between the two conductors
    ctx.drawRect(0, -1, 6, 1, true);

    // Top conductor line
    ctx.drawLine(0, 0, 6, 0);

    // Bottom conductor line
    ctx.drawLine(0, -1, 6, -1);

    // Left end cap
    ctx.drawLine(0, 0, 0, -1);

    // Right end cap
    ctx.drawLine(6, 0, 6, -1);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Lossy Transmission Line — lumped RLCG model.\n" +
      "N cascaded segments with series RL and shunt GC."
    );
  }
}

// ---------------------------------------------------------------------------
// SegmentResistorElement — series R within one segment
// ---------------------------------------------------------------------------

class SegmentResistorElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = false;

  private readonly G: number;

  constructor(nA: number, nB: number, resistance: number) {
    this.nodeIndices = [nA, nB];
    this.G = resistance > 0 ? 1 / resistance : SHORT_CIRCUIT_CONDUCTANCE;
  }

  stamp(solver: SparseSolver): void {
    stampG(solver, this.nodeIndices[0], this.nodeIndices[0], this.G);
    stampG(solver, this.nodeIndices[0], this.nodeIndices[1], -this.G);
    stampG(solver, this.nodeIndices[1], this.nodeIndices[0], -this.G);
    stampG(solver, this.nodeIndices[1], this.nodeIndices[1], this.G);
  }
}

// ---------------------------------------------------------------------------
// SegmentShuntConductanceElement — shunt G from junction to GND
// ---------------------------------------------------------------------------

class SegmentShuntConductanceElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = false;

  private readonly G: number;

  constructor(node: number, G: number) {
    this.nodeIndices = [node, 0];
    this.G = Math.max(G, MIN_CONDUCTANCE);
  }

  stamp(solver: SparseSolver): void {
    stampG(solver, this.nodeIndices[0], this.nodeIndices[0], this.G);
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
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;

  private readonly L: number;
  private geq: number = 0;
  private ieq: number = 0;
  private iPrev: number = 0;
  private companionActive: boolean = false;

  constructor(nA: number, nB: number, branchIdx: number, inductance: number) {
    this.nodeIndices = [nA, nB];
    this.branchIndex = branchIdx;
    this.L = inductance;
  }

  stamp(solver: SparseSolver): void {
    const nA = this.nodeIndices[0];
    const nB = this.nodeIndices[1];
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
    const v0 = this.nodeIndices[0] > 0 ? voltages[this.nodeIndices[0] - 1] : 0;
    const v1 = this.nodeIndices[1] > 0 ? voltages[this.nodeIndices[1] - 1] : 0;
    const vNow = v0 - v1;

    this.geq = inductorConductance(this.L, dt, method);
    this.ieq = inductorHistoryCurrent(this.L, dt, method, iNow, this.iPrev, vNow);

    this.iPrev = iNow;
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
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;

  private readonly C: number;
  private geq: number = 0;
  private ieq: number = 0;
  private vPrev: number = 0;

  constructor(node: number, capacitance: number) {
    this.nodeIndices = [node, 0];
    this.C = capacitance;
  }

  stamp(solver: SparseSolver): void {
    const n0 = this.nodeIndices[0];
    if (n0 !== 0) {
      solver.stamp(n0 - 1, n0 - 1, this.geq);
      solver.stampRHS(n0 - 1, -this.ieq);
    }
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const n0 = this.nodeIndices[0];
    const vNow = n0 > 0 ? voltages[n0 - 1] : 0;
    const iNow = this.geq * vNow + this.ieq;

    this.geq = capacitorConductance(this.C, dt, method);
    this.ieq = capacitorHistoryCurrent(this.C, dt, method, vNow, this.vPrev, iNow);
    this.vPrev = vNow;
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
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;

  private readonly R: number;
  private readonly L: number;
  private geqL: number = 0;
  private ieq: number = 0;
  private iPrev: number = 0;
  private companionActive: boolean = false;

  constructor(nA: number, nB: number, branchIdx: number, resistance: number, inductance: number) {
    this.nodeIndices = [nA, nB];
    this.branchIndex = branchIdx;
    this.R = resistance;
    this.L = inductance;
  }

  stamp(solver: SparseSolver): void {
    const nA = this.nodeIndices[0];
    const nB = this.nodeIndices[1];
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
    const v0 = this.nodeIndices[0] > 0 ? voltages[this.nodeIndices[0] - 1] : 0;
    const v1 = this.nodeIndices[1] > 0 ? voltages[this.nodeIndices[1] - 1] : 0;
    const vNow = v0 - v1;

    this.geqL = inductorConductance(this.L, dt, method);
    this.ieq = inductorHistoryCurrent(this.L, dt, method, iNow, this.iPrev, vNow);

    this.iPrev = iNow;
  }
}

// ---------------------------------------------------------------------------
// TransmissionLineElement — composite AnalogElement
// ---------------------------------------------------------------------------

export class TransmissionLineElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;

  private readonly _subElements: AnalogElement[];

  constructor(
    nodeIds: number[],
    firstBranchIdx: number,
    z0: number,
    delay: number,
    lossDb: number,
    length: number,
    segments: number,
  ) {
    this.nodeIndices = nodeIds;
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
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

function createTransmissionLineElement(
  nodeIds: number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const z0 = props.getOrDefault<number>("impedance", 50);
  const delay = props.getOrDefault<number>("delay", 1e-9);
  const lossDb = props.getOrDefault<number>("lossPerMeter", 0);
  const length = props.getOrDefault<number>("length", 1.0);
  const segments = props.getOrDefault<number>("segments", 10);

  return new TransmissionLineElement(nodeIds, branchIdx, z0, delay, lossDb, length, segments);
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
  engineType: "analog",
  factory: transmissionLineCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildTransmissionLinePinDeclarations(),
  propertyDefs: TRANSMISSION_LINE_PROPERTY_DEFS,
  attributeMap: TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Lossy Transmission Line — lumped RLCG model.\n" +
    "N cascaded segments with series RL and shunt GC. " +
    "Parameterised by Z\u2080, propagation delay, loss, and segment count.",
  analogFactory: createTransmissionLineElement,
  requiresBranchRow: true,
  getInternalNodeCount: (props: PropertyBag): number => {
    const N = props.getOrDefault<number>("segments", 10);
    return (N - 1) * 2;
  },
};
