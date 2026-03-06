/**
 * FSM data model -- interfaces and CRUD operations for finite state machines.
 *
 * States are circles on a canvas, transitions are directed edges between them.
 * The model is independent of rendering and serialization concerns.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface FSM {
  name: string;
  states: FSMState[];
  transitions: FSMTransition[];
  inputSignals: string[];
  outputSignals: string[];
  stateEncoding: 'binary' | 'gray' | 'oneHot';
  stateBits?: number | undefined;
}

export interface FSMState {
  id: string;
  name: string;
  position: { x: number; y: number };
  outputs: Record<string, number>;
  isInitial: boolean;
  radius: number;
}

export interface FSMTransition {
  id: string;
  sourceStateId: string;
  targetStateId: string;
  condition: string;
  actions?: Record<string, number> | undefined;
  controlPoints: { x: number; y: number }[];
}

// ---------------------------------------------------------------------------
// Validation types
// ---------------------------------------------------------------------------

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  message: string;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _nextId = 1;

function generateId(): string {
  return `fsm_${_nextId++}`;
}

/** Reset the ID counter. Only for use in tests. */
export function resetIdCounter(): void {
  _nextId = 1;
}

// ---------------------------------------------------------------------------
// Factory / CRUD
// ---------------------------------------------------------------------------

export function createFSM(name: string): FSM {
  return {
    name,
    states: [],
    transitions: [],
    inputSignals: [],
    outputSignals: [],
    stateEncoding: 'binary',
  };
}

/**
 * Add a new state to the FSM. Returns the created state.
 * The first state added is automatically marked as initial unless
 * `isInitial` is explicitly set to false.
 */
export function addState(
  fsm: FSM,
  name: string,
  position: { x: number; y: number },
  options?: {
    outputs?: Record<string, number>;
    isInitial?: boolean;
    radius?: number;
  },
): FSMState {
  const shouldBeInitial =
    options?.isInitial !== undefined
      ? options.isInitial
      : fsm.states.length === 0;

  if (shouldBeInitial) {
    for (const s of fsm.states) {
      s.isInitial = false;
    }
  }

  const state: FSMState = {
    id: generateId(),
    name,
    position: { x: position.x, y: position.y },
    outputs: options?.outputs ?? {},
    isInitial: shouldBeInitial,
    radius: options?.radius ?? 30,
  };
  fsm.states.push(state);
  return state;
}

export function addTransition(
  fsm: FSM,
  sourceStateId: string,
  targetStateId: string,
  condition: string = '',
  options?: {
    actions?: Record<string, number>;
    controlPoints?: { x: number; y: number }[];
  },
): FSMTransition {
  const transition: FSMTransition = {
    id: generateId(),
    sourceStateId,
    targetStateId,
    condition,
    actions: options?.actions,
    controlPoints: options?.controlPoints ?? [],
  };
  fsm.transitions.push(transition);
  return transition;
}

export function removeState(fsm: FSM, stateId: string): void {
  fsm.states = fsm.states.filter((s) => s.id !== stateId);
  fsm.transitions = fsm.transitions.filter(
    (t) => t.sourceStateId !== stateId && t.targetStateId !== stateId,
  );
}

export function removeTransition(fsm: FSM, transitionId: string): void {
  fsm.transitions = fsm.transitions.filter((t) => t.id !== transitionId);
}

export function findStateById(
  fsm: FSM,
  stateId: string,
): FSMState | undefined {
  return fsm.states.find((s) => s.id === stateId);
}

export function findTransitionsForState(
  fsm: FSM,
  stateId: string,
): FSMTransition[] {
  return fsm.transitions.filter(
    (t) => t.sourceStateId === stateId || t.targetStateId === stateId,
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate an FSM, returning a list of issues.
 *
 * Checks performed:
 * - At least one initial state
 * - No duplicate state names (among non-empty names)
 * - All states reachable from the initial state
 * - Transition condition syntax
 */
export function validateFSM(fsm: FSM): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  validateInitialState(fsm, issues);
  validateDuplicateNames(fsm, issues);
  validateReachability(fsm, issues);
  validateConditions(fsm, issues);

  return issues;
}

function validateInitialState(fsm: FSM, issues: ValidationIssue[]): void {
  const initialCount = fsm.states.filter((s) => s.isInitial).length;
  if (initialCount === 0 && fsm.states.length > 0) {
    issues.push({
      severity: 'error',
      message: 'No initial state defined',
    });
  }
}

function validateDuplicateNames(fsm: FSM, issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  for (const state of fsm.states) {
    if (state.name.length === 0) continue;
    if (seen.has(state.name)) {
      issues.push({
        severity: 'error',
        message: `Duplicate state name: "${state.name}"`,
      });
    }
    seen.add(state.name);
  }
}

function validateReachability(fsm: FSM, issues: ValidationIssue[]): void {
  if (fsm.states.length === 0) return;
  const initial = fsm.states.find((s) => s.isInitial);
  if (!initial) return;

  const reachable = new Set<string>();
  const queue: string[] = [initial.id];
  reachable.add(initial.id);

  while (queue.length > 0) {
    const currentId = queue.pop()!;
    for (const t of fsm.transitions) {
      if (t.sourceStateId === currentId && !reachable.has(t.targetStateId)) {
        reachable.add(t.targetStateId);
        queue.push(t.targetStateId);
      }
    }
  }

  for (const state of fsm.states) {
    if (!reachable.has(state.id)) {
      issues.push({
        severity: 'warning',
        message: `State "${state.name}" is not reachable from the initial state`,
      });
    }
  }
}

function validateConditions(fsm: FSM, issues: ValidationIssue[]): void {
  for (const t of fsm.transitions) {
    const trimmed = t.condition.trim();
    if (trimmed.length === 0) continue;

    const result = parseCondition(trimmed);
    if (!result.valid) {
      issues.push({
        severity: 'error',
        message: `Invalid condition on transition "${t.id}": ${result.error}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Condition expression parser
// ---------------------------------------------------------------------------

interface ParseResult {
  valid: boolean;
  error?: string | undefined;
}

/**
 * Recursive-descent parser for boolean condition expressions.
 *
 * Grammar:
 *   expr     = orExpr
 *   orExpr   = andExpr (('|' | '+') andExpr)*
 *   andExpr  = notExpr (('&' | '*') notExpr)*
 *   notExpr  = ('!' | '~') notExpr | atom
 *   atom     = '(' expr ')' | number | identifier ('=' number)?
 */
export function parseCondition(input: string): ParseResult {
  let pos = 0;

  function skipWS(): void {
    while (pos < input.length && (input[pos] === ' ' || input[pos] === '\t')) {
      pos++;
    }
  }

  function parseExpr(): ParseResult {
    return parseOrExpr();
  }

  function parseOrExpr(): ParseResult {
    const r = parseAndExpr();
    if (!r.valid) return r;
    skipWS();
    while (pos < input.length && (input[pos] === '|' || input[pos] === '+')) {
      pos++;
      skipWS();
      const r2 = parseAndExpr();
      if (!r2.valid) return r2;
      skipWS();
    }
    return { valid: true };
  }

  function parseAndExpr(): ParseResult {
    const r = parseNotExpr();
    if (!r.valid) return r;
    skipWS();
    while (pos < input.length && (input[pos] === '&' || input[pos] === '*')) {
      pos++;
      skipWS();
      const r2 = parseNotExpr();
      if (!r2.valid) return r2;
      skipWS();
    }
    return { valid: true };
  }

  function parseNotExpr(): ParseResult {
    skipWS();
    if (
      pos < input.length &&
      (input[pos] === '!' || input[pos] === '~')
    ) {
      pos++;
      skipWS();
      return parseNotExpr();
    }
    return parseAtom();
  }

  function parseAtom(): ParseResult {
    skipWS();
    if (pos >= input.length) {
      return { valid: false, error: 'Unexpected end of expression' };
    }

    if (input[pos] === '(') {
      pos++;
      const r = parseExpr();
      if (!r.valid) return r;
      skipWS();
      if (pos >= input.length || input[pos] !== ')') {
        return { valid: false, error: 'Missing closing parenthesis' };
      }
      pos++;
      return { valid: true };
    }

    if (/[0-9]/.test(input[pos])) {
      while (pos < input.length && /[0-9]/.test(input[pos])) {
        pos++;
      }
      return { valid: true };
    }

    if (/[A-Za-z_]/.test(input[pos])) {
      while (pos < input.length && /[A-Za-z0-9_]/.test(input[pos])) {
        pos++;
      }
      skipWS();
      if (pos < input.length && input[pos] === '=') {
        pos++;
        skipWS();
        if (pos >= input.length || !/[0-9]/.test(input[pos])) {
          return { valid: false, error: 'Expected numeric value after "="' };
        }
        while (pos < input.length && /[0-9]/.test(input[pos])) {
          pos++;
        }
      }
      return { valid: true };
    }

    return {
      valid: false,
      error: `Unexpected character "${input[pos]}" at position ${pos}`,
    };
  }

  const result = parseExpr();
  if (!result.valid) return result;
  skipWS();
  if (pos < input.length) {
    return {
      valid: false,
      error: `Unexpected character "${input[pos]}" at position ${pos}`,
    };
  }
  return { valid: true };
}
