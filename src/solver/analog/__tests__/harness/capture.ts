/**
 * Capture functions that read our engine's internal state into the
 * common snapshot format defined in types.ts.
 */

import type { SparseSolver } from "../../sparse-solver.js";
import type { AnalogElement } from "../../element.js";
import { isPoolBacked } from "../../element.js";
import type { StatePool } from "../../state-pool.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import type { NRAttemptRecord } from "../../convergence-log.js";
import type { CKTCircuitContext } from "../../ckt-context.js";
import { bitsToName } from "../../ckt-mode.js";
import type {
  TopologySnapshot,
  IterationSnapshot,
  StepSnapshot,
  ElementStateSnapshot,
  NRAttempt,
  NRPhase,
  NRAttemptOutcome,
  IntegrationCoefficients,
} from "./types.js";
import type { LimitingEvent } from "../../newton-raphson.js";
import { normalizeDeviceType, DEVICE_MAPPINGS, projectPinCurrents } from "./device-mappings.js";
import { canonicalizeSpiceLabel } from "./netlist-generator.js";
import type { DeviceFamily } from "../../ngspice-load-order.js";

// ---------------------------------------------------------------------------
// Topology capture (once per compile)
// ---------------------------------------------------------------------------

/** Map typeId to SPICE prefix for auto-labelling. */
const TYPE_TO_PREFIX: Record<string, string> = {
  NpnBJT: "Q", PnpBJT: "Q",
  Diode: "D", Zener: "D",
  NMOS: "M", PMOS: "M",
  NJFET: "J", PJFET: "J",
  Resistor: "R",
  Capacitor: "C",
  Inductor: "L",
  DcVoltageSource: "V", AcVoltageSource: "V",
  DcCurrentSource: "I", AcCurrentSource: "I",
  Varactor: "D",
  SCR: "SCR", Triac: "TR",
};

/**
 * Map `DeviceFamily` → SPICE deck prefix. Used for composite-leaf label
 * canonicalization in `buildElementLabelMap` Pass 3 below: the leaf's
 * `deviceFamily` is set by its factory (e.g. a Resistor leaf inside
 * PolarizedCap has family RES), and the SPICE prefix derived from it matches
 * what `netlist-generator.ts` emits on the ngspice deck for that leaf.
 *
 * Source of truth: `netlist-generator.ts::ELEMENT_SPECS`. Keep in sync.
 */
const FAMILY_TO_SPICE_PREFIX: Partial<Record<DeviceFamily, string>> = {
  RES: "R", CAP: "C", IND: "L", MUT: "K",
  DIO: "D", BJT: "Q", MOS: "M", JFET: "J",
  VSRC: "V", ISRC: "I",
  VCVS: "E", VCCS: "G", CCVS: "H", CCCS: "F",
  SW: "S", CSW: "W",
  TRA: "T", URC: "U",
};

/**
 * Build a map from element index â†’ human-readable component label.
 *
 * Composite leaves (sub-elements emitted by `expandCompositeInstance`) have
 * NO entry in `compiled.elementToCircuitElement` — only the wrapper does.
 * Their `compiled.elements[i].label` is `${parentLabel}:${subName}`, set by
 * the compiler at composite-expansion time (where `parentLabel` is the
 * wrapper's user-label-or-instanceId).
 *
 * The deck emitter (`netlist-generator.ts`) flattens those leaves onto the
 * ngspice deck as `${spicePrefix}${wrapperHarnessLabel}_${subName}` — i.e.
 * with `:` replaced by `_` and a SPICE prefix prepended via
 * `canonicalizeSpiceLabel`. **The `wrapperHarnessLabel` is what this map
 * returns for the wrapper**, NOT the raw `parentLabel` from the leaf's
 * `.label` field — for unlabeled composites those differ (raw =
 * instanceId, harness = auto-numbered `X1`/`Q1`/...).
 *
 * Pass 3 below mirrors that exact emission so the element-state pairing
 * logic in `comparison-session.ts` (lines 1023, 3815) finds each leaf's
 * ngspice counterpart by case-insensitive label match. Without it,
 * `compareAllSteps` sees `ours=<value>, ngspice=NaN` for every composite
 * leaf state slot, and `harness_first_divergence` silently `continue`s past
 * every composite-leaf state comparison — masking real numerical
 * divergences inside composites.
 */
export function buildElementLabelMap(
  compiled: ConcreteCompiledAnalogCircuit,
): Map<number, string> {
  const map = new Map<number, string>();
  const e2ce = compiled.elementToCircuitElement;

  // Pass 1: user-set `label` property on top-level circuit elements (wrappers
  // and primitives). Leaves never reach this path because they have no
  // CircuitElement entry.
  for (let i = 0; i < compiled.elements.length; i++) {
    const ce = e2ce?.get(i);
    if (ce) {
      const humanLabel = ce.getProperties().getOrDefault<string>("label", "");
      if (humanLabel) {
        map.set(i, humanLabel);
      }
    }
  }

  // Pass 2: auto-number top-level circuit elements that didn't get a user
  // label. Composite leaves are deferred to Pass 3 — they're identified by
  // the `:` separator in their `.label` and need their wrapper's already-
  // assigned harness label to construct the canonical SPICE form.
  const prefixCounters = new Map<string, number>();
  for (let i = 0; i < compiled.elements.length; i++) {
    if (map.has(i)) continue;
    const el = compiled.elements[i];
    if (el && el.label.includes(":")) continue;   // composite leaf — defer

    const ce = e2ce?.get(i);
    const typeId = ce?.typeId ?? "";
    const prefix = TYPE_TO_PREFIX[typeId] ?? (typeId.charAt(0).toUpperCase() || "X");

    const count = (prefixCounters.get(prefix) ?? 0) + 1;
    prefixCounters.set(prefix, count);
    map.set(i, `${prefix}${count}`);
  }

  // Pass 3: composite leaves. Look up each leaf's wrapper by the raw parent
  // label (= wrapper's `.label`, which is its user-label-or-instanceId) and
  // build the canonical SPICE form `${wrapperHarnessLabel}_${subPath}` +
  // SPICE prefix from the leaf's `deviceFamily`.
  const wrapperHarnessLabelByRawParent = new Map<string, string>();
  for (let i = 0; i < compiled.elements.length; i++) {
    const el = compiled.elements[i];
    if (!el || el.label.includes(":")) continue;
    const harnessLabel = map.get(i);
    if (harnessLabel !== undefined) {
      wrapperHarnessLabelByRawParent.set(el.label, harnessLabel);
    }
  }
  for (let i = 0; i < compiled.elements.length; i++) {
    if (map.has(i)) continue;
    const el = compiled.elements[i];
    if (!el || !el.label.includes(":")) continue;

    const colonIdx = el.label.indexOf(":");
    const rawParent = el.label.slice(0, colonIdx);
    const subPath = el.label.slice(colonIdx + 1).replace(/:/g, "_");
    const wrapperHarnessLabel = wrapperHarnessLabelByRawParent.get(rawParent) ?? rawParent;
    const flattened = `${wrapperHarnessLabel}_${subPath}`;

    const prefix = FAMILY_TO_SPICE_PREFIX[el.deviceFamily];
    if (prefix !== undefined) {
      map.set(i, canonicalizeSpiceLabel(flattened, prefix));
    } else {
      // No SPICE prefix for this family (e.g. BEHAVIORAL bridge adapters).
      // Use the flattened label directly so diagnostic attribution stays
      // distinct from auto-numbered slots even when no ngspice counterpart
      // exists.
      map.set(i, flattened);
    }
  }

  return map;
}

/**
 * Capture the circuit topology from a compiled circuit.
 *
 * `matrixSize` must be supplied from the engine post-setup
 * (ngspice CKTmaxEqNum + 1) since ConcreteCompiledAnalogCircuit no longer
 * carries it.
 */
/**
 * Internal-node table entry as produced by MNAEngine._makeNode (ngspice
 * CKTnodeTab analogue). Names follow `${elementLabel}#${suffix}`.
 */
export interface CapturedNodeTableEntry {
  readonly name: string;
  readonly number: number;
  readonly type: "voltage" | "current";
}

export function captureTopology(
  compiled: ConcreteCompiledAnalogCircuit,
  matrixSize: number,
  elementLabels?: Map<number, string>,
  nodeTable?: readonly CapturedNodeTableEntry[],
): TopologySnapshot {
  const nodeLabels = new Map<number, string>();

  const perNode = new Map<number, string[]>();
  for (let i = 0; i < compiled.elements.length; i++) {
    const el = compiled.elements[i];
    const elLabel = elementLabels?.get(i) ?? `element_${i}`;
    const resolvedPins = compiled.elementResolvedPins?.get(i);
    const pinNodeValues = [...el.pinNodes.values()];
    for (let p = 0; p < pinNodeValues.length; p++) {
      const nodeId = pinNodeValues[p];
      if (nodeId === 0) continue;
      const pinLabel = resolvedPins?.[p]?.label ?? `p${p}`;
      const tag = `${elLabel}:${pinLabel}`;
      const existing = perNode.get(nodeId);
      if (existing) {
        if (existing.length < 3) existing.push(tag);
      } else {
        perNode.set(nodeId, [tag]);
      }
    }

  }

  // Internal (prime) nodes- IDs and names come from MNAEngine._nodeTable
  // (ngspice CKTnodeTab analogue, populated by ctx.makeVolt during setup()).
  // Replaces the prior per-element `pinCount + p` heuristic, which conflated
  // a per-element pin count with the engine's global equation counter and
  // mis-mapped internal-node labels onto pin-node rows for any multi-element
  // circuit. ngspice path: cktnoddmp.c walks CKTnodeTab; we walk the same
  // table here. Names from _makeNode are `${label}#${suffix}`; convert to
  // the existing `${label}:${suffix}` convention so internal-node tags read
  // consistently with pin-node tags downstream.
  if (nodeTable) {
    for (const entry of nodeTable) {
      if (entry.type !== "voltage") continue;
      if (perNode.has(entry.number)) continue;
      const tag = entry.name.replace("#", ":");
      perNode.set(entry.number, [tag]);
    }
  }
  for (const [nodeId, tags] of perNode) {
    nodeLabels.set(nodeId, tags.join("/"));
  }

  const matrixRowLabels = new Map<number, string>();
  const matrixColLabels = new Map<number, string>();

  nodeLabels.forEach((label, nodeId) => {
    const row = nodeId - 1;
    if (row >= 0 && row < compiled.nodeCount) {
      matrixRowLabels.set(row, label);
      matrixColLabels.set(row, label);
    }
  });

  // Branch rows: use each element's authoritative branchIndex (allocated by
  // ctx.makeCur in setup()) as the sole gate. Any analog element with
  // branchIndex > 0 owns a branch row, including composite sub-elements
  // (e.g. Vtx_vSense inside the Optocoupler) whose elementToCircuitElement
  // lookup returns undefined because they have no top-level CircuitElement.
  // The label falls back to el.label, which expandCompositeInstance sets to
  // ${parentLabel}:${subElementName} for sub-elements and user labels for
  // top-level elements. el.branchIndex is 1-based post-sentinel; subtract 1
  // for the 0-based matrix-row convention.
  for (let i = 0; i < compiled.elements.length; i++) {
    const el = compiled.elements[i];
    if (el.branchIndex <= 0) continue;
    const label = elementLabels?.get(i) ?? el.label ?? `element_${i}`;
    const branchRow = el.branchIndex - 1;
    matrixRowLabels.set(branchRow, `${label}:branch`);
    matrixColLabels.set(branchRow, `${label}:branch`);
  }

  return {
    matrixSize,
    nodeCount: compiled.nodeCount,
    elementCount: compiled.elements.length,
    elements: compiled.elements.map((el, i) => {
      const ce = compiled.elementToCircuitElement?.get(i);
      const typeId = ce?.typeId ?? "";
      return {
        index: i,
        label: elementLabels?.get(i) ?? el.label ?? `element_${i}`,
        type: normalizeDeviceType(typeId),
        pinNodeIds: [...el.pinNodes.values()],
      };
    }),
    nodeLabels,
    matrixRowLabels,
    matrixColLabels,
  };
}

// ---------------------------------------------------------------------------
// Element state capture
// ---------------------------------------------------------------------------

export function captureElementStates(
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
  elementLabels?: Map<number, string>,
  elementTypes?: Map<number, string>,
): ElementStateSnapshot[] {
  if (!statePool) return [];
  const snapshots: ElementStateSnapshot[] = [];
  const s0 = statePool.state0;
  const s1 = statePool.state1;
  const s2 = statePool.state2;
  const s3 = statePool.state3;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!isPoolBacked(el)) continue;

    const schema = el.stateSchema;
    const base = el._stateBase;
    const baseLabel = elementLabels?.get(i) ?? el.label ?? `element_${i}`;

    // SWElementSPDT (SwitchSPDT): 4 state slots split across two ngspice S-elements.
    // Emit two sub-snapshots with labels {label}_AB (NO path, slots 0-1) and
    // {label}_AC (NC path, slots 2-3), each carrying renamed CURRENT_STATE/V_CTRL
    // slots to match ngspice's per-S-element CKTstate layout (swdefs.h:56).
    if (schema.owner === "SWElementSPDT") {
      const vswitchMapping = DEVICE_MAPPINGS["vswitch"];
      // AB sub-entry: NO path (base+0=NO_CURRENT_STATE, base+1=NO_V_CTRL)
      const abSlots: Record<string, number> = { CURRENT_STATE: s0[base + 0], V_CTRL: s0[base + 1] };
      const abState1: Record<string, number> = s1 ? { CURRENT_STATE: s1[base + 0], V_CTRL: s1[base + 1] } : {};
      const abState2: Record<string, number> = s2 ? { CURRENT_STATE: s2[base + 0], V_CTRL: s2[base + 1] } : {};
      const abState3: Record<string, number> = s3 ? { CURRENT_STATE: s3[base + 0], V_CTRL: s3[base + 1] } : {};
      snapshots.push({
        elementIndex: i,
        label: `${baseLabel}_AB`,
        deviceType: "vswitch",
        slots: abSlots,
        state1Slots: abState1,
        state2Slots: abState2,
        state3Slots: abState3,
        pinCurrents: projectPinCurrents(vswitchMapping, abSlots),
      });
      // AC sub-entry: NC path (base+2=NC_CURRENT_STATE, base+3=NC_V_CTRL)
      const acSlots: Record<string, number> = { CURRENT_STATE: s0[base + 2], V_CTRL: s0[base + 2 + 1] };
      const acState1: Record<string, number> = s1 ? { CURRENT_STATE: s1[base + 2], V_CTRL: s1[base + 2 + 1] } : {};
      const acState2: Record<string, number> = s2 ? { CURRENT_STATE: s2[base + 2], V_CTRL: s2[base + 2 + 1] } : {};
      const acState3: Record<string, number> = s3 ? { CURRENT_STATE: s3[base + 2], V_CTRL: s3[base + 2 + 1] } : {};
      snapshots.push({
        elementIndex: i,
        label: `${baseLabel}_AC`,
        deviceType: "vswitch",
        slots: acSlots,
        state1Slots: acState1,
        state2Slots: acState2,
        state3Slots: acState3,
        pinCurrents: projectPinCurrents(vswitchMapping, acSlots),
      });
      continue;
    }

    const slots: Record<string, number> = {};
    const state1Slots: Record<string, number> = {};
    const state2Slots: Record<string, number> = {};
    const state3Slots: Record<string, number> = {};

    for (let s = 0; s < schema.slots.length; s++) {
      const name = schema.slots[s].name;
      slots[name] = s0[base + s];
      if (s1) state1Slots[name] = s1[base + s];
      if (s2) state2Slots[name] = s2[base + s];
      if (s3) state3Slots[name] = s3[base + s];
    }

    const deviceType = elementTypes?.get(i);
    const mapping = deviceType ? DEVICE_MAPPINGS[deviceType] : undefined;
    const pinCurrents = projectPinCurrents(mapping, slots);

    snapshots.push({
      elementIndex: i,
      label: baseLabel,
      // Record the canonical device type so consumers route slot mapping by
      // type, not by label prefix (VDMOS and MOSFET share the `M` prefix).
      ...(deviceType !== undefined ? { deviceType } : {}),
      slots,
      state1Slots,
      state2Slots,
      state3Slots,
      pinCurrents,
    });
  }

  return snapshots;
}

// ---------------------------------------------------------------------------
// Per-iteration capture hook factory
// ---------------------------------------------------------------------------

/**
 * Post-iteration hook signature matching NROptions.postIterationHook.
 */
export type PostIterationHook = (
  iteration: number,
  rhs: Float64Array,
  prevVoltages: Float64Array,
  noncon: number,
  globalConverged: boolean,
  elemConverged: boolean,
  limitingEvents: LimitingEvent[],
  convergenceFailedElements: string[],
  ctx: CKTCircuitContext,
) => void;

/**
 * Create a postIterationHook + preFactorHook pair that captures every NR
 * iteration into an IterationSnapshot array and maintains a drainable
 * IterationDetail buffer.
 *
 * The pre-factor hook fires between cktLoad and solver.preorder()/factor()
 * (newton-raphson.ts STEP B+; mirrors ngspice niiter.c:704-842 + 915-924).
 * It captures the post-load, pre-LU MNA matrix and the pre-solve RHS into
 * scratch buffers- the unique window where these values are observable
 * before factor() overwrites _elVal[] with LU and solve() overwrites
 * ctx.rhs with the solution. The post-iteration hook reads the scratch
 * buffers when assembling each IterationSnapshot.
 */
export function createIterationCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null | (() => StatePool | null),
  elementLabels?: Map<number, string>,
  elementTypes?: Map<number, string>,
): {
  hook: PostIterationHook;
  preFactorHook: (ctx: CKTCircuitContext) => void;
  getSnapshots: () => IterationSnapshot[];
  clear: () => void;
  drainForLog: () => NRAttemptRecord["iterationDetails"];
} {
  // Normalize the statePool argument into a getter. The MNAEngine creates its
  // statePool lazily inside _setup() (called from the first dcOperatingPoint() /
  // step()), which runs AFTER the harness wires up its capture hooks. Capturing
  // the statePool by value at hook-construction time would freeze it at `null`
  // and silently no-op every captureElementStates() call- which is exactly the
  // bug that left every parity-test elementStates array empty for our side.
  const getStatePool: () => StatePool | null =
    typeof statePool === "function" ? statePool : () => statePool;

  let snapshots: IterationSnapshot[] = [];
  let detailBuffer: NonNullable<NRAttemptRecord["iterationDetails"]> = [];

  // Pre-factor scratch buffers- populated by preFactorHook, consumed by hook.
  // Mirrors ngspice's static ni_mxColPtr / ni_mxRowIdx / ni_mxVals / ni_preSolveRhs
  // (niiter.c:170-175, 166-167)- one snapshot per NR iteration, overwritten
  // each iteration before the post-iteration hook reads it.
  let preFactorMatrix: ReturnType<SparseSolver["getCSCNonZeros"]> = [];
  let preSolveRhs: Float64Array = new Float64Array(0);

  // Build a map from raw el.label (used by newton-raphson convergenceFailedElements)
  // to the human label (used by elementStates / elementLabels). This ensures
  // convergenceFailedElements and elementStates use the same label namespace.
  const rawLabelToHumanLabel = new Map<string, string>();
  if (elementLabels) {
    for (let i = 0; i < elements.length; i++) {
      const human = elementLabels.get(i);
      if (human === undefined) continue;
      const raw = elements[i].label ?? `element_${i}`;
      if (raw !== human) rawLabelToHumanLabel.set(raw, human);
    }
  }

  const preFactorHook = (ctx: CKTCircuitContext): void => {
    // Window: post-cktLoad, pre-preorder/factor. ctx.rhs holds load stamps;
    // solver._elVal[] holds post-load, pre-LU MNA values. ngspice
    // niiter.c:704-842 (matrix) + niiter.c:915-924 (pre-solve RHS)- both
    // captures land in this window since factor() does not write RHS.
    preFactorMatrix = solver.getCSCNonZeros();
    if (preSolveRhs.length !== ctx.rhs.length) {
      preSolveRhs = new Float64Array(ctx.rhs.length);
    }
    preSolveRhs.set(ctx.rhs);
  };

  const hook: PostIterationHook = (
    iteration, rhs, prevVoltages, noncon, globalConverged, elemConverged,
    limitingEvents, convergenceFailedElements, ctx,
  ) => {
    let maxDelta = 0;
    let maxDeltaNode = -1;
    for (let i = 0; i < rhs.length; i++) {
      const d = Math.abs(rhs[i] - prevVoltages[i]);
      if (d > maxDelta) { maxDelta = d; maxDeltaNode = i; }
    }

    detailBuffer.push({ iteration, maxDelta, maxDeltaNode, noncon, converged: globalConverged });

    // Remap convergenceFailedElements from raw el.label to human labels so they
    // match the labels used in elementStates (built from elementLabels).
    const remappedFailedElements = rawLabelToHumanLabel.size > 0
      ? convergenceFailedElements.map(l => rawLabelToHumanLabel.get(l) ?? l)
      : convergenceFailedElements;

    // W2.3: diagnostic label decoded from the `cktMode` bitfield (cktdefs.h:165-185).
    // bitsToName joins multiple set bits with "|"- e.g. "MODEDCOP|MODEINITJCT".
    const resolvedInitMode = bitsToName(ctx.cktMode);

    // matrixSize: mirror ngspice's CKTmaxEqNum-based counter convention
    // (cktinit.c:43 initializes CKTmaxEqNum = 1; cktlnkeq.c:32 post-increments
    // on each CKTmkVolt/CKTmkCur). After N active equations ngspice has
    // CKTmaxEqNum = 1 + N, and reports matrixSize = CKTmaxEqNum + 1 = N + 2.
    // Our rhs.length is N + 1 (ground sentinel + N active eqs), so the
    // ngspice-equivalent matrixSize is rhs.length + 1. The +1 is a
    // post-inc setup tracker, not an actual rhs-vector slot- ngspice's
    // CKTrhs is allocated to SMPmatSize+1 = N+1 doubles (nireinit.c).
    //
    // rhsBufSize: actual rhs/rhsOld/preSolveRhs buffer length. Our engine
    // has no TrashCan-style stamp folding, so this equals rhs.length.
    // ngspice carries this as a separate field because its rhs buffer
    // (SMPmatSize+1) can be smaller than its matrixSize (CKTmaxEqNum+1).
    const ourMatrixSize = rhs.length + 1;
    const ourRhsBufSize = rhs.length;

    snapshots.push({
      iteration,
      matrixSize: ourMatrixSize,
      rhsBufSize: ourRhsBufSize,
      voltages: rhs.slice(),
      prevVoltages: prevVoltages.slice(),
      preSolveRhs: preSolveRhs.slice(),
      matrix: preFactorMatrix,
      elementStates: captureElementStates(elements, getStatePool(), elementLabels, elementTypes),
      noncon,
      diagGmin: ctx.diagonalGmin,
      srcFact: ctx.srcFact,
      initMode: resolvedInitMode,
      // ctx.ag is a live length-7 reused buffer (see CKTCircuitContext:ctx.ag
      // allocated once in constructor at ckt-context.ts:511). A fresh copy is
      // MANDATORY here- without `new Float64Array(...)` every snapshot would
      // alias the latest step's coefficients, destroying per-iteration history.
      ag: new Float64Array(ctx.ag),
      method: ctx.loadCtx.method,
      order: ctx.loadCtx.order,
      // Mirror ngspice: each iteration captures the active CKTdelta. dctran.c
      // sets CKTdelta=delta before each NIiter call (line 770) and dcop.c
      // never writes CKTdelta (cktdojob.c:117 zero persists during DCOP). Our
      // engine sets ctx.loadCtx.dt before each NIiter (analog-engine.ts:432)
      // and DCOP entry zeroes ctx.loadCtx.dt (analog-engine.ts dcOperatingPoint
      // / _transientDcop) to mirror that flow.
      delta: ctx.loadCtx.dt,
      globalConverged,
      elemConverged,
      limitingEvents: [...limitingEvents],
      convergenceFailedElements: remappedFailedElements,
      ngspiceConvergenceFailedDevices: [],
    });
  };

  return {
    hook,
    preFactorHook,
    getSnapshots: () => snapshots,
    clear: () => {
      snapshots = [];
      detailBuffer = [];
      preFactorMatrix = [];
      // Keep preSolveRhs allocation; length-match guard inside preFactorHook
      // resizes if the matrix dimension changes between runs.
    },
    drainForLog(): NRAttemptRecord["iterationDetails"] {
      const drained = detailBuffer.slice();
      detailBuffer = [];
      return drained;
    },
  };
}

// ---------------------------------------------------------------------------
// Phase-aware step capture hook (spec ss4.2)
// ---------------------------------------------------------------------------

/**
 * Create a phase-aware step capture hook.
 *
 * API:
 *   beginAttempt(phase, dt, phaseParameter?)- opens a new NRAttempt.
 *     stepStartTime is captured from simTime on the first beginAttempt call
 *     for this step (currentStep === null).
 *   endAttempt(outcome, converged)- closes the current NRAttempt.
 *   endStep({ stepEndTime, integrationCoefficients, analysisPhase, acceptedAttemptIndex })
 *    - emits the completed StepSnapshot.
 *   peekIterations()- view current iteration snapshots without consuming.
 *   getSteps()- all completed steps.
 *   clear()- reset all state.
 *
 * Usage for DCOP (called from comparison-session.ts before compile()):
 *   beginAttempt("dcopDirect", 0)
 *   ... NR iterations fire via hook ...
 *   endAttempt("dcopSubSolveConverged" | "nrFailedRetry", converged)
 *   ... more sub-solves ...
 *   endStep({ stepEndTime: 0, integrationCoefficients: zeroDcop, analysisPhase: "dcop", acceptedAttemptIndex: N })
 *
 * Usage for transient (called from comparison-session.ts per coordinator.step()):
 *   beginAttempt("tranInit" | "tranPredictor" | "tranNR", dt)
 *   ... NR iterations fire via hook ...
 *   endAttempt("accepted" | "nrFailedRetry" | "lteRejectedRetry", converged)
 *   endStep({ stepEndTime: engine.simTime, ... })
 */
export function createStepCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null | (() => StatePool | null),
  elementLabels?: Map<number, string>,
  elementTypes?: Map<number, string>,
): {
  iterationHook: PostIterationHook & { drainForLog: () => NRAttemptRecord["iterationDetails"] };
  preFactorHook: (ctx: CKTCircuitContext) => void;
  beginAttempt(phase: NRPhase, dt: number, phaseParameter?: number): void;
  endAttempt(outcome: NRAttemptOutcome, converged: boolean): void;
  endStep(params: {
    stepEndTime: number;
    integrationCoefficients: IntegrationCoefficients;
    analysisPhase: "dcop" | "tranInit" | "tranFloat";
    acceptedAttemptIndex: number;
    /** Integration order for the step (1 = order-1 trap/gear, 2 = order-2 trap/gear). Required. */
    order: number;
    /** Timestep used for the step (seconds). Required. */
    delta: number;
    /** LTE-proposed next timestep from TimestepController.computeNewDt(). */
    lteDt?: number;
  }): void;
  /** Set the stepStartTime for the currently-open step (called before endStep). */
  setStepStartTime(t: number): void;
  peekIterations: () => readonly IterationSnapshot[];
  getSteps: () => StepSnapshot[];
  clear: () => void;
} {
  const iterCapture = createIterationCaptureHook(solver, elements, statePool, elementLabels, elementTypes);
  const steps: StepSnapshot[] = [];

  // Current open step state
  let currentStepStartTime: number | null = null;
  let pendingAttempts: NRAttempt[] = [];
  let currentAttemptPhase: NRPhase = "tranNR";
  let currentAttemptDt: number = 0;
  let currentAttemptPhaseParameter: number | undefined = undefined;

  const iterationHook = Object.assign(iterCapture.hook, {
    drainForLog: iterCapture.drainForLog,
  });

  return {
    iterationHook,
    preFactorHook: iterCapture.preFactorHook,
    peekIterations: () => iterCapture.getSnapshots(),

    /**
     * Begin a new NR attempt. If no step is currently open, opens one
     * and captures dt as stepStartTime sentinel (actual stepStartTime is
     * set from the first iteration's simTime context- but since we don't
     * have engine.simTime here, callers must pass 0 for DCOP and the
     * pre-advance simTime for transient).
     *
     * For the harness, the stepStartTime is tracked externally by
     * comparison-session.ts and passed into endStep. beginAttempt only
     * needs to open the attempt bookkeeping.
     */
    beginAttempt(phase: NRPhase, dt: number, phaseParameter?: number): void {
      currentAttemptPhase = phase;
      currentAttemptDt = dt;
      currentAttemptPhaseParameter = phaseParameter;
      iterCapture.clear();
    },

    /**
     * Close the current NR attempt. Pushes it into pendingAttempts.
     */
    endAttempt(outcome: NRAttemptOutcome, converged: boolean): void {
      const iterations = iterCapture.getSnapshots();
      if (iterations.length > 0 || pendingAttempts.length === 0) {
        // Derive role from phase and position within the step
        let role: import("./types.js").AttemptRole | undefined;
        if (currentAttemptPhase === "dcopInitJct") {
          // Mirror ngspice-bridge.ts:95 (cktModeToRole): the MODEINITJCT
          // attempt is unconditionally tagged "junctionPrime". It corresponds
          // to ngspice's forced-non-converging junction-prime iter
          // (niiter.c:1205 sets CKTnoncon=1 at iterno==1; niiter.c:1308-1310
          // flips to MODEINITFIX).
          role = "junctionPrime";
        } else if (currentAttemptPhase === "dcopInitFloat" && pendingAttempts.length === 0) {
          role = "coldStart";
        } else if (currentAttemptPhase === "dcopDirect") {
          role = "mainSolve";
        } else if (
          (currentAttemptPhase === "tranInit" ||
           currentAttemptPhase === "tranPredictor" ||
           currentAttemptPhase === "tranNR") &&
          converged
        ) {
          role = "tranSolve";
        }
        const attempt: NRAttempt = {
          dt: currentAttemptDt,
          iterations: [...iterations],
          converged,
          iterationCount: iterations.length,
          phase: currentAttemptPhase,
          outcome,
          ...(role !== undefined ? { role } : {}),
          ...(currentAttemptPhaseParameter !== undefined
            ? { phaseParameter: currentAttemptPhaseParameter }
            : {}),
        };
        pendingAttempts.push(attempt);
      }
      iterCapture.clear();
    },

    /**
     * Close the current step and emit a StepSnapshot.
     */
    endStep(params: {
      stepEndTime: number;
      integrationCoefficients: IntegrationCoefficients;
      analysisPhase: "dcop" | "tranInit" | "tranFloat";
      acceptedAttemptIndex: number;
      /** Integration order for the step (1 = order-1 trap/gear, 2 = order-2 trap/gear). */
      order: number;
      /** Timestep used for the step (seconds). */
      delta: number;
      /** LTE-proposed next timestep from TimestepController.computeNewDt(). */
      lteDt?: number;
    }): void {
      if (pendingAttempts.length === 0) {
        // Nothing to emit- no attempts were recorded
        return;
      }

      const acceptedIdx = params.acceptedAttemptIndex < 0
        ? pendingAttempts.length - 1
        : Math.min(params.acceptedAttemptIndex, pendingAttempts.length - 1);

      const acceptedAttempt = pendingAttempts[acceptedIdx]!;
      const stepStartTime = currentStepStartTime ?? 0;

      // Determine analysisPhase from accepted attempt phase if not explicitly tranFloat
      let analysisPhase = params.analysisPhase;
      if (acceptedAttempt.phase === "tranInit") {
        analysisPhase = "tranInit";
      }

      // Paint per-step `delta` onto the last iteration of the accepted
      // attempt. `order` is now set per-iteration from ctx.loadCtx.order in
      // createIterationCaptureHook- do NOT overwrite it at step-end or the
      // per-iteration history (needed to discriminate H1 vs H2 vs H3) is lost.
      if (acceptedAttempt.iterations.length > 0) {
        const lastIter = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1]!;
        lastIter.delta = params.delta;
      }

      // Populate lteDt on the last iteration of the accepted attempt so
      // assertIterationMatch can compare it bit-exact across both engines.
      if (params.lteDt !== undefined && acceptedAttempt.iterations.length > 0) {
        const lastIter = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1]!;
        lastIter.lteDt = params.lteDt;
      }

      steps.push({
        stepStartTime,
        stepEndTime: params.stepEndTime,
        attempts: [...pendingAttempts],
        acceptedAttemptIndex: acceptedIdx,
        accepted: acceptedAttempt.outcome === "accepted" || acceptedAttempt.outcome === "dcopSubSolveConverged",
        dt: acceptedAttempt.dt,
        iterations: acceptedAttempt.iterations,
        converged: acceptedAttempt.converged,
        iterationCount: acceptedAttempt.iterationCount,
        totalIterationCount: pendingAttempts.reduce((sum, a) => sum + a.iterationCount, 0),
        integrationCoefficients: params.integrationCoefficients,
        analysisPhase,
      });

      // Reset step state
      currentStepStartTime = params.stepEndTime;
      pendingAttempts = [];
      iterCapture.clear();
    },

    setStepStartTime(t: number): void {
      currentStepStartTime = t;
    },

    getSteps: () => steps,

    clear: () => {
      steps.length = 0;
      pendingAttempts = [];
      currentStepStartTime = null;
      iterCapture.clear();
    },
  };
}
