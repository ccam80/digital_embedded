/**
 * Import Digital's .fsm XML format into our FSM model.
 *
 * Digital stores FSMs as Digital XML-serialized XML with `<fsm>` root,
 * `<state>` elements with number/name/position/values/isInitial,
 * and `<transition>` elements with fromState/toState references and conditions.
 */

import { DOMParser } from '@xmldom/xmldom';
import type { FSM, FSMState, FSMTransition } from './model';

let _importId = 1;

function generateImportId(): string {
  return `imp_${_importId++}`;
}

/** Reset import ID counter (for tests). */
export function resetImportIdCounter(): void {
  _importId = 1;
}

/**
 * Parse a Digital .fsm XML string and return an FSM model.
 */
export function importDigitalFSM(xml: string): FSM {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'fsm') {
    throw new Error('Invalid .fsm file: root element must be <fsm>');
  }

  const statesEl = getFirstChildByTag(root, 'states');
  const transitionsEl = getFirstChildByTag(root, 'transitions');

  if (!statesEl) {
    throw new Error('Invalid .fsm file: missing <states> element');
  }

  const stateElements = getChildrenByTag(statesEl, 'state');

  const inputSignals = new Set<string>();
  const outputSignals = new Set<string>();

  const states: FSMState[] = stateElements.map((el) =>
    parseState(el, outputSignals),
  );

  const stateIndexMap = new Map<number, string>();
  for (let i = 0; i < states.length; i++) {
    stateIndexMap.set(i, states[i].id);
  }

  const transitions: FSMTransition[] = [];
  if (transitionsEl) {
    const transElements = getChildrenByTag(transitionsEl, 'transition');
    for (const el of transElements) {
      const t = parseTransition(
        el,
        stateElements.length,
        stateIndexMap,
        inputSignals,
        outputSignals,
      );
      transitions.push(t);
    }
  }

  return {
    name: '',
    states,
    transitions,
    inputSignals: [...inputSignals],
    outputSignals: [...outputSignals],
    stateEncoding: 'binary',
  };
}

function parseState(
  el: Element,
  outputSignals: Set<string>,
): FSMState {
  const name = getTextContent(el, 'name') ?? '';
  const number = parseInt(getTextContent(el, 'number') ?? '0', 10);
  const radius = parseInt(getTextContent(el, 'radius') ?? '70', 10);
  const isInitial = getTextContent(el, 'isInitial') === 'true';

  const posEl = getFirstChildByTag(el, 'position');
  const x = posEl ? parseFloat(posEl.getAttribute('x') ?? '0') : 0;
  const y = posEl ? parseFloat(posEl.getAttribute('y') ?? '0') : 0;

  const valuesStr = getTextContent(el, 'values') ?? '';
  const outputs = parseValues(valuesStr);
  for (const key of Object.keys(outputs)) {
    outputSignals.add(key);
  }

  const displayName = name.length > 0 ? name : `S${number}`;

  return {
    id: generateImportId(),
    name: displayName,
    position: { x, y },
    outputs,
    isInitial,
    radius,
  };
}

function parseTransition(
  el: Element,
  _stateCount: number,
  stateIndexMap: Map<number, string>,
  inputSignals: Set<string>,
  outputSignals: Set<string>,
): FSMTransition {
  const condition = getTextContent(el, 'condition') ?? '';
  const valuesStr = getTextContent(el, 'values') ?? '';
  const actions = parseValues(valuesStr);

  for (const key of Object.keys(actions)) {
    outputSignals.add(key);
  }

  extractSignalNames(condition, inputSignals);

  const fromRef = getFirstChildByTag(el, 'fromState');
  const toRef = getFirstChildByTag(el, 'toState');

  const fromIndex = resolveStateReference(fromRef);
  const toIndex = resolveStateReference(toRef);

  const sourceStateId = stateIndexMap.get(fromIndex);
  const targetStateId = stateIndexMap.get(toIndex);

  if (sourceStateId === undefined) {
    throw new Error(`Invalid .fsm file: fromState index ${fromIndex} out of range`);
  }
  if (targetStateId === undefined) {
    throw new Error(`Invalid .fsm file: toState index ${toIndex} out of range`);
  }

  const posEl = getFirstChildByTag(el, 'position');
  const cpX = posEl ? parseFloat(posEl.getAttribute('x') ?? '0') : 0;
  const cpY = posEl ? parseFloat(posEl.getAttribute('y') ?? '0') : 0;

  return {
    id: generateImportId(),
    sourceStateId,
    targetStateId,
    condition,
    actions: Object.keys(actions).length > 0 ? actions : undefined,
    controlPoints: [{ x: cpX, y: cpY }],
  };
}

/**
 * Resolve Digital XML state references.
 *
 * Digital uses Digital XML reference paths like:
 *   `../../../states/state`       -> index 0
 *   `../../../states/state[2]`    -> index 1 (Digital XML uses 1-based [n] but first is bare)
 *   `../../../states/state[10]`   -> index 9
 */
function resolveStateReference(el: Element | null): number {
  if (!el) {
    throw new Error('Invalid .fsm file: missing state reference element');
  }

  const ref = el.getAttribute('reference');
  if (!ref) {
    throw new Error('Invalid .fsm file: state reference missing "reference" attribute');
  }

  const match = ref.match(/state(?:\[(\d+)\])?$/);
  if (!match) {
    throw new Error(`Invalid .fsm file: cannot parse state reference "${ref}"`);
  }

  if (match[1] === undefined) {
    return 0;
  }
  return parseInt(match[1], 10) - 1;
}

/**
 * Parse Digital's value assignment string: "A=0,B=1" or "D=0010".
 * Returns a Record mapping signal names to numeric values.
 */
function parseValues(valuesStr: string): Record<string, number> {
  const result: Record<string, number> = {};
  const trimmed = valuesStr.trim();
  if (trimmed.length === 0) return result;

  const parts = trimmed.split(',');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.substring(0, eqIdx).trim();
    const valStr = part.substring(eqIdx + 1).trim();
    if (key.length === 0) continue;
    result[key] = parseInt(valStr, 10);
  }
  return result;
}

/**
 * Extract signal names from a condition expression.
 * Looks for identifiers followed by `=` (like `A=1`, `en=1`).
 */
function extractSignalNames(condition: string, signals: Set<string>): void {
  const regex = /([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(condition)) !== null) {
    signals.add(match[1]);
  }
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function getFirstChildByTag(parent: Element, tagName: string): Element | null {
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 1 && (child as Element).tagName === tagName) {
      return child as Element;
    }
  }
  return null;
}

function getChildrenByTag(parent: Element, tagName: string): Element[] {
  const result: Element[] = [];
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 1 && (child as Element).tagName === tagName) {
      result.push(child as Element);
    }
  }
  return result;
}

function getTextContent(parent: Element, tagName: string): string | null {
  const el = getFirstChildByTag(parent, tagName);
  if (!el) return null;
  return el.textContent ?? null;
}
