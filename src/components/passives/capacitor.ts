/**
 * Capacitor analog component.
 *
 * Reactive two-terminal element modelled using companion model (equivalent
 * conductance + history current source). Implements updateCompanion() to
 * recompute geq and ieq at each timestep using one of three integration methods:
 * BDF-1, trapezoidal, or BDF-2.
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
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, IntegrationMethod } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "../../analog/integration.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildCapacitorPinDeclarations(): PinDeclaration[] {
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
      position: { x: 2, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// CapacitorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class CapacitorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("AnalogCapacitor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildCapacitorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 2,
      height: 1,
    };
  }

  draw(ctx: RenderContext): void {
    const capacitance = this._properties.getOrDefault<number>("capacitance", 1e-6);
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Lead lines
    ctx.drawLine(0, 0, 0.75, 0);
    ctx.drawLine(1.25, 0, 2, 0);

    // Two parallel plates at x=0.75 and x=1.25
    ctx.drawLine(0.75, -0.4, 0.75, 0.4);
    ctx.drawLine(1.25, -0.4, 1.25, 0.4);

    // Value label below body
    const displayLabel = label.length > 0 ? label : `${capacitance * 1e6}µF`;
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 1, 0.65, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Capacitor — reactive element with companion model.\n" +
      "Stamps equivalent conductance and history current source at each timestep."
    );
  }
}

// ---------------------------------------------------------------------------
// AnalogCapacitorElement — MNA implementation
// ---------------------------------------------------------------------------

// Stamp helpers — node 0 is ground (skipped), 1-based → 0-based solver index
function capStampG(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    solver.stamp(row - 1, col - 1, val);
  }
}

function capStampRHS(solver: SparseSolver, row: number, val: number): void {
  if (row !== 0) {
    solver.stampRHS(row - 1, val);
  }
}

class AnalogCapacitorElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;

  private readonly C: number;
  private geq: number = 0;
  private ieq: number = 0;
  private vPrev: number = 0;
  private vPrevPrev: number = 0;

  constructor(nodeIndices: number[], capacitance: number) {
    this.nodeIndices = nodeIndices;
    this.C = capacitance;
  }

  stamp(solver: SparseSolver): void {
    const n0 = this.nodeIndices[0];
    const n1 = this.nodeIndices[1];

    capStampG(solver, n0, n0, this.geq);
    capStampG(solver, n0, n1, -this.geq);
    capStampG(solver, n1, n0, -this.geq);
    capStampG(solver, n1, n1, this.geq);

    capStampRHS(solver, n0, this.ieq);
    capStampRHS(solver, n1, -this.ieq);
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const n0 = this.nodeIndices[0];
    const n1 = this.nodeIndices[1];
    const v0 = n0 > 0 ? voltages[n0 - 1] : 0;
    const v1 = n1 > 0 ? voltages[n1 - 1] : 0;
    const vNow = v0 - v1;
    const iNow = this.geq > 0 ? vNow * this.geq : 0;

    this.geq = capacitorConductance(this.C, dt, method);
    this.ieq = capacitorHistoryCurrent(this.C, dt, method, vNow, this.vPrev, iNow);

    this.vPrevPrev = this.vPrev;
    this.vPrev = vNow;
  }
}

function createCapacitorElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const C = props.getOrDefault<number>("capacitance", 1e-6);
  return new AnalogCapacitorElement(nodeIds, C);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CAPACITOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "capacitance",
    type: PropertyType.FLOAT,
    label: "Capacitance (F)",
    defaultValue: 1e-6,
    min: 1e-15,
    description: "Capacitance in farads",
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

export const CAPACITOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "capacitance",
    propertyKey: "capacitance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// CapacitorDefinition
// ---------------------------------------------------------------------------

function capacitorCircuitFactory(props: PropertyBag): CapacitorElement {
  return new CapacitorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const CapacitorDefinition: ComponentDefinition = {
  name: "AnalogCapacitor",
  typeId: -1,
  engineType: "analog",
  factory: capacitorCircuitFactory,
  executeFn: () => {},
  pinLayout: buildCapacitorPinDeclarations(),
  propertyDefs: CAPACITOR_PROPERTY_DEFS,
  attributeMap: CAPACITOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Capacitor — reactive element with companion model.\n" +
    "Stamps equivalent conductance and history current source at each timestep.",
  analogFactory: createCapacitorElement,
};
