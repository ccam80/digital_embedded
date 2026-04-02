/**
 * Circuit builder: programmatic circuit construction API
 */

import { Circuit, Wire } from '../core/circuit.js';
import type { ComponentRegistry, ComponentDefinition, AttributeMapping } from '../core/registry.js';
import type { PropertyValue } from '../core/properties.js';
import { PropertyBag, PropertyType } from '../core/properties.js';
import type { Pin } from '../core/pin.js';
import { pinWorldPosition } from '../core/pin.js';
import type { CircuitElement } from '../core/element.js';
import { FacadeError } from './types.js';
import type { CircuitBuildOptions, TestResults } from './types.js';
import { loadDig as loadDigFromXml } from '../io/dig-loader.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';
import { extractEmbeddedTestData } from './test-runner.js';
import { parseTestData } from '../testing/parser.js';
import { executeTests } from '../testing/executor.js';
import type { CircuitSpec, CircuitPatch, PatchOptions, PatchResult, Netlist } from './netlist-types.js';
import type { Diagnostic } from '../compile/types.js';
import { resolveComponent, resolvePin, resolveScope } from './address.js';
import { resolveNets } from './netlist.js';
import { autoLayout } from './auto-layout.js';
import type { LayoutConstraint } from './auto-layout.js';

const AUTO_POSITION_Y_STEP = 8;

/**
 * String similarity for suggesting corrections (Levenshtein-like heuristic)
 */
function levenshteinDistance(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return 0;

  const matrix: number[][] = Array(bLower.length + 1)
    .fill(0)
    .map(() => Array(aLower.length + 1).fill(0));

  for (let i = 0; i <= aLower.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= bLower.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= bLower.length; j++) {
    for (let i = 1; i <= aLower.length; i++) {
      const cost = aLower[i - 1] === bLower[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }

  return matrix[bLower.length][aLower.length];
}

/**
 * Find the closest matching string
 */
function findClosestMatch(
  query: string,
  candidates: string[]
): string | undefined {
  if (candidates.length === 0) return undefined;

  let best = candidates[0];
  let bestDistance = levenshteinDistance(query, best);

  for (const candidate of candidates) {
    const distance = levenshteinDistance(query, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return bestDistance <= 2 ? best : undefined;
}

/**
 * CircuitBuilder: Builds circuits programmatically
 */
export class CircuitBuilder {
  private elementPositionCounter = 0;

  constructor(private registry: ComponentRegistry) {}

  /**
   * Load a .dig XML string and produce a populated Circuit.
   *
   * Accepts a raw .dig XML string (starts with "<") and delegates to the
   * dig-loader pipeline: parseDigXml → loadDigCircuit → Circuit.
   *
   * @param xml - Raw .dig XML content
   * @returns Populated Circuit with all elements and wires
   * @throws DigParserError if any elementName is not registered in this builder's registry
   * @throws Error if the XML is malformed
   */
  loadDig(xml: string): Circuit {
    return loadDigFromXml(xml, this.registry);
  }

  /**
   * Create a new empty circuit
   */
  createCircuit(opts?: CircuitBuildOptions): Circuit {
    this.elementPositionCounter = 0;
    const meta: Partial<import('../core/circuit.js').CircuitMetadata> = {};
    if (opts?.name !== undefined) meta.name = opts.name;
    if (opts?.description !== undefined) meta.description = opts.description;
    return new Circuit(meta);
  }

  /**
   * Translate user-supplied property keys using the component's attributeMap.
   *
   * Accepts both XML-convention keys (e.g. "Bits") and internal keys
   * (e.g. "bitWidth"). XML keys are translated to internal keys via the
   * attributeMap. Unknown keys that don't match any propertyDef or
   * attributeMap entry are passed through with a console warning.
   */
  private translateProps(
    definition: ComponentDefinition,
    props: Record<string, PropertyValue>,
  ): Record<string, PropertyValue> {
    if (!props || Object.keys(props).length === 0) return props;

    const xmlToInternal = new Map<string, AttributeMapping>();
    for (const mapping of definition.attributeMap) {
      xmlToInternal.set(mapping.xmlName, mapping);
    }

    const knownKeys = new Set<string>();
    for (const pd of definition.propertyDefs) {
      knownKeys.add(pd.key);
    }
    // 'position' and 'label' are universal implicit keys
    knownKeys.add('position');
    knownKeys.add('label');

    const translated: Record<string, PropertyValue> = {};

    for (const [key, value] of Object.entries(props)) {
      // Already an internal key?
      if (knownKeys.has(key)) {
        translated[key] = this.coercePropertyValue(definition, key, value);
        continue;
      }

      // XML-convention key? Translate to internal.
      const mapping = xmlToInternal.get(key);
      if (mapping) {
        // Don't overwrite if the caller also supplied the internal key
        if (!(mapping.propertyKey in translated) && !(mapping.propertyKey in props)) {
          translated[mapping.propertyKey] = value;
        }
        continue;
      }

      // Unknown key — pass through (may be a component-specific key we
      // don't have a propertyDef for, e.g. dynamic subcircuit props)
      translated[key] = value;
    }

    return translated;
  }

  /**
   * Add a component to the circuit by type name
   * Auto-positions sequentially unless caller specifies position in props
   */
  addComponent(
    circuit: Circuit,
    typeName: string,
    props?: Record<string, PropertyValue>
  ): CircuitElement {
    const definition = this.registry.get(typeName);
    if (!definition) {
      const allNames = this.registry.getAll().map((d) => d.name);
      const suggestion = findClosestMatch(typeName, allNames);
      throw new FacadeError(
        suggestion
          ? `Unknown component type '${typeName}'. Did you mean '${suggestion}'?`
          : `Unknown component type '${typeName}'.`,
        typeName
      );
    }

    // Translate XML-convention keys (e.g. "Bits") to internal keys (e.g. "bitWidth")
    const resolvedProps = this.translateProps(definition, props || {});

    // Build property bag from defaults and caller props
    const bag = new PropertyBag();
    for (const [key, value] of Object.entries(resolvedProps)) {
      bag.set(key, value);
    }

    // Seed model param defaults from the default model entry, then overlay
    // any caller-specified values that were placed in _map.
    const defaultModelKey = definition.defaultModel ?? "";
    const defaultEntry = definition.modelRegistry?.[defaultModelKey];
    if (defaultEntry?.params) {
      bag.replaceModelParams({ ...defaultEntry.params });
    }
    if (definition.modelRegistry) {
      const paramKeys = new Set<string>();
      for (const entry of Object.values(definition.modelRegistry)) {
        if (entry.paramDefs) {
          for (const pd of entry.paramDefs) paramKeys.add(pd.key);
        }
      }
      for (const key of paramKeys) {
        if (bag.has(key)) {
          const val = bag.get(key);
          if (typeof val === 'number') {
            bag.setModelParam(key, val);
          }
        }
      }
    }

    // Auto-position unless caller specified position
    // Position stored as [x, y] number array (PropertyValue supports number[])
    if (!bag.has('position')) {
      bag.set('position', [0, this.elementPositionCounter * AUTO_POSITION_Y_STEP]);
    }

    const element = definition.factory(bag);

    // Factories create elements at (0,0) — apply the position from the bag.
    const pos = bag.has('position') ? bag.get<number[]>('position') : undefined;
    if (pos && pos.length >= 2) {
      element.position = { x: pos[0], y: pos[1] };
    }

    circuit.elements.push(element);
    this.elementPositionCounter++;

    return element;
  }

  /**
   * Connect two component pins with a wire. Validates pin labels exist.
   */
  connect(
    circuit: Circuit,
    src: CircuitElement,
    srcPinLabel: string,
    dst: CircuitElement,
    dstPinLabel: string
  ): Wire {
    const srcPin = this.findPin(src, srcPinLabel);
    if (!srcPin) {
      const validLabels = Array.from(src.getPins())
        .map((p) => p.label)
        .join(', ');
      throw new FacadeError(
        `Pin '${srcPinLabel}' not found on component '${src.typeId}'. Valid pins: ${validLabels}`,
        src.typeId,
        srcPinLabel
      );
    }

    const dstPin = this.findPin(dst, dstPinLabel);
    if (!dstPin) {
      const validLabels = Array.from(dst.getPins())
        .map((p) => p.label)
        .join(', ');
      throw new FacadeError(
        `Pin '${dstPinLabel}' not found on component '${dst.typeId}'. Valid pins: ${validLabels}`,
        dst.typeId,
        dstPinLabel
      );
    }

    // Create wire from pin world positions
    const srcWorldPos = this.getPinWorldPosition(src, srcPin);
    const dstWorldPos = this.getPinWorldPosition(dst, dstPin);

    const wire = new Wire(srcWorldPos, dstWorldPos);

    // Check for duplicate connections
    const isDuplicate = circuit.wires.some(
      (w) =>
        (w.start.x === wire.start.x &&
          w.start.y === wire.start.y &&
          w.end.x === wire.end.x &&
          w.end.y === wire.end.y) ||
        (w.start.x === wire.end.x &&
          w.start.y === wire.end.y &&
          w.end.x === wire.start.x &&
          w.end.y === wire.start.y)
    );

    if (isDuplicate) {
      throw new FacadeError('Duplicate wire connection not allowed');
    }

    circuit.wires.push(wire);
    return wire;
  }

  /**
   * Run all test vectors against the compiled engine.
   *
   * If testData is provided it is used as the test vector source.
   * Otherwise test data is extracted from Testcase components in the circuit.
   * Throws FacadeError if no test data is available from either source.
   *
   * @param coordinator    The compiled SimulationCoordinator.
   * @param circuit   The circuit (searched for Testcase components when testData absent).
   * @param testData  Optional external test vector string in Digital test format.
   * @returns         TestResults with per-vector pass/fail details.
   * @throws FacadeError if no test data is available.
   */
  async runTests(
    coordinator: SimulationCoordinator,
    circuit: Circuit,
    testData?: string,
  ): Promise<TestResults> {
    const resolvedData = testData ?? extractEmbeddedTestData(circuit);

    if (resolvedData === null || resolvedData.trim().length === 0) {
      throw new FacadeError(
        "No test data available: circuit contains no Testcase components and no external test data was provided.",
      );
    }

    const parsed = parseTestData(resolvedData);
    // Provide a minimal RunnerFacade inline — reads/writes via the coordinator directly.
    const runnerFacade = {
      setSignal(coord: SimulationCoordinator, label: string, value: number): void {
        const addr = coord.compiled.labelSignalMap.get(label);
        if (addr === undefined) {
          const available = [...coord.compiled.labelSignalMap.keys()].join(', ');
          throw new FacadeError(
            `Label "${label}" not found in compiled circuit. Available labels: ${available || '(none)'}`,
          );
        }
        if (addr.domain === 'analog') {
          coord.setSourceByLabel(label, '', value);
          return;
        }
        coord.writeSignal(addr, { type: 'digital', value });
      },
      readSignal(coord: SimulationCoordinator, label: string): number {
        const addr = coord.compiled.labelSignalMap.get(label);
        if (addr === undefined) {
          const available = [...coord.compiled.labelSignalMap.keys()].join(', ');
          throw new FacadeError(
            `Label "${label}" not found in compiled circuit. Available labels: ${available || '(none)'}`,
          );
        }
        const sv = coord.readSignal(addr);
        return sv.type === 'digital' ? sv.value : sv.voltage;
      },
      step(coord: SimulationCoordinator, _opts?: { clockAdvance?: boolean }): void {
        coord.step();
      },
      async settle(coord: SimulationCoordinator, settleTime = 0.01): Promise<void> {
        if (coord.simTime === null) {
          coord.step();
          return;
        }
        await coord.stepToTime(coord.simTime + settleTime);
      },
    };
    return executeTests(runnerFacade, coordinator, circuit, parsed);
  }

  // ---------------------------------------------------------------------------
  // build() — declarative circuit construction
  // ---------------------------------------------------------------------------

  /**
   * Build a Circuit from a declarative CircuitSpec.
   *
   * 1. Creates a new circuit with the spec's name/description.
   * 2. Adds each component (auto-positioned).
   * 3. Connects pins using "id:pin" addresses resolved against the local spec id map.
   */
  build(spec: CircuitSpec): Circuit {
    const circuitOpts: CircuitBuildOptions = {};
    if (spec.name !== undefined) circuitOpts.name = spec.name;
    if (spec.description !== undefined) circuitOpts.description = spec.description;
    const circuit = this.createCircuit(circuitOpts);

    // id → element map (spec-local ids, not necessarily user labels)
    const idMap = new Map<string, CircuitElement>();

    for (const comp of spec.components) {
      const element = this.addComponent(circuit, comp.type, comp.props);
      idMap.set(comp.id, element);
      // Use spec id as label fallback so netlist shows readable names instead of UUIDs
      const bag = element.getProperties();
      if (!bag.has('label') || !bag.get('label')) {
        bag.set('label', comp.id);
      }
    }

    for (const [fromAddr, toAddr] of spec.connections) {
      const fromColon = fromAddr.indexOf(':');
      const toColon = toAddr.indexOf(':');

      if (fromColon === -1 || toColon === -1) {
        throw new FacadeError(
          `Connection address must be "id:pin". Got: "${fromAddr}" → "${toAddr}"`,
        );
      }

      const srcId = fromAddr.slice(0, fromColon);
      const srcPinLabel = fromAddr.slice(fromColon + 1);
      const dstId = toAddr.slice(0, toColon);
      const dstPinLabel = toAddr.slice(toColon + 1);

      const src = idMap.get(srcId);
      if (!src) {
        throw new FacadeError(
          `Connection references unknown component id '${srcId}'. Known ids: ${[...idMap.keys()].join(', ')}`,
        );
      }

      const dst = idMap.get(dstId);
      if (!dst) {
        throw new FacadeError(
          `Connection references unknown component id '${dstId}'. Known ids: ${[...idMap.keys()].join(', ')}`,
        );
      }

      try {
        this.connect(circuit, src, srcPinLabel, dst, dstPinLabel);
      } catch (err) {
        // Re-throw with connection address context so agents can identify
        // which spec connection failed (connect() only knows pin labels).
        if (err instanceof FacadeError) {
          throw new FacadeError(
            `${err.message} (connection: "${fromAddr}" → "${toAddr}")`,
            err.componentName,
            err.pinLabel,
          );
        }
        throw err;
      }
    }

    // Collect layout constraints keyed by instanceId
    const constraints = new Map<string, LayoutConstraint>();
    for (const comp of spec.components) {
      if (comp.layout) {
        const el = idMap.get(comp.id);
        if (el) {
          const lc: LayoutConstraint = {};
          if (comp.layout.col !== undefined) lc.col = comp.layout.col;
          if (comp.layout.row !== undefined) lc.row = comp.layout.row;
          constraints.set(el.instanceId, lc);
        }
      }
    }

    // Auto-layout when there are connections to arrange
    if (spec.connections.length > 0) {
      autoLayout(circuit, constraints.size > 0 ? { constraints } : undefined);
    }

    // Clean up any degenerate zero-length wires produced by auto-layout or
    // connection routing before returning the circuit.
    circuit.removeZeroLengthWires();

    return circuit;
  }

  // ---------------------------------------------------------------------------
  // patch() — incremental circuit editing
  // ---------------------------------------------------------------------------

  /**
   * Apply a list of patch operations to an existing circuit in order.
   * After all ops, runs net resolution diagnostics and returns them.
   *
   * Components added via `add` ops are tracked by their `spec.id`. Later
   * ops in the same patch batch can reference them by `spec.id` in
   * `connect` fields and target addresses. The returned `PatchResult`
   * includes a map of `spec.id → instanceId` for all added components.
   *
   * @param circuit  The circuit to modify (mutated in place).
   * @param ops      Ordered list of patch operations.
   * @param opts     Options (scope is reserved for future subcircuit support).
   * @returns        PatchResult with diagnostics and addedIds map.
   */
  patch(circuit: Circuit, ops: CircuitPatch, opts?: PatchOptions): PatchResult {
    // Resolve the target circuit: top-level unless opts.scope narrows to a subcircuit.
    const targetCircuit =
      opts?.scope !== undefined
        ? resolveScope(circuit, this.registry, opts.scope)
        : circuit;

    // Track spec.id → CircuitElement for components added in this batch,
    // so later ops can reference them by spec.id.
    const addedElements = new Map<string, CircuitElement>();

    for (const op of ops) {
      switch (op.op) {
        case 'set': {
          const { element } = resolveComponent(targetCircuit, op.target);

          // Re-instantiate the element so pin widths reflect the new
          // properties (e.g. changing bitWidth must rebuild pins).
          const oldPosition = element.position;
          const oldRotation = element.rotation;
          const oldMirror = element.mirror;

          // Merge existing properties with the patch props.
          // Order: old bag first, then new props override, then position
          // (position must come last to prevent the old bag overwriting it).
          const mergedProps: Record<string, PropertyValue> = {};
          const oldBag = element.getProperties();
          for (const [key, value] of oldBag.entries()) {
            mergedProps[key] = value;
          }
          for (const [key, value] of Object.entries(op.props)) {
            mergedProps[key] = value;
          }
          mergedProps['position'] = [oldPosition.x, oldPosition.y];

          // Collect wire records (same as replace)
          const setWireRecords: { wire: Wire; pinLabel: string; atStart: boolean }[] = [];
          for (const pin of element.getPins()) {
            const pinPos = pinWorldPosition(element, pin);
            for (const wire of targetCircuit.wires) {
              if (wire.start.x === pinPos.x && wire.start.y === pinPos.y) {
                setWireRecords.push({ wire, pinLabel: pin.label, atStart: true });
              } else if (wire.end.x === pinPos.x && wire.end.y === pinPos.y) {
                setWireRecords.push({ wire, pinLabel: pin.label, atStart: false });
              }
            }
          }

          // Remove old wires and element
          for (const { wire } of setWireRecords) {
            targetCircuit.removeWire(wire);
          }
          targetCircuit.removeElement(element);

          // Create new element with merged properties
          const newSetElement = this.addComponent(targetCircuit, element.typeId, mergedProps);
          newSetElement.rotation = oldRotation;
          newSetElement.mirror = oldMirror;

          // Reconnect wires where pin labels match
          for (const { wire, pinLabel, atStart } of setWireRecords) {
            const newPin = newSetElement.getPins().find((p: Pin) => p.label === pinLabel);
            if (!newPin) continue;
            const newPinPos = pinWorldPosition(newSetElement, newPin);
            const newWire = atStart
              ? new Wire(newPinPos, wire.end)
              : new Wire(wire.start, newPinPos);
            targetCircuit.wires.push(newWire);
          }
          break;
        }

        case 'add': {
          // Place new component outside the existing circuit bounding box
          // to avoid coordinate collisions that merge unrelated nets.
          let addProps = op.spec.props;
          if (!addProps?.position) {
            const bbox = this.circuitBoundingBox(targetCircuit);
            addProps = {
              ...addProps,
              position: [bbox.maxX + 40, bbox.maxY + 40 + this.elementPositionCounter * AUTO_POSITION_Y_STEP],
            };
          }
          const newElement = this.addComponent(targetCircuit, op.spec.type, addProps);

          // Track by spec.id so later ops in this batch can reference it.
          addedElements.set(op.spec.id, newElement);

          if (op.connect) {
            for (const [newPinLabel, targetAddr] of Object.entries(op.connect)) {
              // Resolve the target pin. First check if the target component
              // was added in this same batch (forward reference by spec.id).
              const colonIdx = targetAddr.indexOf(':');
              const targetCompId = colonIdx !== -1 ? targetAddr.slice(0, colonIdx) : targetAddr;
              const targetPinLabel = colonIdx !== -1 ? targetAddr.slice(colonIdx + 1) : undefined;

              let targetElement: CircuitElement;
              let targetPin: Pin;

              const addedTarget = addedElements.get(targetCompId);
              if (addedTarget && targetPinLabel) {
                targetElement = addedTarget;
                const foundPin = addedTarget.getPins().find((p: Pin) => p.label === targetPinLabel);
                if (!foundPin) {
                  const validPins = Array.from(addedTarget.getPins()).map((p: Pin) => p.label).join(', ');
                  throw new FacadeError(
                    `Pin '${targetPinLabel}' not found on component '${targetCompId}' (type: ${addedTarget.typeId}). Valid pins: ${validPins}`,
                    targetCompId,
                    targetPinLabel,
                  );
                }
                targetPin = foundPin;
              } else {
                // Fall back to normal circuit-wide resolution
                const resolved = resolvePin(targetCircuit, targetAddr);
                targetElement = resolved.element;
                targetPin = resolved.pin;
              }

              // Connect new component pin to the target pin.
              const srcPin = newElement.getPins().find((p: Pin) => p.label === newPinLabel);
              if (!srcPin) {
                const validPins = Array.from(newElement.getPins()).map((p: Pin) => p.label).join(', ');
                throw new FacadeError(
                  `Pin '${newPinLabel}' not found on newly added component '${op.spec.type}'. Valid pins: ${validPins}`,
                  op.spec.type,
                  newPinLabel,
                );
              }

              const srcWorldPos = pinWorldPosition(newElement, srcPin);
              const dstWorldPos = pinWorldPosition(targetElement, targetPin);
              targetCircuit.wires.push(new Wire(srcWorldPos, dstWorldPos));
            }
          }
          break;
        }

        case 'remove': {
          const { element } = resolveComponent(targetCircuit, op.target);

          // Collect all pin world positions for this element.
          const pinPositions = element.getPins().map((p: Pin) => pinWorldPosition(element, p));

          // Remove wires that touch any of the element's pin positions.
          const wiresToRemove = targetCircuit.wires.filter((w) =>
            pinPositions.some(
              (pos) =>
                (w.start.x === pos.x && w.start.y === pos.y) ||
                (w.end.x === pos.x && w.end.y === pos.y),
            ),
          );
          for (const wire of wiresToRemove) {
            targetCircuit.removeWire(wire);
          }

          targetCircuit.removeElement(element);
          break;
        }

        case 'connect': {
          const { element: srcElement, pin: srcPin } = resolvePin(targetCircuit, op.from);
          const { element: dstElement, pin: dstPin } = resolvePin(targetCircuit, op.to);

          const srcWorldPos = pinWorldPosition(srcElement, srcPin);
          const dstWorldPos = pinWorldPosition(dstElement, dstPin);

          targetCircuit.wires.push(new Wire(srcWorldPos, dstWorldPos));
          break;
        }

        case 'disconnect': {
          const { element, pin } = resolvePin(targetCircuit, op.pin);
          const pinPos = pinWorldPosition(element, pin);

          const wiresToRemove = targetCircuit.wires.filter(
            (w) =>
              (w.start.x === pinPos.x && w.start.y === pinPos.y) ||
              (w.end.x === pinPos.x && w.end.y === pinPos.y),
          );
          for (const wire of wiresToRemove) {
            targetCircuit.removeWire(wire);
          }
          break;
        }

        case 'replace': {
          const { element: oldElement } = resolveComponent(targetCircuit, op.target);
          const oldPosition = oldElement.position;

          // Collect wires connected to the old element, recording which pin
          // labels (by world-position match) they were attached to.
          interface WireRecord {
            wire: Wire;
            oldPinLabel: string;
            /** true if the wire's start was at the old pin; false if end was */
            atStart: boolean;
          }
          const wireRecords: WireRecord[] = [];
          for (const oldPin of oldElement.getPins()) {
            const pinPos = pinWorldPosition(oldElement, oldPin);
            for (const wire of targetCircuit.wires) {
              if (wire.start.x === pinPos.x && wire.start.y === pinPos.y) {
                wireRecords.push({ wire, oldPinLabel: oldPin.label, atStart: true });
              } else if (wire.end.x === pinPos.x && wire.end.y === pinPos.y) {
                wireRecords.push({ wire, oldPinLabel: oldPin.label, atStart: false });
              }
            }
          }

          // Remove wires that were attached to the old element.
          for (const { wire } of wireRecords) {
            targetCircuit.removeWire(wire);
          }

          // Remove old element.
          targetCircuit.removeElement(oldElement);

          // Add new element at the same position.
          const propsWithPosition: Record<string, PropertyValue> = {
            position: [oldPosition.x, oldPosition.y],
            ...(op.props ?? {}),
          };
          const newElement = this.addComponent(targetCircuit, op.newType, propsWithPosition);

          // Reconnect wires where pin labels match between old and new types.
          for (const { wire, oldPinLabel, atStart } of wireRecords) {
            const newPin = newElement.getPins().find((p: Pin) => p.label === oldPinLabel);
            if (!newPin) continue; // pin label doesn't exist on new type — skip

            const newPinPos = pinWorldPosition(newElement, newPin);
            const newWire = atStart
              ? new Wire(newPinPos, wire.end)
              : new Wire(wire.start, newPinPos);
            targetCircuit.wires.push(newWire);
          }
          break;
        }
      }
    }

    // Build the addedIds map: spec.id → instanceId
    const addedIds: Record<string, string> = {};
    for (const [specId, element] of addedElements) {
      addedIds[specId] = element.instanceId;
    }

    // Clean up any degenerate zero-length wires left by connect/disconnect ops.
    targetCircuit.removeZeroLengthWires();

    // Validate the top-level circuit (not just the scoped subcircuit).
    return {
      diagnostics: resolveNets(circuit, this.registry).diagnostics,
      addedIds,
    };
  }

  /**
   * Extract a netlist view of the circuit: components, nets, and diagnostics.
   */
  netlist(circuit: Circuit): Netlist {
    return resolveNets(circuit, this.registry);
  }

  /**
   * Validate circuit structure, returning all diagnostics.
   */
  validate(circuit: Circuit): Diagnostic[] {
    return resolveNets(circuit, this.registry).diagnostics;
  }

  /**
   * Query the registry for a component type's definition.
   */
  describeComponent(typeName: string): ComponentDefinition | undefined {
    return this.registry.get(typeName);
  }

  /**
   * Compute the bounding box of all element positions and wire endpoints
   * in a circuit. Used to place new patch-added components outside the
   * existing coordinate space so wires don't accidentally merge nets.
   */
  private circuitBoundingBox(circuit: Circuit): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const el of circuit.elements) {
      const pos = el.position;
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x > maxX) maxX = pos.x;
      if (pos.y > maxY) maxY = pos.y;
      for (const pin of el.getPins()) {
        const wp = pinWorldPosition(el, pin);
        if (wp.x < minX) minX = wp.x;
        if (wp.y < minY) minY = wp.y;
        if (wp.x > maxX) maxX = wp.x;
        if (wp.y > maxY) maxY = wp.y;
      }
    }

    for (const w of circuit.wires) {
      for (const p of [w.start, w.end]) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }

    // Empty circuit fallback
    if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    return { minX, minY, maxX, maxY };
  }

  /**
   * Find a pin by label on a component
   */
  private findPin(element: CircuitElement, label: string): Pin | undefined {
    return element.getPins().find((p: Pin) => p.label === label);
  }

  /**
   * Validate that pin directions are compatible for connection.
   *
  /**
   * Calculate world position of a pin given its component and relative position
   */
  private getPinWorldPosition(
    element: CircuitElement,
    pin: Pin
  ): { x: number; y: number } {
    return pinWorldPosition(element, pin);
  }

  /**
   * Coerce a property value to its canonical type based on the propertyDef.
   * Handles HEX_DATA strings → number arrays so downstream consumers
   * (e.g. initializeBackingStores) always see the canonical type.
   */
  private coercePropertyValue(
    definition: ComponentDefinition,
    key: string,
    value: PropertyValue,
  ): PropertyValue {
    const propDef = definition.propertyDefs.find((pd) => pd.key === key);
    if (propDef === undefined) return value;

    if (propDef.type === PropertyType.HEX_DATA && typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) return [];
      return trimmed.split(/[\s,]+/).map((s) => parseInt(s, 16));
    }

    return value;
  }

}
