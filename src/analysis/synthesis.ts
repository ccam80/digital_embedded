/**
 * Circuit synthesis- generate a Circuit from boolean expressions.
 *
 * Takes a map of output-name → BoolExpr and produces a Circuit containing:
 *   - One In component per input variable (left column)
 *   - Gate components for each expression node (middle columns, depth-ordered)
 *   - One Out component per output expression (right column)
 *   - Wires connecting all pins
 *
 * Layout: left-to-right, inputs at column 0, outputs at the rightmost column,
 * gates at intermediate columns determined by their depth in the expression tree.
 *
 * The circuit is engine-agnostic- it is a pure visual Circuit model that
 * can be loaded by the editor without any simulation backend.
 */

import type { BoolExpr } from './expression.js';
import { layoutCircuit } from './auto-layout.js';
import { Circuit, Wire } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { ComponentRegistry } from '../core/registry.js';
import { PropertyBag } from '../core/properties.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synthesise a Circuit from a set of boolean expressions.
 *
 * @param expressions  Map from output signal name to BoolExpr.
 * @param inputNames   Ordered list of input variable names (determines In column order).
 * @param registry     Component registry used to create elements via factory functions.
 * @returns            A Circuit ready for loading in the editor.
 */
export function synthesizeCircuit(
  expressions: ReadonlyMap<string, BoolExpr>,
  inputNames: readonly string[],
  registry: ComponentRegistry,
): Circuit {
  const circuit = new Circuit({ name: 'Synthesised' });

  // Map from signal/node ID → element in the circuit.
  // Signals: either an input name or a unique gate node ID.
  const signalElements = new Map<string, CircuitElement>();

  // Column assignment for layout
  const columnMap = new Map<string, number>();

  let nodeCounter = 0;
  function freshId(): string {
    return `_node_${nodeCounter++}`;
  }

  // -------------------------------------------------------------------------
  // Step 1: Create In components for each input
  // -------------------------------------------------------------------------

  const inDef = registry.get('In');
  if (inDef === undefined) {
    throw new Error('synthesizeCircuit: "In" component not registered');
  }

  for (const name of inputNames) {
    const props = new PropertyBag([['label', name], ['bitWidth', 1]]);
    const el = inDef.factory(props);
    el.position = { x: 0, y: 0 }; // placeholder, layout() will fix
    circuit.addElement(el);
    signalElements.set(name, el);
    columnMap.set(el.instanceId, 0);
  }

  // -------------------------------------------------------------------------
  // Step 2: Recursively build gate trees for each expression
  // -------------------------------------------------------------------------

  // Collect all (outName, expr) pairs
  const outputOrder: string[] = [];
  const outputNodeIds = new Map<string, string>(); // outName → node ID

  for (const [outName, expr] of expressions) {
    outputOrder.push(outName);
    const nodeId = buildExprTree(
      expr,
      circuit,
      registry,
      signalElements,
      columnMap,
      freshId,
      1, // gates start at column 1
    );
    outputNodeIds.set(outName, nodeId);
  }

  // Determine maximum column used by gates to place Out components
  let maxGateCol = 1;
  for (const col of columnMap.values()) {
    if (col > maxGateCol) maxGateCol = col;
  }
  const outColumn = maxGateCol + 1;

  // -------------------------------------------------------------------------
  // Step 3: Create Out components for each output
  // -------------------------------------------------------------------------

  const outDef = registry.get('Out');
  if (outDef === undefined) {
    throw new Error('synthesizeCircuit: "Out" component not registered');
  }

  for (const outName of outputOrder) {
    const props = new PropertyBag([['label', outName], ['bitWidth', 1]]);
    const outEl = outDef.factory(props);
    outEl.position = { x: 0, y: 0 }; // placeholder
    circuit.addElement(outEl);
    columnMap.set(outEl.instanceId, outColumn);

    // Wire: the driver element's output pin → Out element's input pin
    const driverNodeId = outputNodeIds.get(outName)!;
    const driverEl = signalElements.get(driverNodeId);
    if (driverEl !== undefined) {
      wireElements(circuit, driverEl, outEl);
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Apply layout
  // -------------------------------------------------------------------------

  layoutCircuit(circuit, columnMap);

  return circuit;
}

// ---------------------------------------------------------------------------
// Expression tree builder
// ---------------------------------------------------------------------------

/**
 * Recursively build CircuitElement(s) for a BoolExpr sub-tree.
 *
 * Returns the node ID (key into signalElements) that carries the output of
 * this sub-expression.
 *
 * For variable nodes, returns the input variable name directly (already in
 * signalElements). For gate nodes, creates a gate element, wires inputs to it,
 * and returns a fresh node ID.
 */
function buildExprTree(
  expr: BoolExpr,
  circuit: Circuit,
  registry: ComponentRegistry,
  signalElements: Map<string, CircuitElement>,
  columnMap: Map<string, number>,
  freshId: () => string,
  minColumn: number,
): string {
  switch (expr.kind) {
    case 'constant': {
      // Represent a constant as a Const component (or just an In with a label)
      const nodeId = freshId();
      const def = registry.get('Const') ?? registry.get('In');
      if (def === undefined) {
        throw new Error('synthesizeCircuit: no Const or In component registered for constants');
      }
      const props = new PropertyBag([['label', expr.value ? '1' : '0'], ['bitWidth', 1]]);
      const el = def.factory(props);
      el.position = { x: 0, y: 0 };
      circuit.addElement(el);
      signalElements.set(nodeId, el);
      columnMap.set(el.instanceId, minColumn);
      return nodeId;
    }

    case 'variable': {
      // Variable node- look up the existing In element
      const baseId = expr.name;
      if (!expr.negated) {
        // Positive literal- reuse the In element directly
        if (signalElements.has(baseId)) {
          return baseId;
        }
        // Variable not in map- create a late In element
        const inDef = registry.get('In');
        if (inDef === undefined) throw new Error('synthesizeCircuit: "In" not registered');
        const props = new PropertyBag([['label', baseId], ['bitWidth', 1]]);
        const el = inDef.factory(props);
        el.position = { x: 0, y: 0 };
        circuit.addElement(el);
        signalElements.set(baseId, el);
        columnMap.set(el.instanceId, 0);
        return baseId;
      } else {
        // Negated variable- insert a NOT gate
        const inputId = buildPosVariable(
          baseId,
          circuit,
          registry,
          signalElements,
          columnMap,
          minColumn,
        );
        return buildNotGate(
          inputId,
          circuit,
          registry,
          signalElements,
          columnMap,
          freshId,
          minColumn,
        );
      }
    }

    case 'not': {
      const inputId = buildExprTree(
        expr.operand,
        circuit,
        registry,
        signalElements,
        columnMap,
        freshId,
        minColumn,
      );
      return buildNotGate(
        inputId,
        circuit,
        registry,
        signalElements,
        columnMap,
        freshId,
        minColumn + 1,
      );
    }

    case 'and': {
      // Build all input sub-trees
      const inputIds = expr.operands.map((op) =>
        buildExprTree(op, circuit, registry, signalElements, columnMap, freshId, minColumn),
      );
      const maxInputCol = maxColumnOf(inputIds, signalElements, columnMap);
      return buildNaryGate(
        'And',
        inputIds,
        circuit,
        registry,
        signalElements,
        columnMap,
        freshId,
        maxInputCol + 1,
      );
    }

    case 'or': {
      const inputIds = expr.operands.map((op) =>
        buildExprTree(op, circuit, registry, signalElements, columnMap, freshId, minColumn),
      );
      const maxInputCol = maxColumnOf(inputIds, signalElements, columnMap);
      return buildNaryGate(
        'Or',
        inputIds,
        circuit,
        registry,
        signalElements,
        columnMap,
        freshId,
        maxInputCol + 1,
      );
    }
  }
}

/** Ensure a positive variable literal exists and return its node ID. */
function buildPosVariable(
  name: string,
  circuit: Circuit,
  registry: ComponentRegistry,
  signalElements: Map<string, CircuitElement>,
  columnMap: Map<string, number>,
  _minColumn: number,
): string {
  if (signalElements.has(name)) return name;
  const inDef = registry.get('In');
  if (inDef === undefined) throw new Error('synthesizeCircuit: "In" not registered');
  const props = new PropertyBag([['label', name], ['bitWidth', 1]]);
  const el = inDef.factory(props);
  el.position = { x: 0, y: 0 };
  circuit.addElement(el);
  signalElements.set(name, el);
  columnMap.set(el.instanceId, 0);
  return name;
}

/** Build a NOT gate that takes one input node and returns a new node ID. */
function buildNotGate(
  inputId: string,
  circuit: Circuit,
  registry: ComponentRegistry,
  signalElements: Map<string, CircuitElement>,
  columnMap: Map<string, number>,
  freshId: () => string,
  column: number,
): string {
  const def = registry.get('Not');
  if (def === undefined) {
    throw new Error('synthesizeCircuit: "Not" component not registered');
  }
  const props = new PropertyBag([['bitWidth', 1]]);
  const el = def.factory(props);
  el.position = { x: 0, y: 0 };
  circuit.addElement(el);

  const nodeId = freshId();
  signalElements.set(nodeId, el);
  columnMap.set(el.instanceId, column);

  // Wire input → NOT
  const inputEl = signalElements.get(inputId);
  if (inputEl !== undefined) {
    wireElements(circuit, inputEl, el);
  }

  return nodeId;
}

/** Build a multi-input gate (And or Or) and wire all inputs to it. */
function buildNaryGate(
  gateType: string,
  inputIds: string[],
  circuit: Circuit,
  registry: ComponentRegistry,
  signalElements: Map<string, CircuitElement>,
  columnMap: Map<string, number>,
  freshId: () => string,
  column: number,
): string {
  const def = registry.get(gateType);
  if (def === undefined) {
    throw new Error(`synthesizeCircuit: "${gateType}" component not registered`);
  }
  const inputCount = Math.max(2, inputIds.length);
  const props = new PropertyBag([['inputCount', inputCount], ['bitWidth', 1]]);
  const el = def.factory(props);
  el.position = { x: 0, y: 0 };
  circuit.addElement(el);

  const nodeId = freshId();
  signalElements.set(nodeId, el);
  columnMap.set(el.instanceId, column);

  // Wire each input element's output pin to the gate
  for (const inputId of inputIds) {
    const inputEl = signalElements.get(inputId);
    if (inputEl !== undefined) {
      wireElements(circuit, inputEl, el);
    }
  }

  return nodeId;
}

// ---------------------------------------------------------------------------
// Wire helper
// ---------------------------------------------------------------------------

/**
 * Add a wire between the output pin of `from` and the first input pin of `to`.
 *
 * Since positions are placeholders at wire-creation time, we use the element
 * positions directly. The layout pass will update positions, but wires are
 * created with the element positions as set at call time. After layout(), wire
 * start/end points would ideally be recomputed from pin world positions.
 *
 * For synthesis purposes the wires represent logical connections- their visual
 * accuracy is secondary to functional correctness (which the compiler resolves
 * from pin proximity and net tracing).
 */
function wireElements(circuit: Circuit, from: CircuitElement, to: CircuitElement): void {
  // Get output pin of 'from' and input pin of 'to'
  const fromPins = from.getPins();
  const toPins = to.getPins();

  const outputPin = fromPins.find((p) => p.direction === 'OUTPUT');
  const inputPin = toPins.find((p) => p.direction === 'INPUT');

  if (outputPin === undefined || inputPin === undefined) return;

  circuit.addWire(new Wire(
    { x: outputPin.position.x, y: outputPin.position.y },
    { x: inputPin.position.x, y: inputPin.position.y },
  ));
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** Find the maximum column index among a set of node IDs. */
function maxColumnOf(
  nodeIds: string[],
  signalElements: Map<string, CircuitElement>,
  columnMap: Map<string, number>,
): number {
  let max = 0;
  for (const id of nodeIds) {
    const el = signalElements.get(id);
    if (el !== undefined) {
      const col = columnMap.get(el.instanceId) ?? 0;
      if (col > max) max = col;
    }
  }
  return max;
}
