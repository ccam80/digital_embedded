/**
 * Polarized electrolytic capacitor analog component.
 *
 * Extends the standard capacitor companion model with three additional effects:
 *   - ESR (equivalent series resistance): a series conductance between an
 *     internal node and the positive terminal
 *   - Leakage current: a parallel conductance across the full component
 *   - Polarity enforcement: emits a diagnostic when the anode voltage falls
 *     below the cathode voltage beyond a configurable reverse threshold
 *
 * Topology (MNA):
 *   pos ─── ESR ─── capNode ─── capacitor+leakage ─── neg
 *
 * Three MNA nodes are used:
 *   pinNodeIds[0] = n_pos  (positive terminal / anode)
 *   pinNodeIds[1] = n_neg  (negative terminal / cathode)
 *   pinNodeIds[2] = n_cap  (internal node between ESR and capacitor body)
 *
 * Linear elements stamped in stamp():
 *   - ESR conductance between n_pos and n_cap
 *   - Leakage conductance between n_cap and n_neg
 *   - Capacitor companion model (geq + ieq) between n_cap and n_neg
 *     (these coefficients change only at timestep boundaries, not every NR
 *     iteration — so they are safe to stamp in the linear pass)
 *
 * Polarity enforcement in updateOperatingPoint():
 *   - Called every NR iteration when isNonlinear === true
 *   - Emits a reverse-biased-cap diagnostic when V(pos) < V(neg) − reverseMax
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
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import type { SolverDiagnostic } from "../../core/analog-engine-interface.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "../../analog/integration.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPolarizedCapPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "pos",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// PolarizedCapElement — AbstractCircuitElement (editor/visual layer)
// ---------------------------------------------------------------------------

export class PolarizedCapElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PolarizedCap", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPolarizedCapPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.75,
      width: 4,
      height: 1.5 + 1e-10,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setLineWidth(1);

    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");
    const hasVoltage = vPos !== undefined && vNeg !== undefined;

    const PX = 1 / 16;
    const plateOffset = 28 * PX; // 1.75 — matches Falstad lead length (28px)

    // Left lead — colored by pos voltage
    if (hasVoltage && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vPos));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, plateOffset, 0);

    // Right lead — colored by neg voltage
    if (hasVoltage && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vNeg));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(4, 0, 4 - plateOffset, 0);

    // Plate 1 — straight line (positive/anode plate)
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(plateOffset, 0, 4 - plateOffset, 0, [
        { offset: 0, color: signals!.voltageColor(vPos) },
        { offset: 1, color: signals!.voltageColor(vNeg) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(plateOffset, -0.75, plateOffset, 0.75);

    // Plate 2 — curved (exact Falstad 7-segment polyline)
    // Falstad pixel coords: (41,-12),(37,-9),(36,-5),(36,-2),(36,2),(36,5),(37,9),(41,12)
    // Grid coords (÷16):   (2.5625,-0.75),(2.3125,-0.5625),(2.25,-0.3125),(2.25,-0.125),
    //                      (2.25,0.125),(2.25,0.3125),(2.3125,0.5625),(2.5625,0.75)
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(plateOffset, 0, 4 - plateOffset, 0, [
        { offset: 0, color: signals!.voltageColor(vPos) },
        { offset: 1, color: signals!.voltageColor(vNeg) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    const curvedPts: [number, number][] = [
      [2.5625, -0.75],
      [2.3125, -0.5625],
      [2.25, -0.3125],
      [2.25, -0.125],
      [2.25, 0.125],
      [2.25, 0.3125],
      [2.3125, 0.5625],
      [2.5625, 0.75],
    ];
    for (let i = 0; i < curvedPts.length - 1; i++) {
      ctx.drawLine(curvedPts[i][0], curvedPts[i][1], curvedPts[i + 1][0], curvedPts[i + 1][1]);
    }

    // Polarity marker "+" at anode side
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("+", 0.9375, 0.625, { horizontal: "center", vertical: "top" });

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 1.6875, -0.875, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Polarized electrolytic capacitor — extends the standard capacitor with ESR,\n" +
      "leakage current, and reverse-bias polarity enforcement."
    );
  }
}

// ---------------------------------------------------------------------------
// Stamp helpers
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
// AnalogPolarizedCapElement — MNA implementation
// ---------------------------------------------------------------------------

export class AnalogPolarizedCapElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = true;

  private readonly C: number;
  private readonly G_esr: number;
  private readonly G_leak: number;
  private readonly reverseMax: number;

  private geq: number = 0;
  private ieq: number = 0;
  private vPrev: number = 0;

  private readonly _emitDiagnostic: (diag: SolverDiagnostic) => void;
  private _reverseBiasDiagEmitted: boolean = false;

  /**
   * @param pinNodeIds    - [n_pos, n_neg, n_cap] — n_cap is the internal node
   * @param capacitance    - Capacitance in farads
   * @param esr            - Equivalent series resistance in ohms
   * @param rLeak          - Leakage resistance in ohms (V_rated / I_leak)
   * @param reverseMax     - Reverse voltage threshold in volts (positive value)
   * @param emitDiagnostic - Callback invoked when polarity violation is detected
   */
  constructor(
    pinNodeIds: number[],
    capacitance: number,
    esr: number,
    rLeak: number,
    reverseMax: number,
    emitDiagnostic?: (diag: SolverDiagnostic) => void,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.C = capacitance;
    this.G_esr = 1 / Math.max(esr, MIN_RESISTANCE);
    this.G_leak = 1 / Math.max(rLeak, MIN_RESISTANCE);
    this.reverseMax = reverseMax;
    this._emitDiagnostic = emitDiagnostic ?? (() => {});
  }

  stamp(solver: SparseSolver): void {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const nCap = this.pinNodeIds[2];

    // ESR: conductance between n_pos and n_cap
    stampG(solver, nPos, nPos, this.G_esr);
    stampG(solver, nPos, nCap, -this.G_esr);
    stampG(solver, nCap, nPos, -this.G_esr);
    stampG(solver, nCap, nCap, this.G_esr);

    // Leakage: conductance between n_cap and n_neg
    stampG(solver, nCap, nCap, this.G_leak);
    stampG(solver, nCap, nNeg, -this.G_leak);
    stampG(solver, nNeg, nCap, -this.G_leak);
    stampG(solver, nNeg, nNeg, this.G_leak);

    // Capacitor companion model: conductance + history current between n_cap and n_neg
    // RHS sign: -ieq at nCap, +ieq at nNeg (standard Norton convention: ieq = -geq*v(n))
    stampG(solver, nCap, nCap, this.geq);
    stampG(solver, nCap, nNeg, -this.geq);
    stampG(solver, nNeg, nCap, -this.geq);
    stampG(solver, nNeg, nNeg, this.geq);

    stampRHS(solver, nCap, -this.ieq);
    stampRHS(solver, nNeg, this.ieq);
  }

  stampNonlinear(_solver: SparseSolver): void {
    // No additional nonlinear stamps required.
    // Polarity violation detection occurs in updateOperatingPoint.
  }

  updateOperatingPoint(voltages: Float64Array): void {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];

    const vAnode = nPos > 0 ? voltages[nPos - 1] : 0;
    const vCathode = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const vDiff = vAnode - vCathode;

    if (vDiff < -this.reverseMax) {
      if (!this._reverseBiasDiagEmitted) {
        this._reverseBiasDiagEmitted = true;
        this._emitDiagnostic({
          code: "reverse-biased-cap",
          severity: "warning",
          summary: `Polarized capacitor reverse biased by ${(-vDiff).toFixed(2)} V (threshold: ${this.reverseMax} V)`,
          explanation:
            "Electrolytic capacitors are damaged by reverse bias. " +
            "Check circuit polarity and ensure the anode (positive terminal) " +
            "is at a higher potential than the cathode.",
          suggestions: [
            {
              text: "Reverse the capacitor polarity in the schematic.",
              automatable: false,
            },
          ],
        });
      }
    } else {
      this._reverseBiasDiagEmitted = false;
    }
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const nPos = this.pinNodeIds[0];
    const nCap = this.pinNodeIds[2];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vCap = nCap > 0 ? voltages[nCap - 1] : 0;
    // Current into pos pin = current through ESR flowing into the element
    const I = this.G_esr * (vPos - vCap);
    return [I, -I];
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const nCap = this.pinNodeIds[2];
    const nNeg = this.pinNodeIds[1];

    const vCapNode = nCap > 0 ? voltages[nCap - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const vNow = vCapNode - vNeg;

    // Recover capacitor current at previous accepted step from companion model.
    // On the first call geq=0 and ieq=0, so iNow=0 (correct: DC steady state).
    const iNow = this.geq * vNow + this.ieq;

    this.geq = capacitorConductance(this.C, dt, method);
    this.ieq = capacitorHistoryCurrent(this.C, dt, method, vNow, this.vPrev, iNow);
    this.vPrev = vNow;
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function createPolarizedCapElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const C = props.getOrDefault<number>("capacitance", 100e-6);
  const esr = props.getOrDefault<number>("esr", 0.1);
  const voltageRating = props.getOrDefault<number>("voltageRating", 25);
  const leakageCurrent = props.getOrDefault<number>("leakageCurrent", 1e-6);
  const rLeak = leakageCurrent > 0 ? voltageRating / leakageCurrent : 1e12;
  const reverseMax = props.getOrDefault<number>("reverseMax", 1.0);

  // nodeIds = [n_pos, n_neg, n_cap_internal] — compiler provides the internal node
  return new AnalogPolarizedCapElement(
    [pinNodes.get("pos")!, pinNodes.get("neg")!, internalNodeIds[0]],
    C,
    esr,
    rLeak,
    reverseMax,
  );
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POLARIZED_CAP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "capacitance",
    type: PropertyType.FLOAT,
    label: "Capacitance (F)",
    unit: "F",
    defaultValue: 100e-6,
    min: 1e-12,
    description: "Capacitance in farads",
  },
  {
    key: "esr",
    type: PropertyType.FLOAT,
    label: "ESR (Ω)",
    unit: "Ω",
    defaultValue: 0.1,
    min: 0,
    description: "Equivalent series resistance in ohms",
  },
  {
    key: "leakageCurrent",
    type: PropertyType.FLOAT,
    label: "Leakage Current (A)",
    unit: "A",
    defaultValue: 1e-6,
    min: 0,
    description: "DC leakage current at rated voltage",
  },
  {
    key: "voltageRating",
    type: PropertyType.FLOAT,
    label: "Voltage Rating (V)",
    unit: "V",
    defaultValue: 25,
    min: 1,
    description: "Maximum rated voltage",
  },
  {
    key: "reverseMax",
    type: PropertyType.FLOAT,
    label: "Reverse Threshold (V)",
    unit: "V",
    defaultValue: 1.0,
    min: 0,
    description: "Reverse voltage threshold that triggers a polarity warning",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown below the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const POLARIZED_CAP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "capacitance",
    propertyKey: "capacitance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "esr",
    propertyKey: "esr",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "leakageCurrent",
    propertyKey: "leakageCurrent",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "voltageRating",
    propertyKey: "voltageRating",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "reverseMax",
    propertyKey: "reverseMax",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// PolarizedCapDefinition
// ---------------------------------------------------------------------------

function polarizedCapCircuitFactory(props: PropertyBag): PolarizedCapElement {
  return new PolarizedCapElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PolarizedCapDefinition: ComponentDefinition = {
  name: "PolarizedCap",
  typeId: -1,
  engineType: "analog",
  factory: polarizedCapCircuitFactory,
  executeFn: () => {},
  pinLayout: buildPolarizedCapPinDeclarations(),
  propertyDefs: POLARIZED_CAP_PROPERTY_DEFS,
  attributeMap: POLARIZED_CAP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Polarized electrolytic capacitor — extends the standard capacitor with ESR,\n" +
    "leakage current, and reverse-bias polarity enforcement.",
  analogFactory: createPolarizedCapElement,
  getInternalNodeCount: () => 1,
};
