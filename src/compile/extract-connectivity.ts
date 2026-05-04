/**
 * Unified connectivity extraction- Phase 3 core algorithm.
 *
 * Single pass that works for digital, analog, and mixed circuits.
 */

import type { CircuitElement } from '../core/element.js';
import type { Wire } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';
import { pinWorldPosition } from '../core/pin.js';
import { PinDirection } from '../core/pin.js';
import { UnionFind } from './union-find.js';
import type { ConnectivityGroup, ResolvedGroupPin } from './types.js';
import type { Diagnostic } from './types.js';

// ---------------------------------------------------------------------------
// Infrastructure component types- engine-neutral, carry no domain signal
// ---------------------------------------------------------------------------

export const INFRASTRUCTURE_TYPES = new Set([
  'Wire', 'Tunnel', 'Ground', 'Probe',
  'Splitter', 'Driver', 'NotConnected', 'ScopeTrigger', 'Port',
]);

// ---------------------------------------------------------------------------
// ModelAssignment- per-element active model resolution
// ---------------------------------------------------------------------------

export interface ModelAssignment {
  /** Index into the elements array. */
  elementIndex: number;
  /**
   * Active model key: "digital" | a named analog model key | "neutral".
   * "neutral" for infrastructure components (Wire, Tunnel, Ground, etc.)
   * that carry no simulation model but are still part of connectivity.
   */
  modelKey: string;
  /** The resolved model object, or null for neutral/infrastructure elements. */
  model: import('../core/registry.js').DigitalModel | null;
}

/**
 * Resolve the active model for every element in the circuit.
 *
 * For each element, look up `def.models` and determine the active model key.
 * Infrastructure components (Wire, Tunnel, Ground, etc.) are tagged as
 * neutral- they participate in connectivity but have no simulation model.
 */
export function resolveModelAssignments(
  elements: readonly CircuitElement[],
  registry: ComponentRegistry,
  runtimeModels?: Record<string, Record<string, import('../core/registry.js').ModelEntry>>,
): [ModelAssignment[], Diagnostic[]] {
  const result: ModelAssignment[] = [];
  const diagnostics: Diagnostic[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;

    if (INFRASTRUCTURE_TYPES.has(el.typeId)) {
      result.push({ elementIndex: i, modelKey: 'neutral', model: null });
      continue;
    }

    const def = registry.getStandalone(el.typeId);
    if (def === undefined) {
      result.push({ elementIndex: i, modelKey: 'neutral', model: null });
      continue;
    }

    const props = el.getProperties();

    // Resolve the requested model key from component properties.
    const requestedKey = props.has('model') ? props.get<string>('model') : undefined;

    // Collect all available model keys for this component.
    // modelRegistry is the canonical source for analog models.
    // Runtime models from circuit.metadata.models are also valid keys.
    const hasDigital = Boolean(def.models?.digital);
    const staticKeys = def.modelRegistry ? Object.keys(def.modelRegistry) : [];
    const runtimeKeys = runtimeModels?.[el.typeId] ? Object.keys(runtimeModels[el.typeId]!) : [];
    const mnaKeys = runtimeKeys.length > 0 ? [...new Set([...staticKeys, ...runtimeKeys])] : staticKeys;
    // The element's "model" property is the source of truth (set at creation).
    // requestedKey comes from the element's bag.
    // IMPLEMENTATION FAILURE- does not match ngspice spec.
    // Original excuse: "Fall back to definition only for legacy circuits that predate model-property-at-creation"
    // Remedy: re-implement per spec. Do not weaken tests. Do not patch symptoms.
    // See spec/reviews/ for the finding that identified this.
    const candidateKey = requestedKey ?? def.defaultModel ?? (hasDigital ? 'digital' : mnaKeys[0] ?? 'neutral');

    // Validate the candidate key against available models.
    // Valid keys: "digital" (when digital model exists), any key in mnaKeys,
    // or the component's own defaultModel (trusted by definition).
    const isValidKey =
      (candidateKey === 'digital' && hasDigital) ||
      mnaKeys.includes(candidateKey) ||
      candidateKey === def.defaultModel;

    let modelKey: string;
    if (requestedKey !== undefined && !isValidKey) {
      // User-provided key is not valid for this component- emit diagnostic and neutralize.
      diagnostics.push({
        severity: 'warning',
        code: 'invalid-simulation-model',
        message: `Component "${def.name}" has no model "${requestedKey}". Valid models: ${[hasDigital ? 'digital' : undefined, ...mnaKeys].filter(Boolean).join(', ') || '(none)'}`,
      });
      modelKey = 'neutral';
    } else if (candidateKey === 'neutral') {
      modelKey = 'neutral';
    } else {
      modelKey = candidateKey;
    }

    let model: import('../core/registry.js').DigitalModel | null;
    if (modelKey === 'digital') {
      model = def.models?.digital ?? null;
    } else {
      model = null;
    }

    result.push({ elementIndex: i, modelKey, model });
  }

  return [result, diagnostics];
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/**
 * Map a model key to a domain string used by the partition system.
 *
 * Returns "analog" for all non-digital, non-neutral keys because
 * partition.ts checks `g.domains.has("analog")`.
 */
function resolveDomainFromModelKey(modelKey: string): string {
  if (modelKey === 'digital') return 'digital';
  if (modelKey === 'neutral') return 'neutral';
  return 'analog';
}

// ---------------------------------------------------------------------------
// extractConnectivityGroups- the unified netlist extraction algorithm
// ---------------------------------------------------------------------------

/**
 * Unified netlist extraction algorithm.
 *
 * Algorithm (spec Section 4.3):
 * 1. Collect slots: assign each pin a numeric slot ID, each wire endpoint
 *    two virtual slot IDs. Union wire start↔end virtual slots.
 * 2. Position-merge: union all slots at the same world-space position.
 * 3. Tunnel-merge: union all Tunnel-component pin slots sharing a label.
 *    Digital tunnels use "label" property; analog tunnels use "NetName"
 *    property. Both are checked (NetName preferred if present).
 * 4. Extract groups: walk union-find; build ConnectivityGroup per component.
 * 5. Tag domains: each group's `domains` = union of all pin domains.
 * 6. Validate widths: digital pins in a group must agree on bit width;
 *    mismatches produce diagnostics.
 *
 * Returns [groups, diagnostics].
 */
export function extractConnectivityGroups(
  elements: readonly CircuitElement[],
  wires: readonly Wire[],
  _registry: ComponentRegistry,
  modelAssignments: ModelAssignment[],
): [ConnectivityGroup[], Diagnostic[]] {
  const diagnostics: Diagnostic[] = [];
  const componentCount = elements.length;

  // -------------------------------------------------------------------------
  // Step 1: Compute slot base offsets and collect all pins
  // -------------------------------------------------------------------------

  const allPins = elements.map((el) => el.getPins());

  const slotBase: number[] = new Array(componentCount).fill(0);
  let totalPinSlots = 0;
  for (let i = 0; i < componentCount; i++) {
    slotBase[i] = totalPinSlots;
    totalPinSlots += allPins[i]!.length;
  }

  // Wire virtual slots start after all pin slots
  // Each wire gets 2 virtual slot IDs: wireVirtualBase + k*2 (start) and +k*2+1 (end)
  const wireVirtualBase = totalPinSlots;
  const totalSlots = totalPinSlots + wires.length * 2;

  const uf = new UnionFind(totalSlots);

  // -------------------------------------------------------------------------
  // Step 2: Build position map; add wire virtual slots; union wire endpoints
  // -------------------------------------------------------------------------

  const posToSlots = new Map<string, number[]>();

  function addToPos(key: string, slot: number): void {
    let list = posToSlots.get(key);
    if (list === undefined) {
      list = [];
      posToSlots.set(key, list);
    }
    list.push(slot);
  }

  // Add pin slots at their world positions
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const pins = allPins[i]!;
    for (let j = 0; j < pins.length; j++) {
      const pin = pins[j]!;
      const wp = pinWorldPosition(el, pin);
      addToPos(`${wp.x},${wp.y}`, slotBase[i]! + j);
    }
  }

  // Add wire virtual slots and union their endpoints
  for (let k = 0; k < wires.length; k++) {
    const wire = wires[k]!;
    const startSlot = wireVirtualBase + k * 2;
    const endSlot = wireVirtualBase + k * 2 + 1;
    addToPos(`${wire.start.x},${wire.start.y}`, startSlot);
    addToPos(`${wire.end.x},${wire.end.y}`, endSlot);
    // A wire electrically connects its two endpoints
    uf.union(startSlot, endSlot);
  }

  // Position-merge: union all slots at the same world position
  for (const slots of posToSlots.values()) {
    if (slots.length > 1) {
      for (let m = 1; m < slots.length; m++) {
        uf.union(slots[0]!, slots[m]!);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Label-merge- union pin slots for same-label Tunnel/Port components.
  // Tunnel and Port both have one pin and a label. Same label = same net.
  // -------------------------------------------------------------------------

  const labelMergeSlots = new Map<string, number[]>();

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    if (el.typeId !== 'Tunnel' && el.typeId !== 'Port') continue;

    // Tunnel: prefer NetName (analog convention), fall back to label (digital)
    // Port: uses label only
    let mergeLabel: string | null = null;
    if (el.typeId === 'Tunnel') {
      const netName = el.getAttribute('NetName');
      const label = el.getAttribute('label');
      mergeLabel =
        (typeof netName === 'string' && netName.length > 0)
          ? netName
          : (typeof label === 'string' && label.length > 0)
            ? label
            : null;
    } else {
      const label = el.getAttribute('label');
      mergeLabel = (typeof label === 'string' && label.length > 0) ? label : null;
    }

    if (mergeLabel === null) continue;

    const pins = allPins[i]!;
    if (pins.length === 0) continue;

    // Both Tunnel and Port have exactly one pin (index 0)
    const pinSlot = slotBase[i]! + 0;

    let slots = labelMergeSlots.get(mergeLabel);
    if (slots === undefined) {
      slots = [];
      labelMergeSlots.set(mergeLabel, slots);
    }
    slots.push(pinSlot);
  }

  for (const slots of labelMergeSlots.values()) {
    for (let m = 1; m < slots.length; m++) {
      uf.union(slots[0]!, slots[m]!);
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Walk union-find to assign group IDs (pin slots only)
  // -------------------------------------------------------------------------

  // Map from union-find root → sequential group ID
  const rootToGroupId = new Map<number, number>();
  let nextGroupId = 0;

  for (let slot = 0; slot < totalPinSlots; slot++) {
    const root = uf.find(slot);
    if (!rootToGroupId.has(root)) {
      rootToGroupId.set(root, nextGroupId++);
    }
  }

  // Wire-only groups: wires whose both endpoints share no position with any pin,
  // but only when the circuit has elements (wire-only circuits have no groups).
  if (totalPinSlots > 0) {
    for (let k = 0; k < wires.length; k++) {
      const startSlot = wireVirtualBase + k * 2;
      const root = uf.find(startSlot);
      if (!rootToGroupId.has(root)) {
        rootToGroupId.set(root, nextGroupId++);
      }
    }
  }

  const groupCount = nextGroupId;

  // -------------------------------------------------------------------------
  // Step 5: Build ResolvedGroupPin[] per group
  // -------------------------------------------------------------------------

  // groupPins[groupId] = list of resolved pins in that group
  const groupPins: ResolvedGroupPin[][] = Array.from({ length: groupCount }, () => []);
  // groupWires[groupId] = set of wire indices in that group
  const groupWireIndices: Set<number>[] = Array.from({ length: groupCount }, () => new Set());

  // Populate pin membership
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const pins = allPins[i]!;
    const assignment = modelAssignments[i]!;
    const domain = resolveDomainFromModelKey(assignment.modelKey);

    for (let j = 0; j < pins.length; j++) {
      const pin = pins[j]!;
      const slot = slotBase[i]! + j;
      const root = uf.find(slot);
      const groupId = rootToGroupId.get(root)!;

      const wp = pinWorldPosition(el, pin);

      groupPins[groupId]!.push({
        elementIndex: i,
        pinIndex: j,
        pinLabel: pin.label,
        direction: pin.direction as PinDirection,
        bitWidth: pin.bitWidth,
        worldPosition: wp,
        wireVertex: null,
        domain,
        kind: pin.kind ?? "signal",
      });

    }
  }

  // Populate wire membership- a wire belongs to a group if either of its
  // virtual slots maps to a group (which it does if it shares position with a pin)
  for (let k = 0; k < wires.length; k++) {
    const startSlot = wireVirtualBase + k * 2;
    const root = uf.find(startSlot);
    const groupId = rootToGroupId.get(root);
    if (groupId !== undefined) {
      groupWireIndices[groupId]!.add(k);
    }
    // Also check end slot (in case the start slot is isolated)
    const endSlot = wireVirtualBase + k * 2 + 1;
    const endRoot = uf.find(endSlot);
    const endGroupId = rootToGroupId.get(endRoot);
    if (endGroupId !== undefined) {
      groupWireIndices[endGroupId]!.add(k);
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Build ConnectivityGroup[] with domain tags and width validation
  // -------------------------------------------------------------------------

  const groups: ConnectivityGroup[] = [];

  for (let groupId = 0; groupId < groupCount; groupId++) {
    const pins = groupPins[groupId]!;

    // Tag domains: union of all pin domains (excluding neutral)
    const domains = new Set<string>();
    for (const pin of pins) {
      if (pin.domain !== 'neutral') {
        domains.add(pin.domain);
      }
    }

    // Collect wires for this group
    const groupWires = [...groupWireIndices[groupId]!].map((k) => wires[k]!);

    // Determine bit width: check all digital pins agree
    let groupBitWidth: number | undefined;
    let widthMismatch = false;

    for (const pin of pins) {
      if (pin.domain !== 'digital') continue;
      if (groupBitWidth === undefined) {
        groupBitWidth = pin.bitWidth;
      } else if (groupBitWidth !== pin.bitWidth) {
        widthMismatch = true;
        break;
      }
    }

    if (widthMismatch) {
      const digitalPins = pins.filter((p) => p.domain === 'digital');
      const analogPins = pins.filter((p) => p.domain === 'analog');

      // Suppress when both sides are analog (both will be 1-bit nominal)
      if (analogPins.length > 0 && digitalPins.length === 0) {
        // purely analog mismatch- suppress
      } else if (analogPins.length > 0 && digitalPins.length > 0) {
        // Analog terminal connected to multi-bit digital bus
        const multiBitDigital = digitalPins.find((p) => p.bitWidth > 1);
        if (multiBitDigital !== undefined) {
          const elLabel = (elements[multiBitDigital.elementIndex]?.getProperties().getOrDefault<string>('label', '') || elements[multiBitDigital.elementIndex]?.instanceId) ?? 'unknown';
          diagnostics.push({
            severity: 'error',
            code: 'width-mismatch',
            message: `Analog terminal connected to multi-bit digital bus at ${elLabel}:${multiBitDigital.pinLabel} [${multiBitDigital.bitWidth}-bit]`,
            netId: groupId,
            involvedPositions: digitalPins.concat(analogPins).map((p) => p.worldPosition),
            suggestions: [{ text: 'Use a single-bit digital signal to interface with an analog terminal.', automatable: false }],
          });
        }
      } else {
        // Pure digital width mismatch- name the pins
        const pinDescs = digitalPins.map((p) => {
          const elLabel = (elements[p.elementIndex]?.getProperties().getOrDefault<string>('label', '') || elements[p.elementIndex]?.instanceId) ?? 'unknown';
          return `${elLabel}:${p.pinLabel} [${p.bitWidth}-bit]`;
        });
        diagnostics.push({
          severity: 'error',
          code: 'width-mismatch',
          message: `Bit-width mismatch: ${pinDescs.join(' \u2194 ')}`,
          netId: groupId,
          involvedPositions: digitalPins.map((p) => p.worldPosition),
          suggestions: [{ text: `Ensure all pins on this net have the same bit width.`, automatable: false }],
        });
      }
    }

    const group: import('./types.js').ConnectivityGroup = {
      groupId,
      pins,
      wires: groupWires,
      domains,
      ...(!widthMismatch && groupBitWidth !== undefined ? { bitWidth: groupBitWidth } : {}),
    };
    groups.push(group);
  }

  // -------------------------------------------------------------------------
  // Step 7: Post-group diagnostics- unconnected input, floating terminal,
  // multi-driver
  // -------------------------------------------------------------------------

  for (const group of groups) {
    const pins = group.pins;

    // Skip infrastructure-only groups (no domain tags means all neutral)
    if (group.domains.size === 0) continue;

    // -----------------------------------------------------------------------
    // Unconnected input / floating terminal: single-pin groups
    // -----------------------------------------------------------------------
    if (pins.length === 1) {
      const pin = pins[0]!;

      if (pin.domain === 'digital' && pin.direction === PinDirection.INPUT) {
        // Skip infrastructure components (Tunnels, Ports, etc.) that are
        // legitimately undriven at this level
        const el = elements[pin.elementIndex];
        if (el === undefined || INFRASTRUCTURE_TYPES.has(el.typeId)) continue;

        const elLabel = (el.getProperties().getOrDefault<string>('label', '') || el.instanceId);
        diagnostics.push({
          severity: 'warning',
          code: 'unconnected-input',
          message: `Unconnected input: ${elLabel}:${pin.pinLabel}`,
          netId: group.groupId,
          involvedPositions: [pin.worldPosition],
          suggestions: [{ text: `Connect this input pin to a signal source.`, automatable: false }],
        });
      } else if (pin.domain === 'analog') {
        const el = elements[pin.elementIndex];
        if (el === undefined || INFRASTRUCTURE_TYPES.has(el.typeId)) continue;

        const elLabel = (el.getProperties().getOrDefault<string>('label', '') || el.instanceId);
        diagnostics.push({
          severity: 'warning',
          code: 'floating-terminal',
          message: `Floating terminal: ${elLabel}:${pin.pinLabel}`,
          netId: group.groupId,
          involvedPositions: [pin.worldPosition],
          suggestions: [{ text: `Connect this terminal to a net.`, automatable: false }],
        });
      }

      continue;
    }

    // -----------------------------------------------------------------------
    // Multi-driver: suppress when all pins on the group are analog-domain
    // -----------------------------------------------------------------------
    const allAnalog = pins.every((p) => p.domain === 'analog');
    if (allAnalog) continue;

    const outputDigitalPins = pins.filter(
      (p) => p.domain === 'digital' && p.direction === PinDirection.OUTPUT,
    );
    if (outputDigitalPins.length > 1) {
      diagnostics.push({
        severity: 'warning',
        code: 'multi-driver-no-tristate',
        message: `Net ${group.groupId} has ${outputDigitalPins.length} output drivers. Valid only when all drivers support tri-state (high-Z) output.`,
        netId: group.groupId,
        involvedPositions: outputDigitalPins.map((p) => p.worldPosition),
        suggestions: [{ text: `Use tri-state outputs or ensure only one driver is active at a time.`, automatable: false }],
      });
    }
  }

  return [groups, diagnostics];
}

// ---------------------------------------------------------------------------
// stableNetId- stable string identifier for a connectivity group
// ---------------------------------------------------------------------------

/**
 * Compute a stable string identifier for a connectivity group that survives
 * save/load/recompile cycles.
 *
 * Priority:
 * 1. If any pin in the group belongs to a Tunnel or Port element with a
 *    non-empty label, use `label:<label>`.
 * 2. Otherwise, use the canonical pin: sort group.pins by (instanceId, pinIndex)
 *    ascending and take the first entry, producing `pin:<instanceId>:<pinLabel>`.
 */
export function stableNetId(
  group: ConnectivityGroup,
  elements: readonly CircuitElement[],
): string {
  for (const pin of group.pins) {
    const el = elements[pin.elementIndex];
    if (el === undefined) continue;
    if (el.typeId === 'Tunnel' || el.typeId === 'Port') {
      const label = el.getProperties().getOrDefault<string>('label', '');
      if (label.length > 0) return `label:${label}`;
    }
  }
  const sorted = [...group.pins]
    .map((pin) => ({ ...pin, instanceId: elements[pin.elementIndex]!.instanceId }))
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId) || a.pinIndex - b.pinIndex);
  const canon = sorted[0]!;
  const el = elements[canon.elementIndex]!;
  const label = el.getPins()[canon.pinIndex]?.label ?? `pin${canon.pinIndex}`;
  return `pin:${el.instanceId}:${label}`;
}

// ---------------------------------------------------------------------------
// PinLoadingOverride- per-net override type (mirrors CircuitMetadata field)
// ---------------------------------------------------------------------------

/**
 * A per-net override for digital pin loading mode.
 * anchor identifies the net by a stable net ID:
 *   - { type: "label"; label: string }- for named nets (Tunnel/Port label)
 *   - { type: "pin"; instanceId: string; pinLabel: string }- for unnamed nets
 */
export interface PinLoadingOverride {
  anchor:
    | { type: 'label'; label: string }
    | { type: 'pin'; instanceId: string; pinLabel: string };
  loading: 'loaded' | 'ideal';
}

// ---------------------------------------------------------------------------
// applyLoadingDecisions- inject "analog" domain into digital-only nets
// ---------------------------------------------------------------------------

/**
 * Mutate connectivity groups to reflect loading decisions.
 *
 * For each group that contains "digital" but not "analog":
 *   - If a per-net override says "loaded" → add "analog" to domains.
 *   - Else if digitalPinLoading === "all" → add "analog" to domains.
 *
 * For boundary groups (already have both "digital" and "analog"):
 *   - If a per-net override says "ideal" → set group.loadingMode = "ideal".
 *
 * Groups that are digital-only and receive a per-net "ideal" override are
 * left unchanged: "ideal" only makes sense on an already-boundary group.
 */
export function applyLoadingDecisions(
  groups: ConnectivityGroup[],
  digitalPinLoading: "cross-domain" | "all" | "none",
  perNetOverrides: ReadonlyMap<number, "loaded" | "ideal">,
): void {
  for (const group of groups) {
    const isDigital = group.domains.has("digital");
    const isAnalog = group.domains.has("analog");

    if (isDigital && !isAnalog) {
      const override = perNetOverrides.get(group.groupId);
      if (override === "loaded") {
        group.domains.add("analog");
      } else if (digitalPinLoading === "all") {
        group.domains.add("analog");
      }
    } else if (isDigital && isAnalog) {
      const override = perNetOverrides.get(group.groupId);
      if (override === "ideal") {
        group.loadingMode = "ideal";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// resolveLoadingOverrides- match per-net overrides to connectivity groups
// ---------------------------------------------------------------------------

/**
 * Match each PinLoadingOverride to the corresponding ConnectivityGroup.
 *
 * Returns:
 *   - resolved: Map from groupId → loading mode for all overrides that matched
 *   - diagnostics: one "orphaned-pin-loading-override" warning per unmatched override
 */
export function resolveLoadingOverrides(
  overrides: readonly PinLoadingOverride[],
  groups: readonly ConnectivityGroup[],
  elements: readonly CircuitElement[],
): { resolved: Map<number, 'loaded' | 'ideal'>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const resolved = new Map<number, 'loaded' | 'ideal'>();

  if (overrides.length === 0) return { resolved, diagnostics };

  const netIdToGroup = new Map<string, ConnectivityGroup>();
  for (const group of groups) {
    const id = stableNetId(group, elements);
    netIdToGroup.set(id, group);
  }

  for (const override of overrides) {
    let stableId: string;
    if (override.anchor.type === 'label') {
      stableId = `label:${override.anchor.label}`;
    } else {
      stableId = `pin:${override.anchor.instanceId}:${override.anchor.pinLabel}`;
    }

    const group = netIdToGroup.get(stableId);
    if (group === undefined) {
      diagnostics.push({
        severity: 'warning',
        code: 'orphaned-pin-loading-override',
        message: `Per-net loading override references net "${stableId}" which does not exist in the circuit`,
      });
    } else {
      resolved.set(group.groupId, override.loading);
    }
  }

  return { resolved, diagnostics };
}
