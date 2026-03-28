/**
 * Scope component — multi-channel waveform recorder.
 *
 * Records signal values over time, producing waveform data for display in a
 * floating panel. Supports configurable channel count, time scale, and
 * trigger mode.
 *
 * The Scope has N input channels. On each simulation step, input values are
 * appended to per-channel sample buffers. The waveform panel reads these
 * buffers for display.
 *
 * internalStateCount: 0 (sample buffers live on the element, not in Uint32Array)
 * The engine calls executeScope each step; executeScope stores the input
 * values into the element's sample buffer via the backing-store mechanism.
 * Since Phase 3 backing stores aren't available yet, executeScope packs the
 * current input values into a single output slot for the engine's state array
 * (the panel reads from the element directly via a side channel).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  layoutPinsOnFace,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java ScopeShape constants (SIZE=20px = 1 grid unit, SIZE2=10px = 0.5 grid):
//   BORDER = SIZE/3 = 7px ≈ 0.35 grid
//   OUTER polygon: (2,SIZE2) → (2,-SIZE*2) → (SIZE*4,-SIZE*2) → (SIZE*4,SIZE2)
//     = (0.1, 0.5) → (0.1,-2) → (4,-2) → (4,0.5)
//   INNER polygon (rounded): (2+BORDER, SIZE2-BORDER) = (0.45, 0.15) approx
//     inner corners: (0.45,0.15)→(0.45,-1.65)→(2.65,-1.65)→(2.65,0.15)
//     rounded by BORDER*2 = 14px = 0.7 grid
//   TRACE polyline:
//     (3+BORDER,-BORDER) = (0.5,-0.35) approx, then step up
//   Pin: clk at (0,0)
const COMP_WIDTH = 4;   // outer rect right edge at x=4
const MAX_CHANNELS = 8;
const MAX_SAMPLES = 1024;

// Java ScopeShape has a fixed single-pin layout (clock at 0,0) and fixed shape.
// componentHeight is not variable for the default 1-channel scope.
function componentHeight(_channelCount: number): number {
  // Java outer: y from -2 to +0.5 = height 2.5; but pin is at y=0 which is inside.
  // We keep this for compatibility but the shape is fixed.
  return 2.5;
}

// ---------------------------------------------------------------------------
// WaveformChannel — per-channel sample buffer
// ---------------------------------------------------------------------------

export interface WaveformChannel {
  readonly label: string;
  readonly samples: number[];
}

// ---------------------------------------------------------------------------
// Pin layout — N input channels on the west face
// ---------------------------------------------------------------------------

function buildScopePinDeclarations(channelCount: number, bitWidth: number): PinDeclaration[] {
  // Java Scope: single pin "clk" at (0,0). Multi-channel pins at (0, i).
  return Array.from({ length: channelCount }, (_, i) => ({
    direction: PinDirection.INPUT,
    label: channelCount === 1 ? "clk" : `in${i}`,
    defaultBitWidth: bitWidth,
    position: { x: 0, y: i },
    isNegatable: false,
    isClockCapable: false,
  }));
}

// ---------------------------------------------------------------------------
// ScopeElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ScopeElement extends AbstractCircuitElement {
  private readonly _channels: WaveformChannel[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Scope", instanceId, position, rotation, mirror, props);

    const channelCount = Math.min(
      Math.max(props.getOrDefault<number>("channelCount", 1), 1),
      MAX_CHANNELS,
    );
    this._channels = Array.from({ length: channelCount }, (_, i) => ({
      label: `in${i}`,
      samples: [],
    }));
  }

  get channelCount(): number {
    return this._properties.getOrDefault<number>("channelCount", 1);
  }

  get timeScale(): number {
    return this._properties.getOrDefault<number>("timeScale", 1);
  }

  /** Returns the waveform sample buffers for all channels. */
  getChannels(): readonly WaveformChannel[] {
    return this._channels;
  }

  /**
   * Record one sample per channel. Called by the engine step loop
   * (via executeScope side-channel) to append values to the waveform buffers.
   * Oldest samples are dropped when MAX_SAMPLES is reached.
   */
  recordSamples(values: readonly number[]): void {
    const channelCount = this._properties.getOrDefault<number>("channelCount", 1);
    for (let i = 0; i < channelCount && i < values.length; i++) {
      const ch = this._channels[i];
      ch.samples.push(values[i]);
      if (ch.samples.length > MAX_SAMPLES) {
        ch.samples.shift();
      }
    }
  }

  /** Clear all recorded samples (called on simulation reset). */
  clearSamples(): void {
    for (const ch of this._channels) {
      ch.samples.length = 0;
    }
  }

  getPins(): readonly Pin[] {
    const channelCount = this._properties.getOrDefault<number>("channelCount", 1);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls = buildScopePinDeclarations(channelCount, bitWidth);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    // Java outer polygon spans x: 0.1..4, y: -2..0.5
    // Bbox must tightly enclose drawn content (outer rect left edge at x=0.1)
    return {
      x: this.position.x + 0.1,
      y: this.position.y - 2,
      width: COMP_WIDTH - 0.1,
      height: 2.5,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    // Outer rectangle: (0.1, 0.5) → (4, -2) — NORMAL style
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0.1, y:  0.5 },
        { op: "lineTo", x: 0.1, y: -2   },
        { op: "lineTo", x: 4,   y: -2   },
        { op: "lineTo", x: 4,   y:  0.5 },
        { op: "closePath" },
      ],
    });

    // Trace waveform (THIN): matches java-shapes.json points exactly
    // (0.45,-0.3)→(1.3,-0.3)→(1.3,-1.3)→(2.3,-1.3)→(2.3,-0.3)→(2.65,-0.3)
    ctx.setLineWidth(0.5);
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0.45, y: -0.3  },
        { op: "lineTo", x: 1.3,  y: -0.3  },
        { op: "lineTo", x: 1.3,  y: -1.3  },
        { op: "lineTo", x: 2.3,  y: -1.3  },
        { op: "lineTo", x: 2.3,  y: -0.3  },
        { op: "lineTo", x: 2.65, y: -0.3  },
      ],
    });

    // Inner rounded rect (THIN): (0.4,0.2)→(0.4,-1.7)→(2.7,-1.7)→(2.7,0.2) closed
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0.4, y:  0.2  },
        { op: "lineTo", x: 0.4, y: -1.7  },
        { op: "lineTo", x: 2.7, y: -1.7  },
        { op: "lineTo", x: 2.7, y:  0.2  },
        { op: "closePath" },
      ],
    });
    ctx.setLineWidth(1);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeScope — read N inputs, pack first input into output slot for engine
//
// The full waveform recording (recordSamples) is driven by the engine's
// post-step hook which has access to the ScopeElement instance. The execute
// function writes the first channel value to the output slot so the engine
// can track the signal for trigger detection.
// ---------------------------------------------------------------------------

export function executeScope(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  // Write first channel value to output for trigger/display reference
  const firstVal = inputCount > 0 ? state[wt[inputStart]] : 0;
  state[wt[layout.outputOffset(index)]] = firstVal;
}

// ---------------------------------------------------------------------------
// SCOPE_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SCOPE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Channels",
    propertyKey: "channelCount",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "TimeScale",
    propertyKey: "timeScale",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SCOPE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "channelCount",
    type: PropertyType.INT,
    label: "Channels",
    defaultValue: 1,
    min: 1,
    max: MAX_CHANNELS,
    description: "Number of input channels to record",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of each channel",
  },
  {
    key: "timeScale",
    type: PropertyType.INT,
    label: "Time scale",
    defaultValue: 1,
    min: 1,
    max: 1000,
    description: "Horizontal time scale factor for waveform display",
  },
];

// ---------------------------------------------------------------------------
// ScopeDefinition
// ---------------------------------------------------------------------------

function scopeFactory(props: PropertyBag): ScopeElement {
  return new ScopeElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ScopeDefinition: ComponentDefinition = {
  name: "Scope",
  typeId: -1,
  factory: scopeFactory,
  pinLayout: buildScopePinDeclarations(1, 1),
  propertyDefs: SCOPE_PROPERTY_DEFS,
  attributeMap: SCOPE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Scope — multi-channel waveform recorder.\n" +
    "Records signal values over time. Waveform displayed in a floating panel.\n" +
    "channelCount: number of input channels (1–8).\n" +
    "timeScale: horizontal time scale factor.",
  models: {
    // Schema for default channelCount=1; direction-filter order matches for all channelCounts.
    digital: { executeFn: executeScope, inputSchema: ["clk"], outputSchema: [] },
  },
};
