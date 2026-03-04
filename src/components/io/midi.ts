/**
 * MIDI component — note on/off, channel, velocity via Web MIDI API.
 *
 * Ported from de.neemann.digital.core.io.MIDI.
 *
 * Inputs (rising-edge clock triggered, when en=1):
 *   N     — MIDI note number (7-bit, 0–127)
 *   V     — velocity / volume (7-bit, 0–127)
 *   OnOff — 1=note on, 0=note off (1-bit)
 *   en    — enable (1-bit); clock edge is ignored when en=0
 *   C     — clock (1-bit, rising-edge triggered)
 *
 * Optional inputs when progChangeEnable=true (prepended before en/C):
 *   PC    — program change flag (1-bit); when 1, sends program change using N as program number
 *
 * No outputs. MIDI is a pure side-effect component.
 *
 * Graceful degradation: if the Web MIDI API is unavailable (non-browser env or
 * user denied permission), the component silently does nothing. Signal propagation
 * is unaffected.
 *
 * Internal state (internalStateCount: 1):
 *   stateSlot 0 — previous clock value (for edge detection)
 *
 * Properties:
 *   label           — optional label
 *   midiChannel     — MIDI channel number 1–16 (default 1)
 *   midiInstrument  — instrument name or GM patch number string (default "")
 *   progChangeEnable — when true, adds a PC input pin (default false)
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

const COMP_WIDTH = 3;
const COMP_HEIGHT = 4;

// ---------------------------------------------------------------------------
// Web MIDI API types (minimal, for graceful degradation)
// ---------------------------------------------------------------------------

interface MIDIOutput {
  send(data: number[]): void;
}

interface MIDIAccess {
  outputs: Map<string, MIDIOutput>;
}

// ---------------------------------------------------------------------------
// MIDI message helpers
// ---------------------------------------------------------------------------

/** Build a MIDI note-on message. */
function noteOnMessage(channel: number, note: number, velocity: number): number[] {
  return [0x90 | (channel & 0x0F), note & 0x7F, velocity & 0x7F];
}

/** Build a MIDI note-off message. */
function noteOffMessage(channel: number, note: number): number[] {
  return [0x80 | (channel & 0x0F), note & 0x7F, 0];
}

/** Build a MIDI program-change message. */
function programChangeMessage(channel: number, program: number): number[] {
  return [0xC0 | (channel & 0x0F), program & 0x7F];
}

// ---------------------------------------------------------------------------
// MidiOutputManager — singleton that manages Web MIDI access
//
// Graceful degradation: if the browser does not support Web MIDI or the user
// denies access, all send() calls are silently ignored.
// ---------------------------------------------------------------------------

class MidiOutputManager {
  private static _instance: MidiOutputManager | undefined;

  private _access: MIDIAccess | null = null;
  private _requested = false;

  static getInstance(): MidiOutputManager {
    if (MidiOutputManager._instance === undefined) {
      MidiOutputManager._instance = new MidiOutputManager();
    }
    return MidiOutputManager._instance;
  }

  requestAccess(): void {
    if (this._requested) return;
    this._requested = true;

    if (typeof navigator === "undefined" || !("requestMIDIAccess" in navigator)) {
      return;
    }

    (navigator as Navigator & { requestMIDIAccess(): Promise<MIDIAccess> })
      .requestMIDIAccess()
      .then((access) => {
        this._access = access;
      })
      .catch(() => {
        // Graceful degradation: no MIDI access
      });
  }

  send(message: number[]): void {
    if (this._access === null) return;
    for (const output of this._access.outputs.values()) {
      output.send(message);
    }
  }

  static resetForTesting(): void {
    MidiOutputManager._instance = undefined;
  }
}

// ---------------------------------------------------------------------------
// Pin layout helpers
// ---------------------------------------------------------------------------

function buildMidiPinDeclarations(progChangeEnable: boolean): PinDeclaration[] {
  const inputCount = progChangeEnable ? 6 : 5;
  const inputPositions = layoutPinsOnFace("west", inputCount, COMP_WIDTH, COMP_HEIGHT);

  const labels = progChangeEnable
    ? ["N", "V", "OnOff", "PC", "en", "C"]
    : ["N", "V", "OnOff", "en", "C"];

  return labels.map((label, i) => ({
    direction: PinDirection.INPUT,
    label,
    defaultBitWidth: label === "N" || label === "V" ? 7 : 1,
    position: inputPositions[i],
    isNegatable: false,
    isClockCapable: label === "C",
  }));
}

// ---------------------------------------------------------------------------
// MidiElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class MidiElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _midiChannel: number;
  private readonly _midiInstrument: string;
  private readonly _progChangeEnable: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("MIDI", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");
    this._midiChannel = props.getOrDefault<number>("midiChannel", 1);
    this._midiInstrument = props.getOrDefault<string>("midiInstrument", "");
    this._progChangeEnable = props.getOrDefault<boolean>("progChangeEnable", false);

    const decls = buildMidiPinDeclarations(this._progChangeEnable);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set(["C"]) },
    );

    MidiOutputManager.getInstance().requestAccess();
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const { x, y } = this.position;
    ctx.save();
    ctx.translate(x, y);

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText("MIDI", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

    if (this._label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(this._label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  get midiChannel(): number {
    return this._midiChannel;
  }

  get midiInstrument(): string {
    return this._midiInstrument;
  }

  get progChangeEnable(): boolean {
    return this._progChangeEnable;
  }

  getHelpText(): string {
    return (
      "MIDI — sends MIDI note-on/off and program-change messages via Web MIDI API.\n" +
      "Inputs: N (note, 7-bit), V (velocity, 7-bit), OnOff (1=on, 0=off), en (enable), C (clock).\n" +
      "When progChangeEnable=true, an additional PC input enables program-change mode.\n" +
      "On rising clock edge with en=1: sends note-on or note-off depending on OnOff.\n" +
      "If Web MIDI is unavailable, the component produces no audio but signals propagate normally.\n" +
      "midiChannel selects the MIDI channel (1–16). midiInstrument sets the GM instrument name."
    );
  }
}

// ---------------------------------------------------------------------------
// executeMidi — flat simulation function
//
// Detects rising clock edge (en=1 required). On edge:
//   - If progChangeEnable and PC=1: sends program change with N as program number.
//   - If OnOff=1: sends note-on with note=N, velocity=V.
//   - If OnOff=0: sends note-off with note=N.
//
// Internal state slot 0 holds the previous clock value (0 or 1).
//
// Input slot mapping (when progChangeEnable=false):
//   0=N, 1=V, 2=OnOff, 3=en, 4=C
// When progChangeEnable=true:
//   0=N, 1=V, 2=OnOff, 3=PC, 4=en, 5=C
//
// The midiChannel and progChangeEnable values are not accessible from state alone;
// the engine must pass component-specific configuration through a side-channel.
// For the flat executeFn, we encode configuration in state slots beyond internalStateCount:
//   stateSlot 0 = prevClock
//   stateSlot 1 = midiChannel (0-based, set by compiler from props)
//   stateSlot 2 = progChangeEnable flag (0 or 1, set by compiler from props)
// ---------------------------------------------------------------------------

export function executeMidi(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);

  const progChangeEnable = inputCount === 6;
  const clockIdx = progChangeEnable ? inputStart + 5 : inputStart + 4;
  const enIdx = progChangeEnable ? inputStart + 4 : inputStart + 3;
  const onOffIdx = inputStart + 2;
  const vIdx = inputStart + 1;
  const nIdx = inputStart;
  const pcIdx = progChangeEnable ? inputStart + 3 : -1;

  const clock = state[clockIdx] & 1;
  const en = state[enIdx] & 1;

  const outputStart = layout.outputOffset(index);
  const prevClock = state[outputStart];

  const risingEdge = prevClock === 0 && clock === 1;
  state[outputStart] = clock;

  if (!risingEdge || en === 0) return;

  const note = state[nIdx] & 0x7F;
  const velocity = state[vIdx] & 0x7F;
  const onOff = state[onOffIdx] & 1;
  const midiChannel = (state[outputStart + 1] & 0xF);
  const pc = pcIdx >= 0 ? (state[pcIdx] & 1) : 0;

  const manager = MidiOutputManager.getInstance();

  if (pc !== 0) {
    manager.send(programChangeMessage(midiChannel, note));
  } else if (onOff !== 0) {
    manager.send(noteOnMessage(midiChannel, note, velocity));
  } else {
    manager.send(noteOffMessage(midiChannel, note));
  }
}

// ---------------------------------------------------------------------------
// MIDI_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const MIDI_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "midi_Channel",
    propertyKey: "midiChannel",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "midi_Instrument",
    propertyKey: "midiInstrument",
    convert: (v) => v,
  },
  {
    xmlName: "midi_ProgChange",
    propertyKey: "progChangeEnable",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MIDI_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
  {
    key: "midiChannel",
    type: PropertyType.INT,
    label: "MIDI Channel",
    defaultValue: 1,
    min: 1,
    max: 16,
    description: "MIDI channel number (1–16)",
  },
  {
    key: "midiInstrument",
    type: PropertyType.STRING,
    label: "Instrument",
    defaultValue: "",
    description: "GM instrument name or patch number string",
  },
  {
    key: "progChangeEnable",
    type: PropertyType.BOOLEAN,
    label: "Program Change",
    defaultValue: false,
    description: "When true, adds PC input for program-change mode",
  },
];

// ---------------------------------------------------------------------------
// MidiDefinition
// ---------------------------------------------------------------------------

function midiFactory(props: PropertyBag): MidiElement {
  return new MidiElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const MidiDefinition: ComponentDefinition = {
  name: "MIDI",
  typeId: -1,
  factory: midiFactory,
  executeFn: executeMidi,
  pinLayout: buildMidiPinDeclarations(false),
  propertyDefs: MIDI_PROPERTY_DEFS,
  attributeMap: MIDI_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "MIDI — sends MIDI note-on/off and program-change messages via Web MIDI API.\n" +
    "Inputs: N (note, 7-bit), V (velocity, 7-bit), OnOff (1=on/0=off), en (enable), C (clock).\n" +
    "Triggered on rising clock edge when en=1.\n" +
    "Graceful degradation: if Web MIDI is unavailable, no audio is produced but signals propagate normally.",
  defaultDelay: 0,
};

export { MidiOutputManager };
