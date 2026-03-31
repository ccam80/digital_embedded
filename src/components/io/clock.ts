/**
 * Clock component — periodic signal source or manual toggle.
 *
 * When autoRun is true (default), the ClockManager toggles the output
 * automatically at the configured frequency. When autoRun is false, the
 * clock behaves like a manual digital input — user clicks to toggle.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { squareWaveBreakpoints } from "../sources/ac-voltage-source.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// COMP_WIDTH and COMP_HEIGHT removed (unused)

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildClockPinDeclarations(): PinDeclaration[] {
  // Java ClockShape: pin at (0, 0), body extends to -x.
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: true,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// ClockElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ClockElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Clock", instanceId, position, rotation, mirror, props);
  }

  get frequency(): number {
    return this._properties.getOrDefault<number>("Frequency", 1);
  }

  get autoRun(): boolean {
    return this._properties.getOrDefault<boolean>("autoRun", true);
  }

  get runRealTime(): boolean {
    return this._properties.getOrDefault<boolean>("runRealTime", false);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildClockPinDeclarations(), ["out"]);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 1.55,
      y: this.position.y - 0.75,
      width: 1.55,
      height: 1.5,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();

    ctx.save();

    // Body rectangle: (-1.55,-0.75) → (-0.05,0.75), closed, NORMAL — same as In
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon([
      { x: -1.55, y: -0.75 },
      { x: -0.05, y: -0.75 },
      { x: -0.05, y:  0.75 },
      { x: -1.55, y:  0.75 },
    ], true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon([
      { x: -1.55, y: -0.75 },
      { x: -0.05, y: -0.75 },
      { x: -0.05, y:  0.75 },
      { x: -1.55, y:  0.75 },
    ], false);

    // Clock waveform (open polyline, THIN): square wave inside the box
    // Points: (-1.25,0.25)→(-1,0.25)→(-1,-0.25)→(-0.75,-0.25)→(-0.75,0.25)→(-0.5,0.25)→(-0.5,-0.25)→(-0.25,-0.25)
    ctx.setLineWidth(0.5);
    const pts = [
      { x: -1.25, y:  0.25 },
      { x: -1.00, y:  0.25 },
      { x: -1.00, y: -0.25 },
      { x: -0.75, y: -0.25 },
      { x: -0.75, y:  0.25 },
      { x: -0.50, y:  0.25 },
      { x: -0.50, y: -0.25 },
      { x: -0.25, y: -0.25 },
    ];
    for (let i = 0; i < pts.length - 1; i++) {
      ctx.drawLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }

    // Label to the left, right-aligned
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(label, -2.25, 0, {
      horizontal: "right",
      vertical: "middle",
    });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeClock — no-op (clock value managed by ClockManager)
// ---------------------------------------------------------------------------

export function executeClock(_index: number, _state: Uint32Array, _highZs: Uint32Array, _layout: ComponentLayout): void {
  // Clock output is set externally by the engine's ClockManager.
}

// ---------------------------------------------------------------------------
// CLOCK_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const CLOCK_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Frequency",
    propertyKey: "Frequency",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "autoRun",
    propertyKey: "autoRun",
    convert: (v) => v === "true",
  },
  {
    xmlName: "runRealTime",
    propertyKey: "runRealTime",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CLOCK_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown on the component",
  },
  {
    key: "Frequency",
    type: PropertyType.INT,
    label: "Frequency",
    defaultValue: 1,
    min: 1,
    description: "Clock frequency (cycles per simulation step, or Hz in real-time mode)",
  },
  {
    key: "autoRun",
    type: PropertyType.BOOLEAN,
    label: "Auto-run",
    defaultValue: true,
    description: "When true, clock toggles automatically at the configured frequency. When false, acts as a manual digital input.",
  },
  {
    key: "runRealTime",
    type: PropertyType.BOOLEAN,
    label: "Real-time",
    defaultValue: false,
    description: "When true, frequency is in Hz and corresponds to wall-clock time",
  },
  {
    key: "vdd",
    type: PropertyType.INT,
    label: "VDD (V)",
    defaultValue: 3.3,
    description: "Logic high voltage in analog mode (volts). Default: 3.3V (CMOS).",
  },
];

// ---------------------------------------------------------------------------
// ClockDefinition
// ---------------------------------------------------------------------------

function clockFactory(props: PropertyBag): ClockElement {
  return new ClockElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// Analog clock element factory
// ---------------------------------------------------------------------------

export interface AnalogClockElement extends AnalogElementCore {
  /** Returns edge breakpoints within [tStart, tEnd] for the timestep controller. */
  getBreakpoints(tStart: number, tEnd: number): number[];
}

function createAnalogClockElement(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  frequency: number,
  _vdd: number,
  addBreakpoint?: (t: number) => void,
): AnalogClockElement {
  void (1 / frequency); // period unused

  const element: AnalogClockElement = {
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},

    setSourceScale(_factor: number): void {
      // Square wave, no source stepping needed.
    },

    stamp(solver: SparseSolver): void {
      // Value is computed by the engine each timestep; we stamp the incidence only.
      // The actual voltage value is handled via getBreakpoints + engine time tracking.
      // For analog stamping we use the voltage source stamp (same as DC source).
      const k = branchIdx;
      if (nodePos !== 0) solver.stamp(nodePos - 1, k, 1);
      if (nodeNeg !== 0) solver.stamp(nodeNeg - 1, k, -1);
      if (nodePos !== 0) solver.stamp(k, nodePos - 1, 1);
      if (nodeNeg !== 0) solver.stamp(k, nodeNeg - 1, -1);
      // RHS is set by the engine's time-domain loop; we leave it for the engine.
      // Here we provide the value via stampWithTime below.
    },

    getBreakpoints(tStart: number, tEnd: number): number[] {
      const pts = squareWaveBreakpoints(frequency, 0, tStart, tEnd);
      if (addBreakpoint !== undefined) {
        for (const t of pts) addBreakpoint(t);
      }
      return pts;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const I = voltages[branchIdx];
      return [-I];
    },
  };

  return element;
}

/**
 * Create an analog clock element that stamps a square-wave voltage source.
 * Used by the engine's time-domain loop; the RHS value is set per timestep
 * via the returned `stampAtTime` method.
 */
export function makeAnalogClockElement(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  frequency: number,
  vdd: number,
): AnalogClockElement & { stampAtTime(solver: SparseSolver, t: number): void } {
  const halfPeriod = 1 / (2 * frequency);
  const inner = createAnalogClockElement(nodePos, nodeNeg, branchIdx, frequency, vdd);

  return {
    ...inner,
    stamp(solver: SparseSolver): void {
      // Base stamp (incidence only) — engine calls stampAtTime with current time.
      inner.stamp(solver);
    },
    stampAtTime(solver: SparseSolver, t: number): void {
      const k = branchIdx;
      const halfPeriods = Math.floor(t / halfPeriod);
      const v = halfPeriods % 2 === 0 ? vdd : 0;
      solver.stampRHS(k, v);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout: [out] � positive terminal; negative terminal is implicit ground.
      // Branch current I = voltages[branchIdx] flows from neg to pos through source.
      // Current INTO element at out = -I (conventional: exits at positive terminal).
      const I = voltages[branchIdx];
      return [-I];
    },
  };
}

// ---------------------------------------------------------------------------
// ClockDefinition
// ---------------------------------------------------------------------------

export const ClockDefinition: ComponentDefinition = {
  name: "Clock",
  typeId: -1,
  factory: clockFactory,
  pinLayout: buildClockPinDeclarations(),
  propertyDefs: CLOCK_PROPERTY_DEFS,
  attributeMap: CLOCK_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Clock — periodic signal source.\n" +
    "Generates a square wave at the configured frequency.\n" +
    "In real-time mode the frequency corresponds to actual Hz. " +
    "The signal value is managed by ClockManager and set externally.",
  models: {
    digital: { executeFn: executeClock, inputSchema: [], outputSchema: ["out"] },
  },
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory(
        pinNodes: ReadonlyMap<string, number>,
        _internalNodeIds: readonly number[],
        branchIdx: number,
        props: PropertyBag,
        _getTime: () => number,
      ): AnalogElementCore {
        const frequency = props.getOrDefault<number>("Frequency", 1);
        const vdd = props.getOrDefault<number>("vdd", 3.3);
        const nodePos = pinNodes.get("out")!;
        const nodeNeg = 0;
        return makeAnalogClockElement(nodePos, nodeNeg, branchIdx, frequency, vdd);
      },
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
