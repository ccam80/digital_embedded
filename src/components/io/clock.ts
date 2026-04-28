/**
 * Clock component  periodic signal source or manual toggle.
 *
 * When autoRun is true (default), the ClockManager toggles the output
 * automatically at the configured frequency. When autoRun is false, the
 * clock behaves like a manual digital input  user clicks to toggle.
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
import type { AnalogElement } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";

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
// ClockElement  CircuitElement implementation
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

    // Body rectangle: (-1.55,-0.75)  (-0.05,0.75), closed, NORMAL  same as In
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
    // Points: (-1.25,0.25)(-1,0.25)(-1,-0.25)(-0.75,-0.25)(-0.75,0.25)(-0.5,0.25)(-0.5,-0.25)(-0.25,-0.25)
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
// executeClock  no-op (clock value managed by ClockManager)
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

export interface AnalogClockElement extends AnalogElement {
  /** Returns edge breakpoints within [tStart, tEnd] for the timestep controller. */
  getBreakpoints(tStart: number, tEnd: number): number[];
  /** Returns the strictly-next breakpoint strictly after afterTime. Clock is infinite; never returns null. */
  nextBreakpoint(afterTime: number): number | null;
}

/**
 * Create an analog clock element that stamps a square-wave voltage source
 * via the unified load(ctx) interface.
 *
 * The clock's instantaneous value depends on the simulation time, which is
 * supplied via the getTime closure captured at construction. The engine
 * advances simulation time between accepted steps; load() reads it each
 * NR iteration and stamps V = vdd on even half-periods, V = 0 on odd ones.
 */
export function makeAnalogClockElement(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  frequency: number,
  vdd: number,
  getTime: () => number,
): AnalogClockElement & { stampAtTime(rhs: Float64Array, t: number): void } {
  const halfPeriod = 1 / (2 * frequency);

  let _hPosBranch = -1;
  let _hNegBranch = -1;
  let _hBranchPos = -1;
  let _hBranchNeg = -1;

  const el: AnalogClockElement & { stampAtTime(rhs: Float64Array, t: number): void } = {
    label: "",
    branchIndex: branchIdx,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,
    _stateBase: -1,
    _pinNodes: new Map<string, number>([["out", nodePos]]),

    setup(ctx: import("../../solver/analog/setup-context.js").SetupContext): void {
      if (el.branchIndex === -1) {
        el.branchIndex = ctx.makeCur(el.label, "branch");
      }
      const k = el.branchIndex;
      if (nodePos !== 0) _hPosBranch = ctx.solver.allocElement(nodePos, k);
      if (nodeNeg !== 0) _hNegBranch = ctx.solver.allocElement(nodeNeg, k);
      if (nodePos !== 0) _hBranchPos = ctx.solver.allocElement(k, nodePos);
      if (nodeNeg !== 0) _hBranchNeg = ctx.solver.allocElement(k, nodeNeg);
    },

    findBranchFor(_name: string, ctx: import("../../solver/analog/setup-context.js").SetupContext): number {
      if (el.branchIndex === -1) {
        el.branchIndex = ctx.makeCur(el.label, "branch");
      }
      return el.branchIndex;
    },

    setParam(_key: string, _value: number): void {
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const k = el.branchIndex;

      // Branch incidence (B and C sub-matrices) — handles allocated in setup().
      if (nodePos !== 0) solver.stampElement(_hPosBranch, 1);
      if (nodeNeg !== 0) solver.stampElement(_hNegBranch, -1);
      if (nodePos !== 0) solver.stampElement(_hBranchPos, 1);
      if (nodeNeg !== 0) solver.stampElement(_hBranchNeg, -1);

      // Square-wave voltage value at current simulation time.
      const t = getTime();
      const halfPeriods = Math.floor(t / halfPeriod);
      const v = halfPeriods % 2 === 0 ? vdd : 0;
      stampRHS(ctx.rhs, k, v * ctx.srcFact);
    },

    stampAtTime(rhs: Float64Array, t: number): void {
      const k = el.branchIndex;
      const halfPeriods = Math.floor(t / halfPeriod);
      const v = halfPeriods % 2 === 0 ? vdd : 0;
      stampRHS(rhs, k, v);
    },

    nextBreakpoint(afterTime: number): number | null {
      const idx = Math.floor(afterTime / halfPeriod) + 1;
      const result = idx * halfPeriod;
      return result > afterTime ? result : (idx + 1) * halfPeriod;
    },

    /**
     * Mirrors ngspice VSRCaccept PULSE branch (vsrcacct.c:50-145) collapsed
     * for the clock-specific case TR = TF = 0. Phase boundaries land at
     * integer multiples of halfPeriod; SAMETIME tolerance scales with halfP
     * (the natural plateau width). atBreakpoint mirrors CKTbreak.
     */
    acceptStep(
      simTime: number,
      addBreakpoint: (t: number) => void,
      atBreakpoint: boolean,
    ): void {
      if (!atBreakpoint) return;
      const PW = halfPeriod;
      const PER = 2 * halfPeriod;
      const TIMETOL = 1e-7;
      const sametime = (a: number, b: number) => Math.abs(a - b) <= TIMETOL * PW;

      let time = simTime;
      let basetime = 0;
      if (time >= PER) {
        basetime = PER * Math.floor(time / PER);
        time -= basetime;
      }

      // TR = TF = 0 collapses VSRCaccept's switch to two boundaries: time = 0
      // (rising edge) and time = halfPeriod (falling edge). After hitting one,
      // register the next.
      if (sametime(time, 0)) {
        addBreakpoint(basetime + halfPeriod);
      } else if (sametime(time, halfPeriod)) {
        addBreakpoint(basetime + PER);
      } else if (sametime(time, PER)) {
        addBreakpoint(basetime + PER + halfPeriod);
      }
    },

    getBreakpoints(tStart: number, tEnd: number): number[] {
      const out: number[] = [];
      let t = tStart;
      while (true) {
        const next = el.nextBreakpoint(t);
        if (next === null || next >= tEnd) break;
        if (next <= t) {
          throw new Error(`nextBreakpoint returned non-monotonic value: ${next} <= ${t}`);
        }
        out.push(next);
        t = next;
      }
      return out;
    },

    getPinCurrents(rhs: Float64Array): number[] {
      const I = rhs[el.branchIndex];
      return [-I];
    },
  };

  return el;
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
    "Clock  periodic signal source.\n" +
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
        props: PropertyBag,
        getTime: () => number,
      ): AnalogElement {
        const frequency = props.getOrDefault<number>("Frequency", 1);
        const vdd = props.getOrDefault<number>("vdd", 3.3);
        const nodePos = pinNodes.get("out")!;
        const nodeNeg = 0;
        return makeAnalogClockElement(nodePos, nodeNeg, -1, frequency, vdd, getTime);
      },
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
