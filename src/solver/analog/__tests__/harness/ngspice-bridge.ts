/**
 * Node FFI bridge to ngspice shared library (extended).
 *
 * Loads ngspice.dll via koffi, registers both the per-iteration
 * instrumentation callback and the one-time topology callback,
 * runs a SPICE netlist, and converts ngspice data into our
 * CaptureSession format with full device-state unpacking.
 *
 * IMPORTANT: This module is test-only and requires native addons.
 * It is not bundled into the browser application. Tests that use
 * this bridge should be in a separate test file with a guard:
 *
 *   import.meta.env?.NGSPICE_DLL_PATH || describe.skip(...)
 *
 * Environment variable:
 *   NGSPICE_DLL_PATH — absolute path to ngspice.dll with instrumentation
 */

import type {
  CaptureSession,
  TopologySnapshot,
  StepSnapshot,
  NRAttempt,
  NRPhase,
  AttemptRole,
  NRAttemptOutcome,
  IterationSnapshot,
  ElementStateSnapshot,
  NgspiceTopology,
  NgspiceDeviceInfo,
  RawNgspiceIterationEx,
  RawNgspiceOuterEvent,
  RawNgspiceTopology,
  IntegrationCoefficients,
  MatrixEntry,
  LimitingEvent,
} from "./types.js";
import type { IntegrationMethod } from "../../../../core/analog-types.js";
import { bitsToName } from "../../ckt-mode.js";
import { DEVICE_MAPPINGS } from "./device-mappings.js";

// ---------------------------------------------------------------------------
// CKTmode constants (from ref/ngspice/src/include/ngspice/cktdefs.h:166-182)
// ---------------------------------------------------------------------------
const MODETRAN       = 0x0001;
const MODEDCOP       = 0x0010;
const MODETRANOP     = 0x0020;
const MODEINITFLOAT  = 0x0100;
const MODEINITJCT    = 0x0200;
const MODEINITFIX    = 0x0400;
const MODEINITTRAN   = 0x1000;
const MODEINITPRED   = 0x2000;

// phaseFlags bits (from ni_set_phase_flags)
const PF_GMIN_DYN = 0x1;
const PF_SRC_STEP = 0x2;
const PF_GMIN_SP3 = 0x4;

function cktModeToPhase(mode: number, phaseFlags: number): NRPhase {
  const inGminDyn = (phaseFlags & PF_GMIN_DYN) !== 0;
  const inSrcStep = (phaseFlags & PF_SRC_STEP) !== 0;
  const inGminSp3 = (phaseFlags & PF_GMIN_SP3) !== 0;

  // Standalone `op`: CKTop(firstmode=MODEDCOP|MODEINITJCT, continuemode=MODEDCOP|MODEINITFLOAT).
  // Transient's DC OP: dctran.c uses MODETRANOP|MODEINITJCT → MODETRANOP|MODEINITFLOAT.
  // Treat both as DCOP phases; stepping sub-solves are distinguished by phaseFlags.
  const isDcOpFamily = (mode & (MODEDCOP | MODETRANOP)) !== 0;
  if (isDcOpFamily) {
    if (inSrcStep) return "dcopSrcSweep";
    if (inGminSp3) return "dcopGminSpice3";
    if (inGminDyn) return "dcopGminDynamic";
    if (mode & MODEINITJCT)   return "dcopInitJct";
    if (mode & MODEINITFIX)   return "dcopInitFix";
    if (mode & MODEINITFLOAT) return "dcopInitFloat";
    // MODEDCOP|MODETRANOP only (no init flag): pure DC-OP direct iteration.
    return "dcopDirect";
  }
  if (mode & MODEINITPRED)  return "tranPredictor";
  if (mode & MODEINITTRAN)  return "tranInit";
  if (mode & MODETRAN)      return "tranNR";
  if (mode & MODEINITFLOAT) return "tranNR";
  return "tranNR";
}

function cktModeToRole(
  mode: number,
  phaseFlags: number,
  attemptIndexInStep: number,
): AttemptRole | undefined {
  const phase = cktModeToPhase(mode, phaseFlags);
  if (phase === "dcopInitJct")    return "junctionPrime";
  if (phase === "dcopDirect")     return "mainSolve";
  // dcopInitFloat at index 0 is a cold-start; finalVerify is assigned retroactively
  // in flushStep after the full attempt list is known.
  if (phase === "dcopInitFloat" && attemptIndexInStep === 0) return "coldStart";
  return undefined;
}

/**
 * Classify a `cktMode` bitfield into the coarse analysisPhase bucket used by
 * StepSnapshot. DCOP init ladder stages (MODEDCOP / MODETRANOP, plus the
 * MODEINITJCT/FIX/FLOAT/SMSIG sub-phases) collapse to "dcop". MODEINITTRAN
 * is the first transient NR call after DCOP → "tranInit". Anything else
 * running under MODETRAN is free-running transient → "tranFloat".
 *
 * Cite cktdefs.h:166-182 for the bit assignments.
 */
function cktModeToAnalysisPhase(cktMode: number): "dcop" | "tranInit" | "tranFloat" {
  if (cktMode & (MODEDCOP | MODETRANOP)) return "dcop";
  if (cktMode & MODEINITTRAN) return "tranInit";
  return "tranFloat";
}

/** Extract only the ngspice-side integration coefficients from a raw iteration. */
function _ngspiceIntegCoeff(raw: RawNgspiceIterationEx | undefined): IntegrationCoefficients["ngspice"] {
  if (!raw) {
    return { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 };
  }
  // ngspice CKTintegrateMethod (cktintegrate.c): MIF_TRAP=1, MIF_GEAR=2. No MIF_BE.
  const methodMap: Record<number, IntegrationMethod> = { 1: "trapezoidal", 2: "gear" };
  return {
    ag0: raw.ag0 ?? 0,
    ag1: raw.ag1 ?? 0,
    method: methodMap[raw.integrateMethod ?? 1] ?? "trapezoidal",
    order: raw.order ?? 1,
  };
}

/** Junction ID to string name mapping for limiting events. */
const JUNCTION_ID_MAP: Record<number, string> = {
  0: "AK", 1: "BE", 2: "BC", 3: "GS", 4: "DS",
  5: "GD", 6: "BS", 7: "BD", 8: "CS",
};

// ---------------------------------------------------------------------------
// Internal grouping state
// ---------------------------------------------------------------------------

interface PendingAttempt {
  phase: NRPhase;
  phaseFlags: number;
  iterations: IterationSnapshot[];
  firstRaw: RawNgspiceIterationEx;
}

interface PendingStep {
  stepStartTime: number;
  attempts: NRAttempt[];
  pendingAttempt: PendingAttempt | null;
}

// ---------------------------------------------------------------------------
// NgspiceBridge
// ---------------------------------------------------------------------------

export class NgspiceBridge {
  private _dllPath: string;
  private _lib: any;
  private _cmd: any = null;

  private _iterations: RawNgspiceIterationEx[] = [];
  private _outerEvents: RawNgspiceOuterEvent[] = [];
  private _rawTopology: RawNgspiceTopology | null = null;
  private _topology: NgspiceTopology | null = null;

  constructor(dllPath: string) {
    this._dllPath = dllPath;
  }

  async init(): Promise<void> {
    const koffiModule = await import("koffi");
    const koffi = (koffiModule as any).default ?? koffiModule;
    this._lib = koffi.load(this._dllPath);

    const uid = `_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const SendChar = koffi.proto(`int SendCharCb${uid}(char*, int, void*)`);
    const SendStat = koffi.proto(`int SendStatCb${uid}(char*, int, void*)`);
    const ControlledExit = koffi.proto(`int ControlledExitCb${uid}(int, int, int, void*)`);

    // SendChar receives every line ngspice would print to stdout/stderr —
    // including "Warning: parameter X ignored" notices when our netlist
    // contains a model param ngspice's parser doesn't recognise. Silently
    // swallowing them masked netlist bugs that left ngspice in a broken
    // state and crashed the worker fork mid-run. NGSPICE_LOG=1 surfaces the
    // stream so test fixtures can be debugged.
    const logNgspice = process.env.NGSPICE_LOG === "1";
    const charCb = koffi.register((msg: string, _id: number, _ud: any) => {
      if (logNgspice && typeof msg === "string") {
        process.stderr.write(`[ngspice] ${msg}\n`);
      }
      return 0;
    }, koffi.pointer(SendChar));
    const statCb = koffi.register((msg: string, _id: number, _ud: any) => {
      if (logNgspice && typeof msg === "string") {
        process.stderr.write(`[ngspice-stat] ${msg}\n`);
      }
      return 0;
    }, koffi.pointer(SendStat));
    const exitCb = koffi.register((status: number, _unload: number, _quit: number, _ud: any) => {
      if (logNgspice) {
        process.stderr.write(`[ngspice-exit] status=${status}\n`);
      }
      return 0;
    }, koffi.pointer(ControlledExit));

    const initFn = this._lib.func(
      `int ngSpice_Init(SendCharCb${uid}*, SendStatCb${uid}*, ControlledExitCb${uid}*, void*, void*, void*, void*)`,
    );
    initFn(charCb, statCb, exitCb, null, null, null, null);

    this._registerTopologyCallback(koffi, uid);
    this._registerIterationCallback(koffi, uid);
    this._registerOuterCallback(koffi, uid);

    this._cmd = this._lib.func("int ngSpice_Command(str)");
  }

  private _registerTopologyCallback(koffi: any, uid: string): void {
    const topoCbType = koffi.proto(
      `void ni_topo_cb${uid}(` +
      `str, _Inout_ int*, int, ` +
      `str, str, ` +
      `_Inout_ int*, int, ` +
      `int, int, ` +
      `_Inout_ int*, _Inout_ int*)`,
    );

    const registerFn = this._lib.func(`void ni_topology_register(ni_topo_cb${uid}*)`);

    const callback = koffi.register(
      (nodeNamesJoined: string, nodeNumbersPtr: any, nodeCount: number,
       devNamesJoined: string, devTypesJoined: string,
       devStateBasesPtr: any, devCount: number,
       matrixSize: number, numStates: number,
       devNodeFlatRaw: any, devNodeCountsRaw: any) => {

        const nodeNames = nodeNamesJoined ? nodeNamesJoined.split("|") : [];
        const devNames = devNamesJoined ? devNamesJoined.split("|") : [];
        const devTypes = devTypesJoined ? devTypesJoined.split("|") : [];

        const nodeNumbers: number[] = nodeNumbersPtr
          ? Array.from(koffi.decode(nodeNumbersPtr, "int", nodeCount)) : [];
        const devStateBases: number[] = devStateBasesPtr
          ? Array.from(koffi.decode(devStateBasesPtr, "int", devCount)) : [];

        const nodeCounts: number[] | null = devNodeCountsRaw
          ? Array.from(koffi.decode(devNodeCountsRaw, "int", devCount)) : null;

        const totalNodeIndices = nodeCounts ? nodeCounts.reduce((a, b) => a + b, 0) : 0;
        const devNodeFlat: number[] | null = devNodeFlatRaw && nodeCounts && totalNodeIndices > 0
          ? Array.from(koffi.decode(devNodeFlatRaw, "int", totalNodeIndices)) : null;

        const nodes: RawNgspiceTopology["nodes"] = [];
        for (let i = 0; i < nodeCount; i++) {
          nodes.push({ name: nodeNames[i] ?? "", number: nodeNumbers[i] ?? i });
        }

        const devices: RawNgspiceTopology["devices"] = [];
        let flatOffset = 0;
        for (let i = 0; i < devCount; i++) {
          const count = nodeCounts?.[i] ?? 0;
          const nodeIndices = devNodeFlat ? devNodeFlat.slice(flatOffset, flatOffset + count) : [];
          flatOffset += count;
          devices.push({
            name: devNames[i] ?? "",
            typeName: devTypes[i] ?? "",
            stateBase: devStateBases[i] ?? 0,
            nodeIndices,
          });
        }

        this._rawTopology = { matrixSize, numStates, nodes, devices };
        this._topology = this._parseTopology(this._rawTopology);
      },
      koffi.pointer(topoCbType),
    );

    registerFn(callback);
  }

  private _registerIterationCallback(koffi: any, uid: string): void {
    // NiIterationData struct — extended with simTimeStart + phase fields
    const NiIterationData = koffi.struct(`NiIterationData${uid}`, {
      iteration:        "int",
      matrixSize:       "int",
      // SMPmatSize+1 — actual rhs/rhsOld/preSolveRhs slot count. Can be smaller
      // than matrixSize when devices stamp into ground row/col via TrashCan;
      // decoding matrixSize doubles from rhs/rhsOld then reads OOB heap.
      rhsBufSize:       "int",
      rhs:              koffi.pointer("double"),
      rhsOld:           koffi.pointer("double"),
      preSolveRhs:      koffi.pointer("double"),
      state0:           koffi.pointer("double"),
      state1:           koffi.pointer("double"),
      state2:           koffi.pointer("double"),
      numStates:        "int",
      noncon:           "int",
      converged:        "int",
      simTime:          "double",
      dt:               "double",
      cktMode:          "int",
      ag0:              "double",
      ag1:              "double",
      integrateMethod:  "int",
      order:            "int",
      matrixColPtr:     koffi.pointer("int"),
      matrixRowIdx:     koffi.pointer("int"),
      matrixVals:       koffi.pointer("double"),
      matrixNnz:        "int",
      devConvFailed:    koffi.pointer("int"),
      devConvCount:     "int",
      numLimitEvents:   "int",
      limitDevIdx:      koffi.pointer("int"),
      limitJunctionId:  koffi.pointer("int"),
      limitVBefore:     koffi.pointer("double"),
      limitVAfter:      koffi.pointer("double"),
      limitWasLimited:  koffi.pointer("int"),
      // New fields (spec §3.5, §8.1, §8.2)
      simTimeStart:     "double",
      phaseGmin:        "double",
      phaseSrcFact:     "double",
      phaseFlags:       "int",
    });

    const callbackType = koffi.proto(
      `void ni_instrument_cb_v2${uid}(_Inout_ NiIterationData${uid}*)`,
    );
    const registerFn = this._lib.func(`void ni_instrument_register(ni_instrument_cb_v2${uid}*)`);

    const callback = koffi.register(
      (dataPtr: any) => {
        const d = koffi.decode(dataPtr, NiIterationData);

        const { iteration, matrixSize, rhsBufSize, numStates, noncon, simTime, simTimeStart,
                dt, cktMode, ag0, ag1, integrateMethod, order,
                matrixNnz, devConvCount, numLimitEvents,
                phaseFlags, phaseGmin, phaseSrcFact } = d;

        // rhs/rhsOld/preSolveRhs are sized SMPmatSize+1 = rhsBufSize on the C
        // side (nireinit.c:31). matrixSize = CKTmaxEqNum+1 may exceed that
        // when devices stamp into ground row/col via TrashCan — decoding
        // matrixSize doubles then reads OOB and returns NaN-shaped garbage.
        // Math.min is defensive; rhsBufSize alone should already be ≤ matrixSize.
        const rhsLen = Math.min(matrixSize, rhsBufSize);

        const rhs = d.rhs
          ? Float64Array.from(koffi.decode(d.rhs, "double", rhsLen))
          : new Float64Array(rhsLen);
        const rhsOld = d.rhsOld
          ? Float64Array.from(koffi.decode(d.rhsOld, "double", rhsLen))
          : new Float64Array(rhsLen);
        const preSolveRhs = d.preSolveRhs
          ? Float64Array.from(koffi.decode(d.preSolveRhs, "double", rhsLen))
          : new Float64Array(rhsLen);
        const state0 = d.state0
          ? Float64Array.from(koffi.decode(d.state0, "double", numStates))
          : new Float64Array(numStates);
        const state1 = d.state1
          ? Float64Array.from(koffi.decode(d.state1, "double", numStates))
          : new Float64Array(numStates);
        const state2 = d.state2
          ? Float64Array.from(koffi.decode(d.state2, "double", numStates))
          : new Float64Array(numStates);

        const matrixColPtrArr: number[] | null = matrixNnz > 0 && d.matrixColPtr
          ? Array.from(koffi.decode(d.matrixColPtr, "int", matrixSize + 1)) as number[] : null;
        const matrixRowIdxArr: number[] | null = matrixNnz > 0 && d.matrixRowIdx
          ? Array.from(koffi.decode(d.matrixRowIdx, "int", matrixNnz)) as number[] : null;
        const matrixValsArr: number[] | null = matrixNnz > 0 && d.matrixVals
          ? Array.from(koffi.decode(d.matrixVals, "double", matrixNnz)) as number[] : null;

        const matrix: MatrixEntry[] = [];
        if (matrixColPtrArr && matrixRowIdxArr && matrixValsArr) {
          for (let col = 0; col < matrixSize; col++) {
            for (let p = matrixColPtrArr[col]; p < matrixColPtrArr[col + 1]; p++) {
              matrix.push({ row: matrixRowIdxArr[p], col, value: matrixValsArr[p] });
            }
          }
        }

        const devConvFailedArr = devConvCount > 0 && d.devConvFailed
          ? Array.from(koffi.decode(d.devConvFailed, "int", devConvCount)) : [];
        const ngspiceConvergenceFailedDevices: string[] = (devConvFailedArr as number[]).map((devIdx: number) => {
          const dev = this._topology?.devices[devIdx];
          return dev ? dev.name : `device_${devIdx}`;
        });

        const rawLimitingEvents: RawNgspiceIterationEx["limitingEvents"] = [];
        if (numLimitEvents > 0 && d.limitDevIdx && d.limitJunctionId && d.limitVBefore && d.limitVAfter && d.limitWasLimited) {
          const devIdxArr = Array.from(koffi.decode(d.limitDevIdx, "int", numLimitEvents)) as number[];
          const junctionIdArr = Array.from(koffi.decode(d.limitJunctionId, "int", numLimitEvents)) as number[];
          const vBeforeArr = Array.from(koffi.decode(d.limitVBefore, "double", numLimitEvents)) as number[];
          const vAfterArr = Array.from(koffi.decode(d.limitVAfter, "double", numLimitEvents)) as number[];
          const wasLimitedArr = Array.from(koffi.decode(d.limitWasLimited, "int", numLimitEvents)) as number[];

          for (let i = 0; i < numLimitEvents; i++) {
            const devIdx = devIdxArr[i];
            const dev = this._topology?.devices[devIdx];
            rawLimitingEvents.push({
              deviceName: dev ? dev.name : `device_${devIdx}`,
              junction: JUNCTION_ID_MAP[junctionIdArr[i]] ?? `J${junctionIdArr[i]}`,
              vBefore: vBeforeArr[i],
              vAfter: vAfterArr[i],
              wasLimited: wasLimitedArr[i] !== 0,
            });
          }
        }

        this._iterations.push({
          iteration, matrixSize, rhsBufSize, rhs, rhsOld, preSolveRhs,
          state0, state1, state2,
          numStates, noncon, converged: d.converged !== 0,
          simTime, simTimeStart, dt, cktMode,
          ag0, ag1, integrateMethod, order,
          phaseFlags, phaseGmin, phaseSrcFact,
          matrix,
          ngspiceConvergenceFailedDevices,
          limitingEvents: rawLimitingEvents,
        });
      },
      koffi.pointer(callbackType),
    );

    registerFn(callback);
  }

  /**
   * Register the outer-loop callback (ni_outer_cb) fired from dctran.c
   * after each timestep-loop iteration (accept/lteReject/nrFail/finalFailure).
   */
  private _registerOuterCallback(koffi: any, uid: string): void {
    // NiOuterData struct matching C typedef in niiter.c
    const NiOuterData = koffi.struct(`NiOuterData${uid}`, {
      simTimeStart: "double",
      delta:        "double",
      lteRejected:  "int",
      nrFailed:     "int",
      accepted:     "int",
      finalFailure: "int",
      nextDelta:    "double",
    });

    const outerCbType = koffi.proto(
      `void ni_outer_cb_t${uid}(_Inout_ NiOuterData${uid}*)`,
    );
    const registerFn = this._lib.func(`void ni_outer_register(ni_outer_cb_t${uid}*)`);

    const callback = koffi.register(
      (dataPtr: any) => {
        const d = koffi.decode(dataPtr, NiOuterData);
        this._outerEvents.push({
          simTimeStart: d.simTimeStart,
          delta: d.delta,
          lteRejected: d.lteRejected,
          nrFailed: d.nrFailed,
          accepted: d.accepted,
          finalFailure: d.finalFailure,
          nextDelta: d.nextDelta,
        });
      },
      koffi.pointer(outerCbType),
    );

    registerFn(callback);
  }

  private _parseTopology(raw: RawNgspiceTopology): NgspiceTopology {
    const nodeNames = new Map<string, number>();
    for (const n of raw.nodes) {
      // Filter out ngspice's ground slot ("0" => 0). Our engine eliminates
      // ground from the MNA system; keeping it in nodeNames would cause
      // ngspice's ground-column stamps to surface as spurious engineSpecific
      // rows in the matrix comparison.
      if (n.name && n.name !== "0") nodeNames.set(n.name, n.number);
    }
    const devices: NgspiceDeviceInfo[] = raw.devices.map(d => ({
      name: d.name, typeName: d.typeName, stateBase: d.stateBase, nodeIndices: d.nodeIndices,
    }));
    return { matrixSize: raw.matrixSize, numStates: raw.numStates, nodeNames, devices };
  }

  loadNetlist(netlist: string): void {
    for (const line of netlist.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) this._cmd(`circbyline ${trimmed}`);
    }
  }

  runDcOp(): void {
    this._iterations = [];
    this._outerEvents = [];
    this._cmd("op");
  }

  /**
   * Issue ngspice `.tran TSTEP TSTOP <TSTART <TMAX>>`.
   *
   * Parameter naming matches the .tran spec exactly so callers can't conflate
   * TSTEP (the printing/output interval, → CKTstep) with TMAX (the integration
   * ceiling, → CKTmaxStep). The two govern very different things:
   *   - CKTstep drives `delta = MIN(CKTfinalTime/100, CKTstep)/10` (dctran.c:118).
   *   - CKTmaxStep drives the per-step `MIN(CKTdelta, CKTmaxStep)` clamp at
   *     dctran.c:540 and (when TMAX is omitted) auto-derives via
   *     `CKTmaxStep = MIN(CKTstep, (TSTOP-TSTART)/50)` (traninit.c:23-32).
   * Conflating them silently desyncs `delta` from any digiTS engine config that
   * separately picks `outputStep = tStop/100` and `maxTimeStep = maxStep`.
   */
  runTran(tStop: string, tStep: string, tMax?: string): void {
    this._iterations = [];
    this._outerEvents = [];
    if (tMax !== undefined) {
      // 4-arg form requires TSTART positionally; harness path always uses 0.
      this._cmd(`tran ${tStep} ${tStop} 0 ${tMax}`);
    } else {
      this._cmd(`tran ${tStep} ${tStop}`);
    }
  }

  getTopology(): NgspiceTopology | null { return this._topology; }
  getRawTopology(): RawNgspiceTopology | null { return this._rawTopology; }

  private _unpackElementStates(
    state0: Float64Array,
    state1: Float64Array,
    state2: Float64Array,
  ): ElementStateSnapshot[] {
    if (!this._topology || this._topology.devices.length === 0) return [];
    const snapshots: ElementStateSnapshot[] = [];

    for (const dev of this._topology.devices) {
      const deviceType = this._canonicalizeDeviceType(dev.typeName);
      const mapping = deviceType ? DEVICE_MAPPINGS[deviceType] : undefined;
      if (!mapping) continue;

      const slots: Record<string, number> = {};
      const state1Slots: Record<string, number> = {};
      const state2Slots: Record<string, number> = {};

      for (const [offsetStr, slotName] of Object.entries(mapping.ngspiceToSlot)) {
        const offset = Number(offsetStr);
        const absOffset = dev.stateBase + offset;
        if (absOffset < state0.length) slots[slotName] = state0[absOffset];
        if (absOffset < state1.length) state1Slots[slotName] = state1[absOffset];
        if (absOffset < state2.length) state2Slots[slotName] = state2[absOffset];
      }

      if (Object.keys(slots).length > 0) {
        snapshots.push({
          elementIndex: -1,
          label: dev.name.toUpperCase(),
          slots, state1Slots, state2Slots,
        });
      }
    }
    return snapshots;
  }

  private _canonicalizeDeviceType(ngspiceType: string): string | null {
    const lower = ngspiceType.toLowerCase();
    const map: Record<string, string> = {
      "capacitor": "capacitor", "inductor": "inductor",
      "diode": "diode", "bjt": "bjt",
      "mos1": "mosfet", "mosfet": "mosfet", "jfet": "jfet",
    };
    return map[lower] ?? null;
  }

  /**
   * Convert accumulated iteration data into a CaptureSession.
   *
   * Grouping algorithm (spec §6.1):
   *   - Keyed on simTimeStart from each raw iteration.
   *   - New step when simTimeStart changes.
   *   - New attempt when: iteration resets OR phase changes.
   *   - Outer callback events (ni_outer_cb) set attempt outcomes deterministically.
   */
  getCaptureSession(): CaptureSession {
    const steps: StepSnapshot[] = [];

    if (this._iterations.length === 0) {
      return { source: "ngspice", topology: this._buildTopologySnapshot(), steps };
    }

    // Build a map from simTimeStart → outer event for quick lookup
    const outerByTime = new Map<number, RawNgspiceOuterEvent>();
    for (const ev of this._outerEvents) {
      outerByTime.set(ev.simTimeStart, ev);
    }

    let currentStep: PendingStep | null = null;
    let prevIteration = -1;
    let prevPhase: NRPhase | null = null;

    const flushAttempt = (step: PendingStep, outcome: NRAttemptOutcome): void => {
      const pa = step.pendingAttempt;
      if (!pa || pa.iterations.length === 0) {
        step.pendingAttempt = null;
        return;
      }
      const lastIter = pa.iterations[pa.iterations.length - 1]!;
      const attemptIndexInStep = step.attempts.length;
      const role = cktModeToRole(pa.firstRaw.cktMode, pa.firstRaw.phaseFlags, attemptIndexInStep);
      const attempt: NRAttempt = {
        dt: pa.firstRaw.dt,
        iterations: pa.iterations,
        converged: lastIter.globalConverged,
        iterationCount: pa.iterations.length,
        phase: pa.phase,
        outcome,
        ...(role !== undefined ? { role } : {}),
        ...(pa.phase === "dcopGminDynamic" || pa.phase === "dcopGminSpice3"
          ? { phaseParameter: pa.firstRaw.phaseGmin }
          : pa.phase === "dcopSrcSweep"
          ? { phaseParameter: pa.firstRaw.phaseSrcFact }
          : {}),
      };
      step.attempts.push(attempt);
      step.pendingAttempt = null;
    };

    const flushStep = (step: PendingStep): void => {
      if (step.attempts.length === 0) return;

      // Find accepted attempt index: last attempt with converged === true
      // and outcome "accepted" or "dcopSubSolveConverged"
      let acceptedIdx = -1;
      for (let i = step.attempts.length - 1; i >= 0; i--) {
        const a = step.attempts[i]!;
        if (a.outcome === "accepted" || a.outcome === "dcopSubSolveConverged") {
          acceptedIdx = i;
          break;
        }
      }
      if (acceptedIdx < 0) acceptedIdx = step.attempts.length - 1;

      const acceptedAttempt = step.attempts[acceptedIdx]!;
      const lastRaw = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1];
      const ngspiceCoeff = _ngspiceIntegCoeff(
        // Find the raw iteration for the last accepted iteration
        this._iterations.find(r =>
          r.simTimeStart === step.stepStartTime &&
          r.iteration === (lastRaw as any)?._rawIteration
        ) ?? this._iterations.find(r => r.simTimeStart === step.stepStartTime),
      );
      const integCoeff: IntegrationCoefficients = {
        ours: { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 },
        ngspice: ngspiceCoeff,
      };

      // Derive analysisPhase from the numeric cktMode of the first captured
      // iteration. We look it up via simTimeStart + iteration number rather
      // than re-parsing the diagnostic string label produced by bitsToName().
      const firstRawForPhase = this._iterations.find(
        r => r.simTimeStart === step.stepStartTime,
      );
      const analysisPhase = firstRawForPhase
        ? cktModeToAnalysisPhase(firstRawForPhase.cktMode)
        : "dcop";

      // stepEndTime: for accepted transient step it is simTime (post-advance);
      // for DCOP it equals stepStartTime.
      const stepEndTime = acceptedAttempt.dt > 0
        ? step.stepStartTime + acceptedAttempt.dt
        : step.stepStartTime;

      const totalIterationCount = step.attempts.reduce((sum, att) => sum + att.iterationCount, 0);

      // Retroactively assign finalVerify: a dcopInitFloat that follows a dcopDirect
      // in the same step is a post-convergence verification pass, not a cold start.
      let sawDcopDirect = false;
      for (const att of step.attempts) {
        if (att.phase === "dcopDirect") sawDcopDirect = true;
        else if (att.phase === "dcopInitFloat" && sawDcopDirect && att.role !== "coldStart") {
          att.role = "finalVerify";
        }
      }

      // Assign tran-phase roles: the accepted tran attempt is the real solve (tranSolve);
      // any tran attempt that failed with nrFailedRetry is a predictor pass (predictorPass).
      const isTranPhase = (p: string) => p === "tranInit" || p === "tranPredictor" || p === "tranNR";
      for (const att of step.attempts) {
        if (!isTranPhase(att.phase)) continue;
        if (att.outcome === "accepted") {
          att.role = "tranSolve";
        } else if (att.outcome === "nrFailedRetry") {
          att.role = "predictorPass";
        }
      }

      // Populate lteDt on the last iteration of the accepted attempt from
      // RawNgspiceOuterEvent.nextDelta (the LTE-proposed next timestep).
      const outerEv = outerByTime.get(step.stepStartTime);
      if (
        outerEv !== undefined &&
        typeof outerEv.nextDelta === "number" &&
        isFinite(outerEv.nextDelta) &&
        outerEv.nextDelta > 0 &&
        acceptedAttempt.iterations.length > 0
      ) {
        const lastIter = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1]!;
        lastIter.lteDt = outerEv.nextDelta;
      }

      steps.push({
        stepStartTime: step.stepStartTime,
        stepEndTime,
        attempts: step.attempts,
        acceptedAttemptIndex: acceptedIdx,
        accepted: acceptedAttempt.converged,
        dt: acceptedAttempt.dt,
        iterations: acceptedAttempt.iterations,
        converged: acceptedAttempt.converged,
        iterationCount: acceptedAttempt.iterationCount,
        totalIterationCount,
        integrationCoefficients: integCoeff,
        analysisPhase,
      });
    };

    for (const raw of this._iterations) {
      const attemptPhase = cktModeToPhase(raw.cktMode, raw.phaseFlags);
      const stepStartTimeOfRaw = raw.simTimeStart;

      // 3/4: Open or switch step
      if (currentStep === null) {
        currentStep = { stepStartTime: stepStartTimeOfRaw, attempts: [], pendingAttempt: null };
      } else if (Math.abs(stepStartTimeOfRaw - currentStep.stepStartTime) > 1e-20) {
        // Step boundary: flush current attempt with appropriate outcome
        if (currentStep.pendingAttempt) {
          const outerEv = outerByTime.get(currentStep.stepStartTime);
          let outcome: NRAttemptOutcome = "accepted";
          if (outerEv) {
            if (outerEv.lteRejected) outcome = "lteRejectedRetry";
            else if (outerEv.nrFailed) outcome = "nrFailedRetry";
            else if (outerEv.finalFailure) outcome = "finalFailure";
            else if (outerEv.accepted) outcome = "accepted";
          }
          flushAttempt(currentStep, outcome);
        }
        flushStep(currentStep);
        currentStep = { stepStartTime: stepStartTimeOfRaw, attempts: [], pendingAttempt: null };
        prevIteration = -1;
        prevPhase = null;
      }

      // 5: New attempt if: no current attempt, OR iteration reset, OR phase changed.
      // Iteration reset: counter goes down (raw.iteration <= prevIteration when prevIteration >= 0),
      // which covers both typical NR retry (e.g. 2→0) and gmin stepping (0→0 between sub-solves).
      const isIterReset = raw.iteration <= prevIteration && prevIteration >= 0
        && currentStep.pendingAttempt !== null
        && currentStep.pendingAttempt.iterations.length > 0;
      const isPhaseChange = prevPhase !== null && attemptPhase !== prevPhase;

      if (currentStep.pendingAttempt === null || isIterReset || isPhaseChange) {
        if (currentStep.pendingAttempt && (isIterReset || isPhaseChange)) {
          let outcome: NRAttemptOutcome;
          // Transient INITTRAN→FLOAT and INITPRED→FLOAT happen inside one
          // ngspice NIiter call (niiter.c:1072-1076 INITF dispatcher) — the
          // mid-call mode flip is not a NR failure or a sub-solve boundary,
          // it is a phase handoff. Emit "tranPhaseHandoff" so the outcome
          // matches our engine's transient mode-ladder, instead of falsely
          // labeling it "nrFailedRetry" / "dcopSubSolveConverged".
          const isTranHandoff = isPhaseChange &&
            (currentStep.pendingAttempt.phase === "tranInit" ||
             currentStep.pendingAttempt.phase === "tranPredictor") &&
            attemptPhase === "tranNR";
          if (isTranHandoff) {
            outcome = "tranPhaseHandoff";
          } else if (currentStep.pendingAttempt.iterations.length > 0) {
            const lastIter = currentStep.pendingAttempt.iterations[currentStep.pendingAttempt.iterations.length - 1]!;
            if (lastIter.globalConverged) {
              outcome = "dcopSubSolveConverged";
            } else {
              outcome = "nrFailedRetry";
            }
          } else {
            outcome = "nrFailedRetry";
          }
          flushAttempt(currentStep, outcome);
        }
        currentStep.pendingAttempt = {
          phase: attemptPhase,
          phaseFlags: raw.phaseFlags,
          iterations: [],
          firstRaw: raw,
        };
      }

      // 6: Build iteration snapshot and push
      const elementStates = this._unpackElementStates(raw.state0, raw.state1, raw.state2);
      const limitingEvents: LimitingEvent[] = raw.limitingEvents.map(ev => ({
        elementIndex: -1,
        label: ev.deviceName.toUpperCase(),
        junction: ev.junction,
        limitType: "pnjlim" as const,
        vBefore: ev.vBefore,
        vAfter: ev.vAfter,
        wasLimited: ev.wasLimited,
      }));

      // ngspice integrateMethod FFI code (cktdefs.h:107-108) → harness IntegrationMethod.
      // TRAPEZOIDAL=1, GEAR=2. Code 2 → "gear"; all other values → "trapezoidal".
      const ngIntegrateMethod: IntegrationMethod =
        raw.integrateMethod === 2 ? "gear"
        : "trapezoidal";
      // Only ag0/ag1 are marshalled across the FFI (see §8.1 of ngspice-bridge
      // struct); pad remaining slots with 0 to match the length-7 harness shape.
      const agBuf = new Float64Array(7);
      agBuf[0] = raw.ag0 ?? 0;
      agBuf[1] = raw.ag1 ?? 0;

      const iterSnap: IterationSnapshot = {
        iteration: raw.iteration,
        matrixSize: raw.matrixSize,
        rhsBufSize: raw.rhsBufSize,
        voltages: raw.rhs.slice(),
        prevVoltages: raw.rhsOld.slice(),
        preSolveRhs: raw.preSolveRhs.length > 0 ? raw.preSolveRhs.slice() : new Float64Array(0),
        matrix: raw.matrix ?? [],
        elementStates,
        noncon: raw.noncon,
        diagGmin: raw.phaseGmin,
        srcFact: raw.phaseSrcFact,
        initMode: bitsToName(raw.cktMode),
        order: raw.order,
        delta: raw.dt,
        ag: agBuf,
        method: ngIntegrateMethod,
        globalConverged: raw.converged,
        elemConverged: raw.converged,
        limitingEvents,
        convergenceFailedElements: [],
        ngspiceConvergenceFailedDevices: raw.ngspiceConvergenceFailedDevices ?? [],
      };
      // Stash raw fields needed for later (not on the public type)
      (iterSnap as any)._rawIteration = raw.iteration;

      currentStep.pendingAttempt!.iterations.push(iterSnap);

      // 7: Update trackers
      prevIteration = raw.iteration;
      prevPhase = attemptPhase;
    }

    // Flush last step
    if (currentStep !== null) {
      if (currentStep.pendingAttempt) {
        const outerEv = outerByTime.get(currentStep.stepStartTime);
        let outcome: NRAttemptOutcome = "accepted";
        if (outerEv) {
          if (outerEv.finalFailure) outcome = "finalFailure";
          else if (outerEv.lteRejected) outcome = "lteRejectedRetry";
          else if (outerEv.nrFailed) outcome = "nrFailedRetry";
          else if (outerEv.accepted) outcome = "accepted";
        } else if (currentStep.pendingAttempt.iterations.length > 0) {
          const lastIter = currentStep.pendingAttempt.iterations[currentStep.pendingAttempt.iterations.length - 1]!;
          outcome = lastIter.globalConverged ? "accepted" : "finalFailure";
        }
        flushAttempt(currentStep, outcome);
      }
      flushStep(currentStep);
    }

    return {
      source: "ngspice",
      topology: this._buildTopologySnapshot(),
      steps,
    };
  }

  private _buildTopologySnapshot(): TopologySnapshot {
    if (!this._topology) {
      return {
        matrixSize: this._iterations[0]?.matrixSize ?? 0,
        nodeCount: 0, branchCount: 0, elementCount: 0,
        elements: [],
        nodeLabels: new Map(), matrixRowLabels: new Map(), matrixColLabels: new Map(),
      };
    }

    const nodeLabels = new Map<number, string>();
    this._topology.nodeNames.forEach((nodeNum, nodeName) => {
      nodeLabels.set(nodeNum, nodeName);
    });

    const matrixRowLabels = new Map<number, string>();
    const matrixColLabels = new Map<number, string>();
    nodeLabels.forEach((label, nodeId) => {
      const row = nodeId - 1;
      if (row >= 0) { matrixRowLabels.set(row, label); matrixColLabels.set(row, label); }
    });

    const elements = this._topology.devices.map((d, i) => ({
      index: i, label: d.name, type: d.typeName,
      isNonlinear: false, isReactive: false,
      pinNodeIds: d.nodeIndices as readonly number[],
    }));

    return {
      matrixSize: this._topology.matrixSize,
      nodeCount: this._topology.nodeNames.size,
      branchCount: 0,
      elementCount: this._topology.devices.length,
      elements, nodeLabels, matrixRowLabels, matrixColLabels,
    };
  }

  dispose(): void {
    if (this._lib) {
      this._lib.func("void ni_outer_register(void*)")(null);
      this._lib.func("void ni_instrument_register(void*)")(null);
      this._lib.func("void ni_topology_register(void*)")(null);
      this._lib = null;
    }
  }
}
