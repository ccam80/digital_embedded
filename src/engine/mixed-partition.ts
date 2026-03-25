/**
 * Mixed-mode circuit partitioner.
 *
 * When a circuit contains both analog-only and digital-only components,
 * the partitioner splits it into:
 *   - An outer analog circuit (analog + "both" elements)
 *   - An inner digital circuit (digital-only elements + In/Out at cut points)
 *
 * Cut points are nets that connect both domains. Bridge adapters are inserted
 * at cut points by the analog compiler, reusing the existing
 * MixedSignalCoordinator infrastructure.
 */

import { Circuit, Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { ComponentRegistry } from "../core/registry.js";
import { hasDigitalModel, hasAnalogModel } from "../core/registry.js";
import { pinWorldPosition } from "../core/pin.js";
import { PinDirection } from "../core/pin.js";
import { PropertyBag } from "../core/properties.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes one cut point between the analog and digital domains.
 *
 * Each cut point corresponds to one net in the original circuit where both
 * analog-domain and digital-domain element pins are connected.
 */
export interface MixedModeCutPoint {
  /** Unique label used as the In/Out label in the inner digital circuit. */
  label: string;

  /**
   * Direction from the digital partition's perspective:
   *   "in"  — analog drives digital (BridgeInputAdapter in analog, In element in digital)
   *   "out" — digital drives analog (BridgeOutputAdapter in analog, Out element in digital)
   */
  direction: "in" | "out";

  /** Label of the corresponding In/Out element in the inner digital circuit. */
  innerLabel: string;

  /** Bit width of the signal at this cut point. */
  bitWidth: number;

  /** World-space position in the outer circuit where this cut point sits. */
  position: { x: number; y: number };
}

/**
 * A partition of digital-only elements extracted from a mixed circuit.
 *
 * The analog compiler consumes this to create bridge instances and
 * coordinate the inner digital engine via MixedSignalCoordinator.
 */
export interface MixedModePartition {
  /** The inner digital circuit (digital-only elements + In/Out at cut points). */
  internalCircuit: Circuit;

  /** Cut-point mappings between the analog outer circuit and the digital inner circuit. */
  cutPoints: MixedModeCutPoint[];

  /** Instance name for diagnostics. */
  instanceName: string;
}

// ---------------------------------------------------------------------------
// Position key helper
// ---------------------------------------------------------------------------

function posKey(p: { x: number; y: number }): string {
  // Round to half-grid to handle floating-point jitter
  return `${Math.round(p.x * 2) / 2},${Math.round(p.y * 2) / 2}`;
}

// ---------------------------------------------------------------------------
// Union-Find on position keys
// ---------------------------------------------------------------------------

class PosUnionFind {
  private readonly _parent = new Map<string, string>();

  find(k: string): string {
    if (!this._parent.has(k)) this._parent.set(k, k);
    let curr = k;
    while (this._parent.get(curr) !== curr) {
      const p = this._parent.get(curr)!;
      this._parent.set(curr, this._parent.get(p) ?? p); // path compression
      curr = this._parent.get(curr)!;
    }
    return curr;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this._parent.set(ra, rb);
  }
}

// ---------------------------------------------------------------------------
// detectEngineMode
// ---------------------------------------------------------------------------

/**
 * Infrastructure component types that are engine-neutral.
 *
 * These components are used in any circuit regardless of engine type and
 * should not trigger mixed-mode detection. Without this, an analog circuit
 * containing In/Out/Ground (which default to engineType "digital") would
 * be falsely detected as "mixed".
 */
const NEUTRAL_TYPES = new Set([
  "In", "Out", "Ground", "VDD", "Const", "Probe", "Tunnel",
  "Splitter", "Driver", "NotConnected", "ScopeTrigger",
]);

/**
 * Scan a circuit's elements and determine the effective engine mode:
 *   - "digital" — only digital/both/neutral components
 *   - "analog"  — only analog/both/neutral components
 *   - "mixed"   — both analog-only and digital-only components present
 */
export function detectEngineMode(
  circuit: Circuit,
  registry: ComponentRegistry,
): "digital" | "analog" | "mixed" {
  let hasAnalogOnly = false;
  let hasDigitalOnly = false;

  for (const el of circuit.elements) {
    // Skip infrastructure components — they work in any engine
    if (NEUTRAL_TYPES.has(el.typeId)) continue;

    const def = registry.get(el.typeId);
    if (!def) continue;
    const defHasAnalog = hasAnalogModel(def);
    const defHasDigital = hasDigitalModel(def);
    if (defHasAnalog && !defHasDigital) hasAnalogOnly = true;
    else if (defHasDigital && !defHasAnalog) hasDigitalOnly = true;
    // both models present doesn't force either mode
  }

  if (hasAnalogOnly && hasDigitalOnly) return "mixed";
  if (hasAnalogOnly) return "analog";
  return "digital";
}

// ---------------------------------------------------------------------------
// partitionMixedCircuit
// ---------------------------------------------------------------------------

interface PinInfo {
  element: CircuitElement;
  pinLabel: string;
  direction: PinDirection;
  worldPos: { x: number; y: number };
  bitWidth: number;
  isDigital: boolean;
}

interface NetInfo {
  hasDigital: boolean;
  hasAnalog: boolean;
  digitalPins: PinInfo[];
}

/**
 * Partition a mixed circuit into an outer analog circuit and an inner
 * digital circuit with bridge cut points.
 *
 * The outer analog circuit contains analog and "both" components plus
 * all wires on nets that touch at least one analog-domain pin.
 *
 * The inner digital circuit contains digital-only components, wires on
 * nets that touch digital-domain pins, and In/Out bridge elements at
 * cut points.
 */
export function partitionMixedCircuit(
  circuit: Circuit,
  registry: ComponentRegistry,
): { analogCircuit: Circuit; partition: MixedModePartition } {
  // -------------------------------------------------------------------------
  // Step 1: Classify elements
  // -------------------------------------------------------------------------
  const digitalElements = new Set<CircuitElement>();
  const analogElements = new Set<CircuitElement>(); // analog + both + neutral

  for (const el of circuit.elements) {
    const def = registry.get(el.typeId);
    if (!def) continue;

    // Neutral infrastructure components go to the analog outer circuit
    // (they're handled by the analog engine's buildNodeMap for ground/label
    // resolution). They do NOT go into the digital partition.
    if (NEUTRAL_TYPES.has(el.typeId)) {
      analogElements.add(el);
      continue;
    }

    if (hasDigitalModel(def) && !hasAnalogModel(def)) {
      digitalElements.add(el);
    } else {
      analogElements.add(el);
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Build pin position → PinInfo mapping
  // -------------------------------------------------------------------------
  const posToPins = new Map<string, PinInfo[]>();

  for (const el of circuit.elements) {
    const isDigit = digitalElements.has(el);
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      const key = posKey(wp);
      if (!posToPins.has(key)) posToPins.set(key, []);
      posToPins.get(key)!.push({
        element: el,
        pinLabel: pin.label,
        direction: pin.direction,
        worldPos: wp,
        bitWidth: pin.bitWidth,
        isDigital: isDigit,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Build union-find on wire endpoint positions to identify nets
  // -------------------------------------------------------------------------
  const uf = new PosUnionFind();

  for (const wire of circuit.wires) {
    uf.union(posKey(wire.start), posKey(wire.end));
  }

  // Also union pin positions with wire endpoints at the same location
  // (implicit via posKey — same key = same union-find entry)

  // -------------------------------------------------------------------------
  // Step 4: Classify nets by domain
  // -------------------------------------------------------------------------
  const nets = new Map<string, NetInfo>();

  function getNet(pk: string): NetInfo {
    const root = uf.find(pk);
    if (!nets.has(root)) {
      nets.set(root, { hasDigital: false, hasAnalog: false, digitalPins: [] });
    }
    return nets.get(root)!;
  }

  for (const [pk, pins] of posToPins) {
    const net = getNet(pk);
    for (const p of pins) {
      if (p.isDigital) {
        net.hasDigital = true;
        net.digitalPins.push(p);
      } else {
        net.hasAnalog = true;
      }
    }
  }

  // Also ensure wire endpoint positions are registered in the union-find
  // (even if they don't touch any pin — routing junctions).
  for (const wire of circuit.wires) {
    getNet(posKey(wire.start));
    getNet(posKey(wire.end));
  }

  // -------------------------------------------------------------------------
  // Step 5: Identify cut nets and build cut points
  // -------------------------------------------------------------------------
  const cutPoints: MixedModeCutPoint[] = [];
  let cutIdx = 0;
  const processedRoots = new Set<string>();

  for (const [pk] of posToPins) {
    const root = uf.find(pk);
    if (processedRoots.has(root)) continue;
    processedRoots.add(root);

    const net = nets.get(root);
    if (!net || !net.hasDigital || !net.hasAnalog) continue;

    // This is a cut net — determine direction from the digital side.
    const hasDigitalOutput = net.digitalPins.some(
      (p) => p.direction === PinDirection.OUTPUT,
    );
    const hasDigitalInput = net.digitalPins.some(
      (p) => p.direction === PinDirection.INPUT,
    );

    if (hasDigitalOutput) {
      const pin = net.digitalPins.find((p) => p.direction === PinDirection.OUTPUT)!;
      const label = `_mxb_o${cutIdx}`;
      cutPoints.push({
        label,
        direction: "out",
        innerLabel: label,
        bitWidth: pin.bitWidth,
        position: { x: pin.worldPos.x, y: pin.worldPos.y },
      });
      cutIdx++;
    }

    if (hasDigitalInput) {
      const pin = net.digitalPins.find((p) => p.direction === PinDirection.INPUT)!;
      const label = `_mxb_i${cutIdx}`;
      cutPoints.push({
        label,
        direction: "in",
        innerLabel: label,
        bitWidth: pin.bitWidth,
        position: { x: pin.worldPos.x, y: pin.worldPos.y },
      });
      cutIdx++;
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Build inner digital circuit
  // -------------------------------------------------------------------------
  const innerCircuit = new Circuit({ engineType: "digital" });

  // Add digital-only elements (shared references — compilers don't mutate)
  for (const el of digitalElements) {
    innerCircuit.addElement(el);
  }

  // Add all wires in nets that have digital pins.
  // This ensures routing wires (junctions without pins) are preserved.
  // Use original Wire references so the digital compiler can match them.
  for (const wire of circuit.wires) {
    const root = uf.find(posKey(wire.start));
    const net = nets.get(root);
    if (net?.hasDigital) {
      innerCircuit.addWire(wire);
    }
  }

  // Add In/Out bridge elements at cut points
  for (const cp of cutPoints) {
    const typeName = cp.direction === "in" ? "In" : "Out";
    const def = registry.get(typeName);
    if (!def) continue;

    const props = new PropertyBag([
      ["label", cp.label],
      ["bitWidth", cp.bitWidth],
    ]);

    const el = def.factory(props);
    // In and Out pins are at {0,0} relative to element position.
    // Place element at the cut-point position so the pin overlaps
    // with the wire endpoint and digital element pin.
    (el as { position: { x: number; y: number } }).position = {
      x: cp.position.x,
      y: cp.position.y,
    };

    innerCircuit.addElement(el);
  }

  // -------------------------------------------------------------------------
  // Step 7: Build outer analog circuit
  // -------------------------------------------------------------------------
  const analogCircuit = new Circuit({ engineType: "analog" });

  // Copy metadata from original circuit (preserving logicFamily, etc.)
  analogCircuit.metadata = { ...circuit.metadata, engineType: "analog" };

  // Add analog/both elements
  for (const el of analogElements) {
    analogCircuit.addElement(el);
  }

  // Add all wires in nets that have analog pins.
  // CRITICAL: use original Wire references so wireToNodeId lookups from
  // app-init (which queries with original circuit wires) still work.
  for (const wire of circuit.wires) {
    const root = uf.find(posKey(wire.start));
    const net = nets.get(root);
    if (net?.hasAnalog) {
      analogCircuit.addWire(wire);
    }
  }

  return {
    analogCircuit,
    partition: {
      internalCircuit: innerCircuit,
      cutPoints,
      instanceName: "MixedDigitalPartition",
    },
  };
}
