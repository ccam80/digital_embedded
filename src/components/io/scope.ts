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
  createInverterConfig,
  resolvePins,
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

const COMP_WIDTH = 4;
const MAX_CHANNELS = 8;
const MAX_SAMPLES = 1024;

function componentHeight(channelCount: number): number {
  return Math.max(channelCount * 2, 4);
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
  const inputPositions = layoutPinsOnFace("west", channelCount, COMP_WIDTH, componentHeight(channelCount));
  return Array.from({ length: channelCount }, (_, i) => ({
    direction: PinDirection.INPUT,
    label: `in${i}`,
    defaultBitWidth: bitWidth,
    position: inputPositions[i],
    isNegatable: false,
    isClockCapable: false,
  }));
}

// ---------------------------------------------------------------------------
// ScopeElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ScopeElement extends AbstractCircuitElement {
  private readonly _channelCount: number;
  private readonly _bitWidth: number;
  private readonly _timeScale: number;
  private readonly _pins: readonly Pin[];
  private readonly _channels: WaveformChannel[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Scope", instanceId, position, rotation, mirror, props);

    this._channelCount = Math.min(
      Math.max(props.getOrDefault<number>("channelCount", 1), 1),
      MAX_CHANNELS,
    );
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._timeScale = props.getOrDefault<number>("timeScale", 1);

    this._channels = Array.from({ length: this._channelCount }, (_, i) => ({
      label: `in${i}`,
      samples: [],
    }));

    const decls = buildScopePinDeclarations(this._channelCount, this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
    );
  }

  get channelCount(): number {
    return this._channelCount;
  }

  get timeScale(): number {
    return this._timeScale;
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
    for (let i = 0; i < this._channelCount && i < values.length; i++) {
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
    return this._pins;
  }

  getBoundingBox(): Rect {
    const h = componentHeight(this._channelCount);
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const h = componentHeight(this._channelCount);

    ctx.save();

    // Component body
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, h, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, h, false);

    // Waveform symbol: small sawtooth/square wave icon
    const midY = h / 2;
    ctx.setLineWidth(1);
    ctx.drawLine(0.5, midY, 1.0, midY);
    ctx.drawLine(1.0, midY, 1.0, midY - 0.6);
    ctx.drawLine(1.0, midY - 0.6, 1.5, midY - 0.6);
    ctx.drawLine(1.5, midY - 0.6, 1.5, midY);
    ctx.drawLine(1.5, midY, 2.0, midY);
    ctx.drawLine(2.0, midY, 2.0, midY - 0.6);
    ctx.drawLine(2.0, midY - 0.6, 2.5, midY - 0.6);
    ctx.drawLine(2.5, midY - 0.6, 2.5, midY);
    ctx.drawLine(2.5, midY, COMP_WIDTH - 0.5, midY);

    // Label
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText("Scope", COMP_WIDTH / 2, h + 0.3, {
      horizontal: "center",
      vertical: "top",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Scope — multi-channel waveform recorder.\n" +
      "Records signal values over time. Waveform displayed in a floating panel.\n" +
      "channelCount: number of input channels (1–8).\n" +
      "timeScale: horizontal time scale factor."
    );
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
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  // Write first channel value to output for trigger/display reference
  const firstVal = inputCount > 0 ? state[inputStart] : 0;
  state[layout.outputOffset(index)] = firstVal;
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
  executeFn: executeScope,
  pinLayout: buildScopePinDeclarations(1, 1),
  propertyDefs: SCOPE_PROPERTY_DEFS,
  attributeMap: SCOPE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Scope — multi-channel waveform recorder.\n" +
    "Records signal values over time. Waveform displayed in a floating panel.\n" +
    "channelCount: number of input channels (1–8).\n" +
    "timeScale: horizontal time scale factor.",
};
