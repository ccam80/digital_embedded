/**
 * Transistor model expansion — compile-time analog circuit expansion.
 *
 * expandTransistorModel() takes a subcircuit name referencing a registered
 * MnaSubcircuitNetlist in the SubcircuitModelRegistry, and expands it into
 * a flat list of AnalogElement instances.
 *
 * Port nets in the subcircuit netlist are mapped to the outer circuit's MNA
 * nodes by matching port labels to the component's pin layout. Special ports
 * labeled 'VDD' and 'GND' are mapped to the shared VDD node and ground
 * (node 0) respectively.
 *
 * Internal nets are assigned unique IDs via the nextNodeId closure so they
 * don't collide with outer circuit nodes or with each other across expansions.
 */

import type { ComponentDefinition } from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "./element.js";
import type { SolverDiagnostic } from "../../core/analog-engine-interface.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { SubcircuitModelRegistry } from "./subcircuit-model-registry.js";
import { makeDiagnostic } from "./diagnostics.js";
import { PropertyBag } from "../../core/properties.js";

// ---------------------------------------------------------------------------
// TransistorExpansionResult
// ---------------------------------------------------------------------------

export interface TransistorExpansionResult {
  /** All analog elements from the expansion. */
  elements: AnalogElement[];
  /** Number of new internal nodes allocated. */
  internalNodeCount: number;
  /** Any issues detected during expansion. */
  diagnostics: SolverDiagnostic[];
}

// ---------------------------------------------------------------------------
// expandTransistorModel
// ---------------------------------------------------------------------------

/**
 * Expand a single component's transistor model into flat AnalogElement instances.
 *
 * @param componentDef     - The ComponentDefinition with subcircuitRefs set
 * @param outerPinNodeIds  - MNA node IDs for each of the component's pins (by pin order)
 * @param modelRegistry    - Registry of transistor model subcircuits (MnaSubcircuitNetlist)
 * @param vddNodeId        - The shared VDD node ID injected by the compiler
 * @param gndNodeId        - Ground node ID (0)
 * @param nextNodeId       - Closure that returns the next unique MNA node ID on each call
 * @param subcircuitName   - Name of the subcircuit to expand (from subcircuitRefs)
 * @returns TransistorExpansionResult with elements, internal node count, and diagnostics
 */
export function expandTransistorModel(
  componentDef: ComponentDefinition,
  outerPinNodeIds: number[],
  modelRegistry: SubcircuitModelRegistry,
  vddNodeId: number,
  gndNodeId: number,
  nextNodeId: () => number,
  subcircuitName?: string,
): TransistorExpansionResult {
  const diagnostics: SolverDiagnostic[] = [];

  const transistorModelName = subcircuitName
    ?? Object.values(componentDef.subcircuitRefs ?? {})[0];
  if (!transistorModelName) {
    diagnostics.push(
      makeDiagnostic(
        "missing-transistor-model",
        "error",
        `Component "${componentDef.name}" has no subcircuitRefs defined`,
        {
          explanation:
            `The component "${componentDef.name}" is configured for transistor-level simulation ` +
            `but its ComponentDefinition has no subcircuitRefs. ` +
            `Set subcircuitRefs: { cmos: 'CmosXxx' } on the ComponentDefinition.`,
          suggestions: [
            {
              text: `Add subcircuitRefs: { cmos: 'CmosXxx' } to the ComponentDefinition for "${componentDef.name}".`,
              automatable: false,
            },
          ],
        },
      ),
    );
    return { elements: [], internalNodeCount: 0, diagnostics };
  }

  const netlist = modelRegistry.get(transistorModelName);
  if (!netlist) {
    diagnostics.push(
      makeDiagnostic(
        "missing-transistor-model",
        "error",
        `Transistor model subcircuit "${transistorModelName}" is not registered`,
        {
          explanation:
            `Component "${componentDef.name}" references transistor model ` +
            `"${transistorModelName}" which has not been registered ` +
            `in the SubcircuitModelRegistry. Call registerBuiltinSubcircuitModels() before compiling.`,
        },
      ),
    );
    return { elements: [], internalNodeCount: 0, diagnostics };
  }

  // Build port label → outer MNA node ID mapping
  const pinLabelToOuterNode = new Map<string, number>();
  for (let i = 0; i < componentDef.pinLayout.length; i++) {
    if (i < outerPinNodeIds.length) {
      pinLabelToOuterNode.set(componentDef.pinLayout[i].label, outerPinNodeIds[i]);
    }
  }

  // Map subcircuit net indices to outer MNA node IDs.
  // Net indices 0..ports.length-1 are external ports.
  // Net indices ports.length.. are internal nets.
  const netRemap = new Map<number, number>();

  for (let portIdx = 0; portIdx < netlist.ports.length; portIdx++) {
    const portLabel = netlist.ports[portIdx];
    if (portLabel === "VDD") {
      netRemap.set(portIdx, vddNodeId);
    } else if (portLabel === "GND") {
      netRemap.set(portIdx, gndNodeId);
    } else {
      const outerNode = pinLabelToOuterNode.get(portLabel);
      if (outerNode !== undefined) {
        netRemap.set(portIdx, outerNode);
      }
    }
  }

  // Assign fresh MNA node IDs for internal nets
  let internalNodeCount = 0;
  const internalBase = netlist.ports.length;
  for (let i = 0; i < netlist.internalNetCount; i++) {
    netRemap.set(internalBase + i, nextNodeId());
    internalNodeCount++;
  }

  function remapNet(netIdx: number): number {
    const mapped = netRemap.get(netIdx);
    if (mapped !== undefined) return mapped;
    const fresh = nextNodeId();
    netRemap.set(netIdx, fresh);
    internalNodeCount++;
    return fresh;
  }

  // Validate that all element types have analog factories
  for (const subEl of netlist.elements) {
    if (!getAnalogFactory(subEl.typeId)) {
      diagnostics.push(
        makeDiagnostic(
          "invalid-transistor-model",
          "error",
          `Transistor model "${transistorModelName}" contains non-analog component "${subEl.typeId}"`,
          {
            explanation:
              `The transistor model subcircuit "${transistorModelName}" contains ` +
              `component type "${subEl.typeId}" which has no analog factory and cannot be ` +
              `stamped into the MNA matrix. Transistor models must contain only analog ` +
              `leaf components (MOSFETs, resistors, voltage sources, etc.).`,
          },
        ),
      );
      return { elements: [], internalNodeCount: 0, diagnostics };
    }
  }

  // Instantiate AnalogElement for each subcircuit element
  const elements: AnalogElement[] = [];

  for (let elIdx = 0; elIdx < netlist.elements.length; elIdx++) {
    const subEl = netlist.elements[elIdx];
    const connectivity = netlist.netlist[elIdx];
    const remappedNodes = connectivity.map(remapNet);

    const factory = getAnalogFactory(subEl.typeId);
    if (!factory) continue;

    const propsEntries: Array<[string, string | number | boolean]> = [];
    if (subEl.params) {
      for (const [k, v] of Object.entries(subEl.params)) {
        if (typeof v === "number") propsEntries.push([k, v]);
      }
    }
    const props = new PropertyBag(propsEntries);

    const core = factory(remappedNodes, -1, props, () => 0);
    const analogEl: AnalogElement = Object.assign(core, { pinNodeIds: remappedNodes, allNodeIds: remappedNodes });
    elements.push(analogEl);
  }

  return { elements, internalNodeCount, diagnostics };
}

// ---------------------------------------------------------------------------
// Analog factory registry — maps typeId strings to inline analog factories.
//
// This minimal registry covers the leaf analog components that transistor
// model subcircuits may contain. It is separate from ComponentRegistry to
// avoid circular dependencies during compilation.
//
// Populated lazily using dynamic imports when needed. For the transistor
// expansion use case, we hard-code the MOSFET factories since those are the
// only components used in CMOS transistor models.
// ---------------------------------------------------------------------------

type AnalogFactory = (
  nodeIds: number[],
  branchIdx: number,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElementCore;

// Known analog component type IDs and their factories.
// This map is populated by registerAnalogFactory() calls from component modules.
const _analogFactoryRegistry = new Map<string, AnalogFactory>();

/**
 * Register an analog factory for a component typeId.
 * Called by component modules during initialization.
 */
export function registerAnalogFactory(typeId: string, factory: AnalogFactory): void {
  _analogFactoryRegistry.set(typeId, factory);
}

/**
 * Look up an analog factory by typeId. Returns undefined for unknown types.
 */
export function getAnalogFactory(typeId: string): AnalogFactory | undefined {
  return _analogFactoryRegistry.get(typeId);
}
