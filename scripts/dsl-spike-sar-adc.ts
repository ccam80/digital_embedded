/**
 * DSL → .dts converter spike (v0).
 *
 * Generates `circuits/sar_adc_4bit_from_dsl.dts` from an inline DSL spec for
 * a 4-bit SAR ADC (R-2R DAC, comparator, 2-bit down-counter, SAR write-gate).
 *
 * Subcircuits use the inbuilt `subcircuitDefinitions` mechanic. v0 emits
 * interface-only stubs- In/Out elements only, no internal gates. Renderer
 * draws the chip box with correct pin labels; simulation would no-op.
 *
 * Pin offsets and the rotation convention come from the actual component
 * definitions (`src/components/...`), not guessed.
 *
 * Run: npx tsx scripts/dsl-spike-sar-adc.ts
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve as resolvePath, dirname } from "node:path";

// ============================================================================
// DSL types- relative-placement authoring layer
// ============================================================================

type Pos = { x: number; y: number };
type PinRef = { component: string; pin: string };
type Rotation = 0 | 1 | 2 | 3;

type Placement =
  | { kind: "at"; at: Pos }
  | { kind: "right_of"; ref: string; gap?: number }
  | { kind: "left_of"; ref: string; gap?: number }
  | { kind: "below"; ref: string; gap?: number }
  | { kind: "above"; ref: string; gap?: number }
  | { kind: "between"; a: PinRef; b: PinRef };

type PinAttachment =
  | { kind: "rail"; rail: string }
  | { kind: "tunnel"; tunnel: string; bitWidth?: number };

type ComponentInst = {
  id: string;
  type: string;
  placement: Placement;
  rotation?: Rotation;
  properties?: Record<string, unknown>;
  pinAttachments?: Record<string, PinAttachment>;
};

type Wire = { from: PinRef; to: PinRef };

type RailDecl = {
  name: string;
  side: "top" | "bottom" | "left" | "right";
  voltage?: number;
};

type IfacePin = {
  label: string;
  direction: "in" | "out";
  bitWidth?: number;
};

type SubcircuitDecl = {
  name: string;
  pins: IfacePin[];
};

type CircuitSpec = {
  name?: string;
  description?: string;
  rails?: RailDecl[];
  tunnels?: { name: string; bitWidth?: number }[];
  subcircuits?: SubcircuitDecl[];
  components: ComponentInst[];
  wires?: Wire[];
};

// ============================================================================
// .dts output types- matching the existing on-disk format
// ============================================================================

type DtsElement = {
  id: string;
  position: Pos;
  rotation: number;
  type: string;
  properties: Record<string, unknown>;
};

type DtsWire = { points: [Pos, Pos] };

type DtsCircuit = {
  name?: string;
  description?: string;
  elements: DtsElement[];
  wires: DtsWire[];
};

type DtsDoc = {
  circuit: DtsCircuit;
  subcircuitDefinitions?: Record<string, DtsCircuit>;
  format: "dts";
  version: 1;
};

// ============================================================================
// Pin offsets & sizing- sourced from component definition files
// ----------------------------------------------------------------------------
// All offsets are CANONICAL (rotation 0). The converter applies rotation to
// derive absolute pin coords. `extent` is the pin bounding box (not the visual
// chip), used for relative-placement gap calculations.
// ============================================================================

type ComponentSpec = {
  pins: Record<string, Pos>;
  extent: { w: number; h: number };
};

const COMPONENTS: Record<string, ComponentSpec> = {
  // src/components/sources/dc-voltage-source.ts: horizontal, neg→pos at x=0..4
  // (Pin labels per draw(): "pos" and "neg", confirmed in getPinVoltage calls.)
  DcVoltageSource: {
    pins: { neg: { x: 0, y: 0 }, pos: { x: 4, y: 0 } },
    extent: { w: 4, h: 0 },
  },
  // src/components/active/comparator.ts: 3 pins, no power
  VoltageComparator: {
    pins: {
      "in+": { x: 0, y: -1 },
      "in-": { x: 0, y: 1 },
      out: { x: 4, y: 0 },
    },
    extent: { w: 4, h: 2 },
  },
  // src/components/flipflops/d.ts: 3 wide, D/C left, Q/~Q right
  D_FF: {
    pins: {
      D: { x: 0, y: 0 },
      C: { x: 0, y: 1 },
      Q: { x: 3, y: 0 },
      "~Q": { x: 3, y: 1 },
    },
    extent: { w: 3, h: 1 },
  },
  // src/components/passives/resistor.ts: horizontal A→B at x=0..4
  Resistor: {
    pins: { A: { x: 0, y: 0 }, B: { x: 4, y: 0 } },
    extent: { w: 4, h: 0 },
  },
  // src/components/wiring/tunnel.ts: single pin "in" at (0,0)
  Tunnel: {
    pins: { in: { x: 0, y: 0 } },
    extent: { w: 1, h: 0 },
  },
  Ground: {
    pins: { in: { x: 0, y: 0 } },
    extent: { w: 0, h: 1 },
  },
  Vdd: {
    pins: { out: { x: 0, y: 0 } },
    extent: { w: 0, h: 1 },
  },
};

// ============================================================================
// Rotation- quarter-turns clockwise (0=east, 1=south, 2=west, 3=north)
// Mirrors src/core/pin.ts::rotatePoint
// ============================================================================

// Mirrors the runtime implementation in src/core/pin.ts (NOT its docstring).
// case 1 sends east → north, case 3 sends east → south.
function rotatePoint(p: Pos, r: Rotation): Pos {
  switch (r) {
    case 0:
      return { x: p.x, y: p.y };
    case 1:
      return { x: p.y, y: -p.x };
    case 2:
      return { x: -p.x, y: -p.y };
    case 3:
      return { x: -p.y, y: p.x };
  }
}

function rotateExtent(
  e: { w: number; h: number },
  r: Rotation,
): { w: number; h: number } {
  return r % 2 === 0 ? { w: e.w, h: e.h } : { w: e.h, h: e.w };
}

// ============================================================================
// Pin lookup (built-in components and subcircuit instances)
// ============================================================================

function pinOffset(
  comp: ComponentInst,
  pin: string,
  subcircuits: Map<string, SubcircuitDecl>,
): Pos {
  const builtin = COMPONENTS[comp.type];
  const r = comp.rotation ?? 0;
  if (builtin) {
    const p = builtin.pins[pin];
    if (!p)
      throw new Error(`No pin "${pin}" on ${comp.type} (id=${comp.id})`);
    return rotatePoint(p, r);
  }
  const sub = subcircuits.get(comp.type);
  if (sub) {
    const p = subcircuitPinOffset(sub, pin);
    return rotatePoint(p, r);
  }
  throw new Error(`Unknown component type: ${comp.type}`);
}

function componentExtent(
  comp: ComponentInst,
  subcircuits: Map<string, SubcircuitDecl>,
): { w: number; h: number } {
  const r = comp.rotation ?? 0;
  const builtin = COMPONENTS[comp.type];
  if (builtin) return rotateExtent(builtin.extent, r);
  const sub = subcircuits.get(comp.type);
  if (sub) return rotateExtent(subcircuitSize(sub), r);
  throw new Error(`Unknown component type: ${comp.type}`);
}

// Mirrors src/components/subcircuit/subcircuit.ts::buildDefaultPositions for
// the DEFAULT/SIMPLE shape mode: chipWidth=3, integer y-spacing, with
// symmetric+even-input gap correction when there's exactly 1 output.
const SUBCIRCUIT_CHIP_WIDTH = 3;

function subcircuitSize(sub: SubcircuitDecl): { w: number; h: number } {
  const inputs = sub.pins.filter((p) => p.direction === "in").length;
  const outputs = sub.pins.filter((p) => p.direction === "out").length;
  const symmetric = outputs === 1;
  const evenGap = symmetric && inputs % 2 === 0 ? 1 : 0;
  return {
    w: SUBCIRCUIT_CHIP_WIDTH,
    h: Math.max(inputs + evenGap, outputs, 1),
  };
}

function subcircuitPinOffset(sub: SubcircuitDecl, pin: string): Pos {
  const inputs = sub.pins.filter((p) => p.direction === "in");
  const outputs = sub.pins.filter((p) => p.direction === "out");
  const symmetric = outputs.length === 1;
  const offs = symmetric ? Math.floor(inputs.length / 2) : 0;
  const evenCorrect = symmetric && inputs.length % 2 === 0;

  const inIdx = inputs.findIndex((p) => p.label === pin);
  if (inIdx >= 0) {
    let y = inIdx;
    if (evenCorrect && inIdx >= inputs.length / 2) y = inIdx + 1;
    return { x: 0, y };
  }
  const outIdx = outputs.findIndex((p) => p.label === pin);
  if (outIdx >= 0) {
    return { x: SUBCIRCUIT_CHIP_WIDTH, y: outIdx + offs };
  }
  throw new Error(`No pin "${pin}" on subcircuit ${sub.name}`);
}

// ============================================================================
// Placement resolver- topo-sort, walk from anchors
// ============================================================================

function resolvePlacements(
  spec: CircuitSpec,
  subcircuits: Map<string, SubcircuitDecl>,
): Map<string, Pos> {
  const positions = new Map<string, Pos>();
  const componentMap = new Map(spec.components.map((c) => [c.id, c]));
  const pending = new Set(spec.components.map((c) => c.id));

  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const id of [...pending]) {
      const comp = componentMap.get(id)!;
      const pos = tryResolve(comp, positions, componentMap, subcircuits);
      if (pos) {
        positions.set(id, pos);
        pending.delete(id);
        progress = true;
      }
    }
  }

  if (pending.size > 0) {
    throw new Error(
      `Could not resolve placements (cycle or floating subgraph): ${[...pending].join(", ")}`,
    );
  }

  return positions;
}

function tryResolve(
  comp: ComponentInst,
  resolved: Map<string, Pos>,
  all: Map<string, ComponentInst>,
  subcircuits: Map<string, SubcircuitDecl>,
): Pos | null {
  const p = comp.placement;
  switch (p.kind) {
    case "at":
      return p.at;
    case "right_of": {
      const refPos = resolved.get(p.ref);
      if (!refPos) return null;
      const refExt = componentExtent(all.get(p.ref)!, subcircuits);
      return { x: refPos.x + refExt.w + (p.gap ?? 2), y: refPos.y };
    }
    case "left_of": {
      const refPos = resolved.get(p.ref);
      if (!refPos) return null;
      const selfExt = componentExtent(comp, subcircuits);
      return { x: refPos.x - selfExt.w - (p.gap ?? 2), y: refPos.y };
    }
    case "below": {
      const refPos = resolved.get(p.ref);
      if (!refPos) return null;
      const refExt = componentExtent(all.get(p.ref)!, subcircuits);
      return { x: refPos.x, y: refPos.y + refExt.h + (p.gap ?? 2) };
    }
    case "above": {
      const refPos = resolved.get(p.ref);
      if (!refPos) return null;
      const selfExt = componentExtent(comp, subcircuits);
      return { x: refPos.x, y: refPos.y - selfExt.h - (p.gap ?? 2) };
    }
    case "between": {
      const aRefPos = resolved.get(p.a.component);
      const bRefPos = resolved.get(p.b.component);
      if (!aRefPos || !bRefPos) return null;
      const aPin = pinOffset(all.get(p.a.component)!, p.a.pin, subcircuits);
      const bPin = pinOffset(all.get(p.b.component)!, p.b.pin, subcircuits);
      const aAbs: Pos = { x: aRefPos.x + aPin.x, y: aRefPos.y + aPin.y };
      const bAbs: Pos = { x: bRefPos.x + bPin.x, y: bRefPos.y + bPin.y };
      // Place the component so its A pin (canonical (0,0)) sits at the smaller
      // endpoint and its B pin reaches toward the larger endpoint.
      if (aAbs.y === bAbs.y) {
        // horizontal extent
        return { x: Math.min(aAbs.x, bAbs.x), y: aAbs.y };
      } else if (aAbs.x === bAbs.x) {
        // vertical extent- relies on caller setting rotation: 1
        return { x: aAbs.x, y: Math.min(aAbs.y, bAbs.y) };
      } else {
        throw new Error(
          `between(${p.a.component}.${p.a.pin}, ${p.b.component}.${p.b.pin}): pin coords are not axis-aligned (${aAbs.x},${aAbs.y}) vs (${bAbs.x},${bAbs.y})`,
        );
      }
    }
  }
}

function pinAbs(
  comp: ComponentInst,
  pin: string,
  positions: Map<string, Pos>,
  subcircuits: Map<string, SubcircuitDecl>,
): Pos {
  const compPos = positions.get(comp.id)!;
  const offs = pinOffset(comp, pin, subcircuits);
  return { x: compPos.x + offs.x, y: compPos.y + offs.y };
}

// Outward unit-direction for placing tunnel/label glyphs without overlapping
// the component body or a neighbour. Computed in the canonical pin frame
// (relative to extent center), then rotated by the component's rotation.
function tunnelDirection(
  comp: ComponentInst,
  pin: string,
  subcircuits: Map<string, SubcircuitDecl>,
): Pos {
  const r = comp.rotation ?? 0;
  const builtin = COMPONENTS[comp.type];
  let pinCanonical: Pos;
  let extentCanonical: { w: number; h: number };
  if (builtin) {
    pinCanonical = builtin.pins[pin];
    extentCanonical = builtin.extent;
  } else {
    const sub = subcircuits.get(comp.type)!;
    pinCanonical = subcircuitPinOffset(sub, pin);
    extentCanonical = subcircuitSize(sub);
  }
  const cx = extentCanonical.w / 2;
  const cy = extentCanonical.h / 2;
  const dx = pinCanonical.x - cx;
  const dy = pinCanonical.y - cy;
  let dir: Pos;
  if (extentCanonical.w === 0) {
    dir = { x: 0, y: dy >= 0 ? 1 : -1 };
  } else if (extentCanonical.h === 0) {
    dir = { x: dx >= 0 ? 1 : -1, y: 0 };
  } else if (Math.abs(dx) >= Math.abs(dy)) {
    dir = { x: dx >= 0 ? 1 : -1, y: 0 };
  } else {
    dir = { x: 0, y: dy >= 0 ? 1 : -1 };
  }
  return rotatePoint(dir, r);
}

// ============================================================================
// Element & wire emission
// ============================================================================

function emitDts(spec: CircuitSpec): DtsDoc {
  const subcircuits = new Map((spec.subcircuits ?? []).map((s) => [s.name, s]));
  const positions = resolvePlacements(spec, subcircuits);
  const componentMap = new Map(spec.components.map((c) => [c.id, c]));

  const elements: DtsElement[] = [];
  const wires: DtsWire[] = [];

  // 1. Each user-declared component → DtsElement.
  //    .dts stores rotation in DEGREES (0/90/180/270); convert from
  //    canonical quarter-turn (0/1/2/3) on the way out.
  for (const comp of spec.components) {
    const pos = positions.get(comp.id)!;
    elements.push({
      id: randomUUID(),
      position: pos,
      rotation: (comp.rotation ?? 0) * 90,
      type: comp.type,
      properties: { label: comp.id, ...(comp.properties ?? {}) },
    });
  }

  // 2. Tunnel attachments → emit Tunnel element placed OUTWARD from the
  //    component body (so the triangle/label doesn't land on top of the chip
  //    or its neighbour), with a 2-grid stub from pin to tunnel.
  for (const comp of spec.components) {
    if (!comp.pinAttachments) continue;
    for (const [pinLabel, attach] of Object.entries(comp.pinAttachments)) {
      if (attach.kind !== "tunnel") continue;
      const pAbs = pinAbs(comp, pinLabel, positions, subcircuits);
      const dir = tunnelDirection(comp, pinLabel, subcircuits);
      const tunnelPos: Pos = { x: pAbs.x + dir.x * 2, y: pAbs.y + dir.y * 2 };
      elements.push({
        id: randomUUID(),
        position: tunnelPos,
        rotation: 0,
        type: "Tunnel",
        properties: {
          NetName: attach.tunnel,
          bitWidth: attach.bitWidth ?? 1,
        },
      });
      wires.push({ points: [pAbs, tunnelPos] });
    }
  }

  // 3. Rails → real lines clipped to outboard connections + one Ground/Vdd
  //    glyph at the leftmost (or topmost) end. Each attached pin gets a
  //    perpendicular stub from pin to rail axis.
  for (const rail of spec.rails ?? []) {
    const attachedPins: Pos[] = [];
    for (const comp of spec.components) {
      if (!comp.pinAttachments) continue;
      for (const [pinLabel, attach] of Object.entries(comp.pinAttachments)) {
        if (attach.kind === "rail" && attach.rail === rail.name) {
          attachedPins.push(pinAbs(comp, pinLabel, positions, subcircuits));
        }
      }
    }
    if (attachedPins.length === 0) continue;

    const isHorizontal = rail.side === "top" || rail.side === "bottom";
    const isGnd = rail.name === "GND" || rail.voltage === 0;
    const anchorType = isGnd ? "Ground" : "Vdd";

    if (isHorizontal) {
      const ys = attachedPins.map((p) => p.y);
      const xs = attachedPins.map((p) => p.x);
      const railY =
        rail.side === "bottom" ? Math.max(...ys) + 4 : Math.min(...ys) - 4;
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const anchorPos: Pos = { x: minX - 3, y: railY };
      elements.push({
        id: randomUUID(),
        position: anchorPos,
        rotation: 0,
        type: anchorType,
        properties: { label: `${rail.name}_anchor` },
      });
      // Split rail line into segments so each attachment x-coord is a vertex.
      // Connectivity uses (x,y) string keys for endpoint coincidence; mid-segment
      // intersections do NOT merge nets.
      const railVertexXs = [
        anchorPos.x,
        ...[...new Set(xs)].sort((a, b) => a - b),
      ];
      for (let i = 0; i < railVertexXs.length - 1; i++) {
        wires.push({
          points: [
            { x: railVertexXs[i], y: railY },
            { x: railVertexXs[i + 1], y: railY },
          ],
        });
      }
      // Per-pin perpendicular stubs (each lands on a railVertex)
      for (const pin of attachedPins) {
        if (pin.y !== railY) {
          wires.push({ points: [pin, { x: pin.x, y: railY }] });
        }
      }
    } else {
      const xs = attachedPins.map((p) => p.x);
      const ys = attachedPins.map((p) => p.y);
      const railX =
        rail.side === "right" ? Math.max(...xs) + 4 : Math.min(...xs) - 4;
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const anchorPos: Pos = { x: railX, y: minY - 3 };
      elements.push({
        id: randomUUID(),
        position: anchorPos,
        rotation: 0,
        type: anchorType,
        properties: { label: `${rail.name}_anchor` },
      });
      const railVertexYs = [
        anchorPos.y,
        ...[...new Set(ys)].sort((a, b) => a - b),
      ];
      for (let i = 0; i < railVertexYs.length - 1; i++) {
        wires.push({
          points: [
            { x: railX, y: railVertexYs[i] },
            { x: railX, y: railVertexYs[i + 1] },
          ],
        });
      }
      for (const pin of attachedPins) {
        if (pin.x !== railX) {
          wires.push({ points: [pin, { x: railX, y: pin.y }] });
        }
      }
    }
  }

  // 4. Explicit wires → L-shape if endpoints aren't already aligned
  for (const w of spec.wires ?? []) {
    const fromComp = componentMap.get(w.from.component);
    const toComp = componentMap.get(w.to.component);
    if (!fromComp || !toComp) {
      throw new Error(
        `Wire references unknown component: ${w.from.component} → ${w.to.component}`,
      );
    }
    const fromAbs = pinAbs(fromComp, w.from.pin, positions, subcircuits);
    const toAbs = pinAbs(toComp, w.to.pin, positions, subcircuits);
    if (fromAbs.x === toAbs.x || fromAbs.y === toAbs.y) {
      wires.push({ points: [fromAbs, toAbs] });
    } else {
      const corner: Pos = { x: toAbs.x, y: fromAbs.y };
      wires.push({ points: [fromAbs, corner] });
      wires.push({ points: [corner, toAbs] });
    }
  }

  // 5. Subcircuit definitions → stub circuits with In/Out interface elements
  const subcircuitDefinitions: Record<string, DtsCircuit> = {};
  for (const sub of spec.subcircuits ?? []) {
    const subElements: DtsElement[] = [];
    const inputs = sub.pins.filter((p) => p.direction === "in");
    const outputs = sub.pins.filter((p) => p.direction === "out");
    inputs.forEach((p, i) => {
      const props: Record<string, unknown> = { label: p.label };
      if (p.bitWidth && p.bitWidth > 1) props.bitWidth = p.bitWidth;
      subElements.push({
        id: randomUUID(),
        position: { x: 0, y: i * 2 + 1 },
        rotation: 0,
        type: "In",
        properties: props,
      });
    });
    outputs.forEach((p, i) => {
      const props: Record<string, unknown> = { label: p.label };
      if (p.bitWidth && p.bitWidth > 1) props.bitWidth = p.bitWidth;
      subElements.push({
        id: randomUUID(),
        position: { x: 6, y: i * 2 + 1 },
        rotation: 0,
        type: "Out",
        properties: props,
      });
    });
    subcircuitDefinitions[sub.name] = {
      name: sub.name,
      elements: subElements,
      wires: [],
    };
  }

  const doc: DtsDoc = {
    circuit: {
      name: spec.name ?? "Untitled",
      description: spec.description,
      elements,
      wires,
    },
    format: "dts",
    version: 1,
  };
  if (Object.keys(subcircuitDefinitions).length > 0) {
    doc.subcircuitDefinitions = subcircuitDefinitions;
  }
  return doc;
}

// ============================================================================
// SAR ADC spec- corrected for real component pin labels and orientations
// ============================================================================

const downCounter2b: SubcircuitDecl = {
  name: "down_counter_2b",
  pins: [
    { label: "CLK", direction: "in" },
    { label: "RST", direction: "in" },
    { label: "Q", direction: "out", bitWidth: 2 },
  ],
};

const sarWriteGate4: SubcircuitDecl = {
  name: "sar_write_gate_4",
  pins: [
    { label: "DEC", direction: "in" },
    { label: "SEL", direction: "in", bitWidth: 2 },
    { label: "D0", direction: "out" },
    { label: "D1", direction: "out" },
    { label: "D2", direction: "out" },
    { label: "D3", direction: "out" },
  ],
};

// 4× D-FFs in a horizontal row.
// D inputs: per-bit tunnel attachments WD_0..WD_3 (paired with WGATE outputs)
// to avoid L-shape routing through neighbouring pins.
// Q outputs: per-bit tunnel attachments BIT_0..BIT_3 driving the DAC.
const ffComponents: ComponentInst[] = [0, 1, 2, 3].map<ComponentInst>((i) => ({
  id: `FF${i}`,
  type: "D_FF",
  placement:
    i === 0
      ? { kind: "right_of", ref: "WGATE", gap: 4 }
      : { kind: "right_of", ref: `FF${i - 1}`, gap: 1 },
  pinAttachments: {
    D: { kind: "tunnel", tunnel: `WD_${i}` },
    C: { kind: "tunnel", tunnel: "CLK" },
    Q: { kind: "tunnel", tunnel: `BIT_${i}` },
  },
}));

// 4× vertical 2R rungs (rotation: 1) hanging below each FF.
// R3 also exposes B → DAC_OUT tunnel (the MSB-end ladder tap).
const r2rRungs: ComponentInst[] = [0, 1, 2, 3].map<ComponentInst>((i) => ({
  id: `R${i}`,
  type: "Resistor",
  placement: { kind: "below", ref: `FF${i}`, gap: 4 },
  rotation: 3,
  properties: { resistance: 20000 },
  pinAttachments:
    i === 3
      ? {
          A: { kind: "tunnel", tunnel: `BIT_${i}` },
          B: { kind: "tunnel", tunnel: "DAC_OUT" },
        }
      : { A: { kind: "tunnel", tunnel: `BIT_${i}` } },
}));

// Horizontal R rungs (rotation: 0, default) joining the bottom of adjacent 2R rungs
const r2rJoiners: ComponentInst[] = [
  {
    id: "Ra",
    type: "Resistor",
    placement: {
      kind: "between",
      a: { component: "R0", pin: "B" },
      b: { component: "R1", pin: "B" },
    },
    properties: { resistance: 10000 },
  },
  {
    id: "Rb",
    type: "Resistor",
    placement: {
      kind: "between",
      a: { component: "R1", pin: "B" },
      b: { component: "R2", pin: "B" },
    },
    properties: { resistance: 10000 },
  },
  {
    id: "Rc",
    type: "Resistor",
    placement: {
      kind: "between",
      a: { component: "R2", pin: "B" },
      b: { component: "R3", pin: "B" },
    },
    properties: { resistance: 10000 },
  },
];

const sarAdc: CircuitSpec = {
  name: "SAR ADC 4-bit (DSL spike)",
  description:
    "4-bit SAR ADC: VIN → comparator → SAR write-gate → 4× D-FF → R-2R DAC → comparator (feedback). 2-bit down-counter sequences MSB→LSB. Generated from inline DSL spec; subcircuits are interface-only stubs.",
  rails: [{ name: "GND", side: "bottom" }],
  tunnels: [
    { name: "CLK" },
    { name: "RESET" },
    { name: "DECISION" },
    { name: "DAC_OUT" },
    { name: "CNT", bitWidth: 2 },
    { name: "BIT_0" },
    { name: "BIT_1" },
    { name: "BIT_2" },
    { name: "BIT_3" },
    { name: "WD_0" },
    { name: "WD_1" },
    { name: "WD_2" },
    { name: "WD_3" },
  ],
  subcircuits: [downCounter2b, sarWriteGate4],
  components: [
    // Vertical input source (rotation: 1 → pos at top, neg at bottom)
    {
      id: "VIN",
      type: "DcVoltageSource",
      placement: { kind: "at", at: { x: 2, y: 10 } },
      rotation: 1,
      properties: { voltage: 1.5 },
      pinAttachments: { neg: { kind: "rail", rail: "GND" } },
    },
    {
      id: "U1",
      type: "VoltageComparator",
      placement: { kind: "right_of", ref: "VIN", gap: 6 },
      pinAttachments: {
        "in-": { kind: "tunnel", tunnel: "DAC_OUT" },
        out: { kind: "tunnel", tunnel: "DECISION" },
      },
    },
    {
      id: "WGATE",
      type: "sar_write_gate_4",
      placement: { kind: "right_of", ref: "U1", gap: 6 },
      pinAttachments: {
        DEC: { kind: "tunnel", tunnel: "DECISION" },
        SEL: { kind: "tunnel", tunnel: "CNT", bitWidth: 2 },
        D0: { kind: "tunnel", tunnel: "WD_0" },
        D1: { kind: "tunnel", tunnel: "WD_1" },
        D2: { kind: "tunnel", tunnel: "WD_2" },
        D3: { kind: "tunnel", tunnel: "WD_3" },
      },
    },
    ...ffComponents,
    ...r2rRungs,
    ...r2rJoiners,
    // 2R termination on LSB end of ladder (vertical, B → GND rail)
    {
      id: "RT",
      type: "Resistor",
      // gap 0 so RT.A coincides with R0.B (and Ra.A)- single net by pin
      // coincidence, no extra wire stub needed.
      placement: { kind: "below", ref: "R0", gap: 0 },
      rotation: 3,
      properties: { resistance: 20000 },
      pinAttachments: { B: { kind: "rail", rail: "GND" } },
    },
    {
      id: "CTR",
      type: "down_counter_2b",
      placement: { kind: "at", at: { x: 60, y: 30 } },
      pinAttachments: {
        CLK: { kind: "tunnel", tunnel: "CLK" },
        RST: { kind: "tunnel", tunnel: "RESET" },
        Q: { kind: "tunnel", tunnel: "CNT", bitWidth: 2 },
      },
    },
  ],
  wires: [
    // Comparator input + ← VIN positive terminal (the only point-to-point wire
    //- WGATE→FF.D paths use tunnels to avoid L-shape collisions through FF.C.)
    { from: { component: "U1", pin: "in+" }, to: { component: "VIN", pin: "pos" } },
  ],
};

// ============================================================================
// CLI
// ============================================================================

function main(): void {
  const dts = emitDts(sarAdc);
  const outPath = resolvePath(
    process.cwd(),
    "circuits/sar_adc_4bit_from_dsl.dts",
  );
  if (!existsSync(dirname(outPath))) {
    mkdirSync(dirname(outPath), { recursive: true });
  }
  writeFileSync(outPath, JSON.stringify(dts, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log(`  Elements: ${dts.circuit.elements.length}`);
  console.log(`  Wires: ${dts.circuit.wires.length}`);
  console.log(
    `  Subcircuits: ${Object.keys(dts.subcircuitDefinitions ?? {}).length}`,
  );
}

main();
