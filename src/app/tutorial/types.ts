/**
 * Tutorial data model — structured types for authoring and running tutorials.
 *
 * All types are browser-free, Node.js-compatible, and JSON-serializable.
 * The schema is designed for LLM agents to produce correctly:
 *   - Every field has a clear purpose documented inline
 *   - Required vs optional is explicit
 *   - String unions are used instead of enums for JSON roundtrip safety
 *   - Validation functions catch structural errors with plain-English messages
 *
 * Authoring flow:
 *   1. Agent builds TutorialStep[] with circuit specs and test vectors
 *   2. Agent assembles a TutorialManifest
 *   3. `tutorial_create` MCP tool validates + saves manifest + .dig files
 *
 * Runtime flow:
 *   1. Host page loads manifest.json
 *   2. For each step: sends postMessages to set palette, load circuit, show instructions
 *   3. Student builds → host sends `sim-test` to validate → shows results
 */

// ---------------------------------------------------------------------------
// Palette presets — named component sets for common tutorial scenarios
// ---------------------------------------------------------------------------

/**
 * Either an explicit list of component type names, or a named preset.
 *
 * Examples:
 *   ["And", "Or", "Not", "In", "Out"]        — explicit list
 *   "basic-gates"                              — preset name
 *   { preset: "basic-gates", add: ["Clock"] }  — preset + extras
 *   { preset: "basic-gates", remove: ["XOr"] } — preset - exclusions
 */
export type PaletteSpec =
  | string[]
  | string
  | { preset: string; add?: string[]; remove?: string[] };

// ---------------------------------------------------------------------------
// Hint — progressive hints for a step
// ---------------------------------------------------------------------------

/**
 * A hint the student can request. Ordered from vague to specific.
 * The host reveals hints one at a time on request.
 */
export interface TutorialHint {
  /** Short label shown on the hint button, e.g. "Hint 1", "Show answer". */
  label: string;
  /** Markdown content revealed when the student clicks. */
  content: string;
  /**
   * Optional list of component labels to highlight when this hint is shown.
   * Uses the same addressing as netlist output (component labels).
   */
  highlight?: string[];
}

// ---------------------------------------------------------------------------
// Validation criteria — how to check the student's circuit
// ---------------------------------------------------------------------------

/**
 * How the student's circuit is validated at a given step.
 *
 * - `"test-vectors"`: Run test vectors (testData field). Pass = all vectors pass.
 * - `"equivalence"`: Compare student circuit behavior against a reference circuit
 *     over all input combinations. Accepts any topology that matches.
 * - `"compile-only"`: Just check that the circuit compiles without errors.
 *     Useful for intermediate steps ("wire up the inputs, we'll test later").
 * - `"manual"`: No automated check. The host shows a "Mark complete" button.
 */
export type ValidationMode = 'test-vectors' | 'equivalence' | 'compile-only' | 'manual';

// ---------------------------------------------------------------------------
// TutorialStep — one step in a tutorial
// ---------------------------------------------------------------------------

/**
 * A single step in a tutorial sequence.
 *
 * Each step defines:
 *   - What the student sees (instructions, palette, starting circuit)
 *   - What the student should build (goal description)
 *   - How to validate their work (test vectors, equivalence, or manual)
 *
 * Template for agents — copy this and fill in:
 * ```json
 * {
 *   "id": "step-1-sr-latch",
 *   "title": "Build an SR Latch",
 *   "instructions": "# SR Latch\n\nUsing two NAND gates...",
 *   "palette": ["NAnd", "In", "Out"],
 *   "startCircuit": null,
 *   "goalCircuit": { ... CircuitSpec ... },
 *   "validation": "test-vectors",
 *   "testData": "S R | Q nQ\n0 1 | 1 0\n1 0 | 0 1\n1 1 | X X"
 * }
 * ```
 */
export interface TutorialStep {
  /**
   * Step interaction mode. Controls which buttons and gating the viewer shows.
   *
   * - `"guided"` (default): The student must build the circuit themselves.
   *     Shows "Check Circuit" + "Pre-check" (compile + label verification).
   *     No "Show Solution" button. "Next" is gated until tests pass.
   *
   * - `"explore"`: For reading/demonstration steps where building is optional.
   *     Shows "Show Solution" to load the goal circuit. "Next"/"Prev" are
   *     always enabled. "Check Circuit" is available but not required.
   *
   * When omitted, defaults to `"guided"`.
   */
  mode?: 'guided' | 'explore';

  /**
   * Unique step identifier within the tutorial. Used for URL routing
   * and progress tracking. Must be URL-safe (alphanumeric + hyphens).
   *
   * Examples: "step-1-sr-latch", "add-enable", "edge-triggered"
   */
  id: string;

  /**
   * Human-readable step title shown in navigation.
   * Keep it short (under 60 characters).
   */
  title: string;

  /**
   * Step instructions in Markdown. Rendered in the tutorial host's
   * content panel. Can include headers, lists, bold, code blocks, etc.
   *
   * Tip: Start with a brief goal statement, then give specific guidance.
   */
  instructions: string;

  /**
   * Which components the student can use in the palette for this step.
   * Can be an explicit list, a preset name, or a preset with modifications.
   *
   * If null/undefined, the full palette is shown (no restriction).
   *
   * Common presets: "basic-gates", "gates-and-io", "sequential-intro",
   * "memory", "arithmetic", "full"
   */
  palette?: PaletteSpec | null;

  /**
   * The circuit loaded into the editor at the start of this step.
   *
   * Options:
   *   - null: Empty canvas (student starts from scratch)
   *   - "carry-forward": Use the student's circuit from the previous step
   *   - CircuitSpec object: Build this circuit and load it
   *   - string (ending in ".dig"): Load this .dig file relative to the tutorial directory
   *
   * For multi-step tutorials where each step builds on the last,
   * use "carry-forward" so the student keeps their own wiring.
   */
  startCircuit: null | 'carry-forward' | TutorialCircuitSpec | string;

  /**
   * The reference/goal circuit for this step. Used for:
   *   - Equivalence checking (if validation is "equivalence")
   *   - Generating the starting circuit for the next step (if next step doesn't use carry-forward)
   *   - Showing a reference solution when the student requests it
   *
   * Can be a CircuitSpec object or a .dig file path.
   * Required when validation is "equivalence". Optional otherwise.
   */
  goalCircuit?: TutorialCircuitSpec | string | null;

  /**
   * How the student's circuit is validated. See ValidationMode.
   * Default: "test-vectors" if testData is provided, "manual" otherwise.
   */
  validation?: ValidationMode;

  /**
   * Test vectors in Digital's test format. Required when validation is "test-vectors".
   *
   * Format: first line is signal names separated by spaces, with | separating
   * inputs from outputs. Subsequent lines are test rows.
   *
   * Example:
   *   "S R | Q nQ\n0 1 | 1 0\n1 0 | 0 1\n1 1 | X X"
   */
  testData?: string;

  /**
   * Progressive hints, ordered from vague to specific.
   * The host reveals them one at a time when the student asks.
   */
  hints?: TutorialHint[];

  /**
   * Component labels that should be locked (not movable/deletable).
   * Used when a step builds on a previous step's circuit and the existing
   * components shouldn't be disturbed.
   *
   * Uses the same label addressing as netlist output.
   * Example: ["S", "R", "G1", "G2"] to lock the SR latch gates
   */
  lockedComponents?: string[];

  /**
   * Components or nets to highlight when the step loads.
   * Draws the student's attention to the relevant area.
   * Uses the same label addressing as netlist output.
   */
  highlight?: string[];
}

// ---------------------------------------------------------------------------
// TutorialCircuitSpec — extended CircuitSpec for tutorials
// ---------------------------------------------------------------------------

/**
 * A circuit specification for tutorials. Extends the standard CircuitSpec
 * with optional metadata fields. The `components` and `connections` fields
 * use the same format as `circuit_build`.
 *
 * This type is a superset of CircuitSpec — any valid CircuitSpec is also
 * a valid TutorialCircuitSpec.
 */
export interface TutorialCircuitSpec {
  /** Optional circuit name. */
  name?: string;
  /** Optional description. */
  description?: string;
  /**
   * Components to create. Same format as CircuitSpec.components.
   * Each component has: id, type, optional props, optional layout.
   */
  components: TutorialComponentSpec[];
  /**
   * Connections as pairs of "id:pin" addresses.
   * Same format as CircuitSpec.connections.
   */
  connections: [string, string][];
}

/**
 * Component specification within a tutorial circuit.
 * Same as the standard ComponentSpec used by circuit_build.
 */
export interface TutorialComponentSpec {
  /** Local identifier for use in connections. */
  id: string;
  /** Component type name (e.g. "And", "NAnd", "In", "Out"). */
  type: string;
  /** Optional properties (e.g. { label: "S", Bits: 1 }). */
  props?: Record<string, unknown>;
  /** Optional layout constraints. */
  layout?: { col?: number; row?: number };
}

// ---------------------------------------------------------------------------
// TutorialManifest — the top-level tutorial definition
// ---------------------------------------------------------------------------

/**
 * Complete tutorial definition. This is the JSON file that defines an
 * entire tutorial sequence.
 *
 * File convention: `tutorials/<tutorial-id>/manifest.json`
 *
 * Template for agents — copy this structure:
 * ```json
 * {
 *   "id": "sr-to-flipflop",
 *   "version": 1,
 *   "title": "From SR Latch to D Flip-Flop",
 *   "description": "Build sequential logic from first principles.",
 *   "difficulty": "intermediate",
 *   "estimatedMinutes": 30,
 *   "prerequisites": ["basic-gates"],
 *   "steps": [ ... TutorialStep objects ... ]
 * }
 * ```
 */
export interface TutorialManifest {
  /**
   * Unique tutorial identifier. Used for URL routing, progress storage,
   * and file paths. Must be URL-safe (alphanumeric + hyphens).
   *
   * Convention: lowercase-kebab-case describing the topic.
   * Examples: "sr-to-flipflop", "intro-to-logic", "build-an-alu"
   */
  id: string;

  /**
   * Schema version. Increment when the manifest format changes.
   * Current version: 1
   */
  version: 1;

  /**
   * Human-readable tutorial title. Shown in tutorial listings.
   */
  title: string;

  /**
   * One-paragraph description. Shown in tutorial listings and on the
   * tutorial landing page.
   */
  description: string;

  /**
   * Difficulty level for filtering and display.
   */
  difficulty: 'beginner' | 'intermediate' | 'advanced';

  /**
   * Estimated completion time in minutes. Shown in tutorial listings.
   */
  estimatedMinutes?: number;

  /**
   * Tutorial IDs that should be completed before this one.
   * Used to suggest ordering, not enforced.
   */
  prerequisites?: string[];

  /**
   * Tags for categorization and search.
   * Examples: ["sequential", "latches", "flip-flops"]
   */
  tags?: string[];

  /**
   * The ordered sequence of steps. Must have at least one step.
   * Step IDs must be unique within the tutorial.
   */
  steps: TutorialStep[];

  /**
   * Author attribution. Optional.
   */
  author?: string;
}

// ---------------------------------------------------------------------------
// Tutorial progress — runtime state (not authored, stored by host)
// ---------------------------------------------------------------------------

/**
 * Per-step completion state, stored by the tutorial host (e.g. localStorage).
 */
export interface StepProgress {
  /** Step ID. */
  stepId: string;
  /** Whether the step has been completed (validation passed). */
  completed: boolean;
  /** ISO 8601 timestamp of completion, or null if not completed. */
  completedAt: string | null;
  /**
   * Number of hints revealed (0 = none). Allows the host to restore
   * hint state when the student returns to a step.
   */
  hintsRevealed: number;
  /**
   * The student's circuit state as base64 .dig XML, captured when they
   * completed or last left the step. Used for "carry-forward" loading.
   */
  circuitSnapshot: string | null;
}

/**
 * Tutorial-level progress, stored by the tutorial host.
 */
export interface TutorialProgress {
  /** Tutorial ID. */
  tutorialId: string;
  /** Index of the current step (0-based). */
  currentStepIndex: number;
  /** Per-step progress. */
  steps: StepProgress[];
  /** ISO 8601 timestamp of last activity. */
  lastActivityAt: string;
}

// ---------------------------------------------------------------------------
// postMessage protocol extensions for tutorials
// ---------------------------------------------------------------------------

/**
 * Messages the tutorial host can send to the simulator iframe.
 *
 * These extend the existing postMessage API documented in CLAUDE.md.
 */
export type TutorialHostMessage =
  | { type: 'sim-test'; testData: string }
  | { type: 'sim-get-circuit' }
  | { type: 'sim-highlight'; labels: string[]; color?: string; duration?: number }
  | { type: 'sim-clear-highlight' }
  | { type: 'sim-set-readonly-components'; labels: string[] | null }
  | { type: 'sim-set-instructions'; markdown: string | null; position?: 'left' | 'bottom' };

/**
 * Messages the simulator iframe sends back to the tutorial host.
 */
export type TutorialIframeMessage =
  | { type: 'sim-test-result'; passed: number; failed: number; total: number;
      details: Array<{ passed: boolean; inputs: Record<string, number>;
                       expected: Record<string, number>; actual: Record<string, number> }> }
  | { type: 'sim-circuit-data'; data: string; format: 'dig-xml-base64' | 'dts-json-base64' }
  | { type: 'sim-error'; error: string };

// ---------------------------------------------------------------------------
// Type guards — for runtime validation of JSON data
// ---------------------------------------------------------------------------

/** Check that a value is a non-null object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Check that a string is URL-safe (alphanumeric + hyphens). */
export function isUrlSafeId(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(s);
}

/** Type guard for TutorialComponentSpec. */
export function isTutorialComponentSpec(v: unknown): v is TutorialComponentSpec {
  if (!isObject(v)) return false;
  if (typeof v['id'] !== 'string' || v['id'].length === 0) return false;
  if (typeof v['type'] !== 'string' || v['type'].length === 0) return false;
  if (v['props'] !== undefined && !isObject(v['props'])) return false;
  if (v['layout'] !== undefined && !isObject(v['layout'])) return false;
  return true;
}

/** Type guard for TutorialCircuitSpec. */
export function isTutorialCircuitSpec(v: unknown): v is TutorialCircuitSpec {
  if (!isObject(v)) return false;
  if (!Array.isArray(v['components'])) return false;
  if (!Array.isArray(v['connections'])) return false;
  for (const comp of v['components'] as unknown[]) {
    if (!isTutorialComponentSpec(comp)) return false;
  }
  for (const conn of v['connections'] as unknown[]) {
    if (!Array.isArray(conn) || conn.length !== 2) return false;
    if (typeof conn[0] !== 'string' || typeof conn[1] !== 'string') return false;
  }
  return true;
}

/** Type guard for TutorialHint. */
export function isTutorialHint(v: unknown): v is TutorialHint {
  if (!isObject(v)) return false;
  if (typeof v['label'] !== 'string') return false;
  if (typeof v['content'] !== 'string') return false;
  return true;
}

/** Type guard for ValidationMode. */
export function isValidationMode(v: unknown): v is ValidationMode {
  return v === 'test-vectors' || v === 'equivalence' || v === 'compile-only' || v === 'manual';
}

/**
 * Type guard for TutorialStep.
 * Checks structural correctness only — not semantic validity.
 * Use `validateManifest()` for full validation including cross-references.
 */
export function isTutorialStep(v: unknown): v is TutorialStep {
  if (!isObject(v)) return false;
  if (v['mode'] !== undefined && v['mode'] !== 'guided' && v['mode'] !== 'explore') return false;
  if (typeof v['id'] !== 'string' || v['id'].length === 0) return false;
  if (typeof v['title'] !== 'string' || v['title'].length === 0) return false;
  if (typeof v['instructions'] !== 'string') return false;

  // startCircuit: null | "carry-forward" | CircuitSpec | string
  const sc = v['startCircuit'];
  if (sc !== null && sc !== undefined) {
    if (typeof sc === 'string') {
      // ok — "carry-forward" or .dig file path
    } else if (!isTutorialCircuitSpec(sc)) {
      return false;
    }
  }

  // goalCircuit: optional
  const gc = v['goalCircuit'];
  if (gc !== null && gc !== undefined) {
    if (typeof gc !== 'string' && !isTutorialCircuitSpec(gc)) return false;
  }

  // validation: optional
  if (v['validation'] !== undefined && !isValidationMode(v['validation'])) return false;

  // testData: optional string
  if (v['testData'] !== undefined && typeof v['testData'] !== 'string') return false;

  // hints: optional array
  if (v['hints'] !== undefined) {
    if (!Array.isArray(v['hints'])) return false;
    for (const h of v['hints']) {
      if (!isTutorialHint(h)) return false;
    }
  }

  return true;
}

/**
 * Type guard for TutorialManifest.
 * Checks structural correctness — use `validateManifest()` for full validation.
 */
export function isTutorialManifest(v: unknown): v is TutorialManifest {
  if (!isObject(v)) return false;
  if (typeof v['id'] !== 'string' || v['id'].length === 0) return false;
  if (v['version'] !== 1) return false;
  if (typeof v['title'] !== 'string' || v['title'].length === 0) return false;
  if (typeof v['description'] !== 'string') return false;
  if (!['beginner', 'intermediate', 'advanced'].includes(v['difficulty'] as string)) return false;
  if (!Array.isArray(v['steps']) || v['steps'].length === 0) return false;
  for (const step of v['steps'] as unknown[]) {
    if (!isTutorialStep(step)) return false;
  }
  return true;
}
