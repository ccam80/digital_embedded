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
  IterationSnapshot,
  ElementStateSnapshot,
  NgspiceTopology,
  NgspiceDeviceInfo,
  RawNgspiceIterationEx,
  RawNgspiceTopology,
  IntegrationCoefficients,
  MatrixEntry,
  LimitingEvent,
} from "./types.js";
import { DEVICE_MAPPINGS } from "./device-mappings.js";

function cktModeToPhase(mode: number): "dcop" | "tranInit" | "tranFloat" {
  const MODEDCOP   = 0x0001;
  const MODETRANOP = 0x0002;
  const MODETRAN   = 0x0004;
  if (mode & MODEDCOP)   return "dcop";
  if (mode & MODETRANOP) return "tranInit";
  if (mode & MODETRAN)   return "tranFloat";
  return "dcop";
}

function _ngspiceIntegCoeff(raw: RawNgspiceIterationEx | undefined): IntegrationCoefficients {
  if (!raw) {
    return {
      ours: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
      ngspice: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
    };
  }
  const methodMap: Record<number, string> = { 0: "backwardEuler", 1: "trapezoidal", 2: "gear2" };
  return {
    ours: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
    ngspice: {
      ag0: raw.ag0 ?? 0,
      ag1: raw.ag1 ?? 0,
      method: methodMap[raw.integrateMethod ?? 0] ?? "backwardEuler",
      order: raw.order ?? 1,
    },
  };
}

/** Junction ID to string name mapping for limiting events. */
const JUNCTION_ID_MAP: Record<number, string> = {
  0: "AK",
  1: "BE",
  2: "BC",
  3: "GS",
  4: "DS",
  5: "GD",
  6: "BS",
  7: "BD",
  8: "CS",
};

// ---------------------------------------------------------------------------
// NgspiceBridge
// ---------------------------------------------------------------------------

/**
 * Bridge to an instrumented ngspice shared library.
 *
 * Usage:
 *   const bridge = new NgspiceBridge(process.env.NGSPICE_DLL_PATH!);
 *   await bridge.init();
 *   bridge.loadNetlist(spiceNetlist);
 *   bridge.runDcOp();           // or runTran(stopTime, maxStep)
 *   const session = bridge.getCaptureSession();
 *   bridge.dispose();
 */
export class NgspiceBridge {
  private _dllPath: string;
  private _lib: any;  // koffi library handle
  private _koffi: any = null;
  private _cmd: any = null;

  /** Raw iteration data from the extended callback. */
  private _iterations: RawNgspiceIterationEx[] = [];

  /** Topology data from the one-time callback. */
  private _rawTopology: RawNgspiceTopology | null = null;

  /** Parsed topology. */
  private _topology: NgspiceTopology | null = null;

  constructor(dllPath: string) {
    this._dllPath = dllPath;
  }

  /**
   * Initialize the FFI binding. Must be called before any other method.
   * Separated from constructor because koffi is an optional dependency.
   */
  async init(): Promise<void> {
    const koffi = await import("koffi");
    this._koffi = koffi;
    this._lib = koffi.load(this._dllPath);

    // --- ngSpice_Init: required before any other API call ---
    const uid = `_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const SendChar = koffi.proto(`int SendCharCb${uid}(char*, int, void*)`);
    const SendStat = koffi.proto(`int SendStatCb${uid}(char*, int, void*)`);
    const ControlledExit = koffi.proto(`int ControlledExitCb${uid}(int, int, int, void*)`);

    const charCb = koffi.register(
      (_msg: any, _id: number, _ud: any) => 0,
      koffi.pointer(SendChar),
    );
    const statCb = koffi.register(
      (_msg: any, _id: number, _ud: any) => 0,
      koffi.pointer(SendStat),
    );
    const exitCb = koffi.register(
      (_status: number, _unload: number, _quit: number, _ud: any) => 0,
      koffi.pointer(ControlledExit),
    );

    const initFn = this._lib.func(
      `int ngSpice_Init(SendCharCb${uid}*, SendStatCb${uid}*, ControlledExitCb${uid}*, void*, void*, void*, void*)`,
    );
    initFn(charCb, statCb, exitCb, null, null, null, null);

    // --- Register topology callback ---
    this._registerTopologyCallback(koffi, uid);

    // --- Register NR instrumentation callback ---
    this._registerIterationCallback(koffi, uid);

    // Cache the command function
    this._cmd = this._lib.func("int ngSpice_Command(str)");
  }

  /**
   * Register the one-time topology callback.
   *
   * Extended signature includes devNodeIndicesFlat and devNodeCounts (Item 4).
   * String arrays arrive as single pipe-delimited buffers (char*) because
   * koffi cannot marshal char** across FFI callbacks. We split on '|'.
   */
  private _registerTopologyCallback(koffi: any, uid: string): void {
    // Extended callback signature (Item 4):
    //   void(char*, int*, int, char*, char*, int*, int, int, int, int*, int*)
    const topoCbType = koffi.proto(
      `void ni_topo_cb${uid}(` +
      `str, _Inout_ int*, int, ` +
      `str, str, ` +
      `_Inout_ int*, int, ` +
      `int, int, ` +
      `_Inout_ int*, _Inout_ int*)`,
    );

    const registerFn = this._lib.func(
      `void ni_topology_register(ni_topo_cb${uid}*)`,
    );

    const callback = koffi.register(
      (nodeNamesJoined: string, nodeNumbersPtr: any, nodeCount: number,
       devNamesJoined: string, devTypesJoined: string,
       devStateBasesPtr: any, devCount: number,
       matrixSize: number, numStates: number,
       devNodeFlatRaw: any, devNodeCountsRaw: any) => {

        // Split pipe-delimited strings back into arrays
        const nodeNames = nodeNamesJoined ? nodeNamesJoined.split("|") : [];
        const devNames = devNamesJoined ? devNamesJoined.split("|") : [];
        const devTypes = devTypesJoined ? devTypesJoined.split("|") : [];

        const nodeNumbers: number[] = nodeNumbersPtr
          ? Array.from(koffi.decode(nodeNumbersPtr, "int", nodeCount))
          : [];
        const devStateBases: number[] = devStateBasesPtr
          ? Array.from(koffi.decode(devStateBasesPtr, "int", devCount))
          : [];

        // Item 4: Decode per-device node counts and flat node index array
        const nodeCounts: number[] | null = devNodeCountsRaw
          ? Array.from(koffi.decode(devNodeCountsRaw, "int", devCount))
          : null;

        const totalNodeIndices = nodeCounts ? nodeCounts.reduce((a, b) => a + b, 0) : 0;
        const devNodeFlat: number[] | null = devNodeFlatRaw && nodeCounts && totalNodeIndices > 0
          ? Array.from(koffi.decode(devNodeFlatRaw, "int", totalNodeIndices))
          : null;

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

  /**
   * Register the per-iteration instrumentation callback.
   *
   * The C side passes a pointer to a NiIterationData struct (Items 2, 3, 7, 8, 9, 15).
   * We define the struct layout in koffi and decode each field via the pointer.
   */
  private _registerIterationCallback(koffi: any, uid: string): void {
    // Define the NiIterationData struct layout matching the C typedef
    const NiIterationData = koffi.struct(`NiIterationData${uid}`, {
      iteration:        "int",
      matrixSize:       "int",
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
    });

    const callbackType = koffi.proto(
      `void ni_instrument_cb_v2${uid}(_Inout_ NiIterationData${uid}*)`,
    );

    const registerFn = this._lib.func(
      `void ni_instrument_register(ni_instrument_cb_v2${uid}*)`,
    );

    const callback = koffi.register(
      (dataPtr: any) => {
        const d = koffi.decode(dataPtr, NiIterationData);

        const { iteration, matrixSize, numStates, noncon, simTime, dt, cktMode,
                ag0, ag1, integrateMethod, order, matrixNnz, devConvCount, numLimitEvents } = d;

        const rhs = d.rhs
          ? Float64Array.from(koffi.decode(d.rhs, "double", matrixSize))
          : new Float64Array(matrixSize);
        const rhsOld = d.rhsOld
          ? Float64Array.from(koffi.decode(d.rhsOld, "double", matrixSize))
          : new Float64Array(matrixSize);
        const preSolveRhs = d.preSolveRhs
          ? Float64Array.from(koffi.decode(d.preSolveRhs, "double", matrixSize))
          : new Float64Array(matrixSize);
        const state0 = d.state0
          ? Float64Array.from(koffi.decode(d.state0, "double", numStates))
          : new Float64Array(numStates);

        // Item 2: state1 and state2
        const state1 = d.state1
          ? Float64Array.from(koffi.decode(d.state1, "double", numStates))
          : new Float64Array(numStates);
        const state2 = d.state2
          ? Float64Array.from(koffi.decode(d.state2, "double", numStates))
          : new Float64Array(numStates);

        // Item 3: Matrix CSC decode and convert to MatrixEntry[]
        const matrixColPtrArr = matrixNnz > 0 && d.matrixColPtr
          ? Array.from(koffi.decode(d.matrixColPtr, "int", matrixSize + 1))
          : null;
        const matrixRowIdxArr = matrixNnz > 0 && d.matrixRowIdx
          ? Array.from(koffi.decode(d.matrixRowIdx, "int", matrixNnz))
          : null;
        const matrixValsArr = matrixNnz > 0 && d.matrixVals
          ? Array.from(koffi.decode(d.matrixVals, "double", matrixNnz))
          : null;

        const matrix: MatrixEntry[] = [];
        if (matrixColPtrArr && matrixRowIdxArr && matrixValsArr) {
          for (let col = 0; col < matrixSize; col++) {
            for (let p = matrixColPtrArr[col]; p < matrixColPtrArr[col + 1]; p++) {
              matrix.push({ row: matrixRowIdxArr[p], col, value: matrixValsArr[p] });
            }
          }
        }

        // Item 8: Per-device convergence failure decode
        const devConvFailedArr = devConvCount > 0 && d.devConvFailed
          ? Array.from(koffi.decode(d.devConvFailed, "int", devConvCount))
          : [];

        const ngspiceConvergenceFailedDevices: string[] = (devConvFailedArr as number[]).map((devIdx: number) => {
          const dev = this._topology?.devices[devIdx];
          return dev ? dev.name : `device_${devIdx}`;
        });

        // Item 9: Limiting event decode
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
            const deviceName = dev ? dev.name : `device_${devIdx}`;
            const junctionId = junctionIdArr[i];
            const junction = JUNCTION_ID_MAP[junctionId] ?? `J${junctionId}`;
            rawLimitingEvents.push({
              deviceName,
              junction,
              vBefore: vBeforeArr[i],
              vAfter: vAfterArr[i],
              wasLimited: wasLimitedArr[i] !== 0,
            });
          }
        }

        this._iterations.push({
          iteration, matrixSize, rhs, rhsOld, preSolveRhs,
          state0, state1, state2,
          numStates, noncon, converged: d.converged !== 0,
          simTime, dt, cktMode,
          ag0, ag1, integrateMethod, order,
          matrix,
          ngspiceConvergenceFailedDevices: ngspiceConvergenceFailedDevices.length > 0
            ? ngspiceConvergenceFailedDevices
            : undefined,
          limitingEvents: rawLimitingEvents,
        });
      },
      koffi.pointer(callbackType),
    );

    registerFn(callback);
  }

  /**
   * Parse raw topology into structured NgspiceTopology.
   */
  private _parseTopology(raw: RawNgspiceTopology): NgspiceTopology {
    const nodeNames = new Map<string, number>();
    for (const n of raw.nodes) {
      if (n.name) nodeNames.set(n.name, n.number);
    }

    const devices: NgspiceDeviceInfo[] = raw.devices.map(d => ({
      name: d.name,
      typeName: d.typeName,
      stateBase: d.stateBase,
      nodeIndices: d.nodeIndices,
    }));

    return {
      matrixSize: raw.matrixSize,
      numStates: raw.numStates,
      nodeNames,
      devices,
    };
  }

  /**
   * Load a SPICE netlist into ngspice.
   */
  loadNetlist(netlist: string): void {
    for (const line of netlist.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        this._cmd(`circbyline ${trimmed}`);
      }
    }
  }

  /**
   * Run DC operating point analysis.
   */
  runDcOp(): void {
    this._iterations = [];
    this._cmd("op");
  }

  /**
   * Run transient analysis.
   * @param stopTime - e.g. "500m" or "1u"
   * @param maxStep - e.g. "1u" or "10n"
   */
  runTran(stopTime: string, maxStep: string): void {
    this._iterations = [];
    this._cmd(`tran ${maxStep} ${stopTime}`);
  }

  /**
   * Get the parsed ngspice topology (available after first analysis run).
   */
  getTopology(): NgspiceTopology | null {
    return this._topology;
  }

  /**
   * Get the raw topology callback data.
   */
  getRawTopology(): RawNgspiceTopology | null {
    return this._rawTopology;
  }

  /**
   * Unpack the flat CKTstate arrays into per-device ElementStateSnapshot[]
   * using the topology callback data and device mappings.
   *
   * Reads state0, state1, and state2 to populate all three slot maps (Item 2).
   */
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
        if (absOffset < state0.length) {
          slots[slotName] = state0[absOffset];
        }
        if (absOffset < state1.length) {
          state1Slots[slotName] = state1[absOffset];
        }
        if (absOffset < state2.length) {
          state2Slots[slotName] = state2[absOffset];
        }
      }

      if (Object.keys(slots).length > 0) {
        snapshots.push({
          elementIndex: -1,
          label: dev.name.toUpperCase(),
          slots,
          state1Slots,
          state2Slots,
        });
      }
    }

    return snapshots;
  }

  /**
   * Map ngspice device type names to our DeviceMapping keys.
   */
  private _canonicalizeDeviceType(ngspiceType: string): string | null {
    const lower = ngspiceType.toLowerCase();
    // ngspice type names from DEVpublic.name
    const map: Record<string, string> = {
      "capacitor": "capacitor",
      "inductor": "inductor",
      "diode": "diode",
      "bjt": "bjt",
      "mos1": "mosfet",
      "mosfet": "mosfet",
      "jfet": "jfet",
      // Tunnel diode and varactor are modelled as standard diodes in ngspice
    };
    return map[lower] ?? null;
  }

  /**
   * Convert accumulated iteration data into a CaptureSession.
   *
   * Groups iterations into steps by detecting time changes and
   * iteration counter resets. Populates simTime, dt, and device states.
   */
  getCaptureSession(): CaptureSession {
    const steps: StepSnapshot[] = [];
    let currentStepIterations: IterationSnapshot[] = [];
    let currentTime = -1;
    let lastIteration = -1;

    for (const raw of this._iterations) {
      // Detect new step: iteration counter reset or time change
      const isNewStep = (raw.iteration <= lastIteration && currentStepIterations.length > 0)
        || (raw.simTime !== currentTime && currentTime >= 0 && currentStepIterations.length > 0);

      if (isNewStep) {
        const lastIter = currentStepIterations[currentStepIterations.length - 1];
        const lastRaw = (currentStepIterations[currentStepIterations.length - 1] as any)?._sourceRaw as RawNgspiceIterationEx | undefined;
        steps.push({
          simTime: currentTime >= 0 ? currentTime : 0,
          dt: this._iterations.length > 0
            ? (currentStepIterations[0] as any)?._rawDt ?? 0
            : 0,
          iterations: currentStepIterations,
          converged: lastIter?.globalConverged ?? false,
          iterationCount: currentStepIterations.length,
          integrationCoefficients: _ngspiceIntegCoeff(lastRaw),
          analysisPhase: cktModeToPhase(lastRaw.cktMode),
        });
        currentStepIterations = [];
      }

      const elementStates = this._unpackElementStates(raw.state0, raw.state1, raw.state2);

      // Map ngspice raw limiting events to LimitingEvent[] for the iteration snapshot
      const limitingEvents: LimitingEvent[] = raw.limitingEvents.map(ev => ({
        elementIndex: -1,
        label: ev.deviceName.toUpperCase(),
        junction: ev.junction,
        limitType: "pnjlim" as const,
        vBefore: ev.vBefore,
        vAfter: ev.vAfter,
        wasLimited: ev.wasLimited,
      }));

      const iterSnap: IterationSnapshot = {
        iteration: raw.iteration,
        voltages: raw.rhs.slice(),
        prevVoltages: raw.rhsOld.slice(),
        preSolveRhs: raw.preSolveRhs.length > 0 ? raw.preSolveRhs.slice() : new Float64Array(0),
        matrix: raw.matrix ?? [],
        elementStates,
        noncon: raw.noncon,
        globalConverged: raw.converged,
        elemConverged: raw.converged,
        limitingEvents,
        convergenceFailedElements: [],
        ngspiceConvergenceFailedDevices: raw.ngspiceConvergenceFailedDevices,
      };

      // Stash dt and source raw for step finalization
      (iterSnap as any)._rawDt = raw.dt;
      (iterSnap as any)._sourceRaw = raw;

      currentStepIterations.push(iterSnap);
      currentTime = raw.simTime;
      lastIteration = raw.iteration;
    }

    // Flush last step
    if (currentStepIterations.length > 0) {
      const lastIter = currentStepIterations[currentStepIterations.length - 1];
      const lastRaw = this._iterations[this._iterations.length - 1];
      steps.push({
        simTime: currentTime >= 0 ? currentTime : 0,
        dt: (currentStepIterations[0] as any)?._rawDt ?? 0,
        iterations: currentStepIterations,
        converged: lastIter?.globalConverged ?? false,
        iterationCount: currentStepIterations.length,
        integrationCoefficients: _ngspiceIntegCoeff(lastRaw),
        analysisPhase: cktModeToPhase(lastRaw?.cktMode ?? 0),
      });
    }

    // Build topology snapshot
    const topoSnap = this._buildTopologySnapshot();

    return {
      source: "ngspice",
      topology: topoSnap,
      steps,
    };
  }

  /**
   * Build a TopologySnapshot from the ngspice topology data.
   */
  private _buildTopologySnapshot(): TopologySnapshot {
    if (!this._topology) {
      return {
        matrixSize: this._iterations[0]?.matrixSize ?? 0,
        nodeCount: 0,
        branchCount: 0,
        elementCount: 0,
        elements: [],
        nodeLabels: new Map(),
        matrixRowLabels: new Map(),
        matrixColLabels: new Map(),
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
      if (row >= 0) {
        matrixRowLabels.set(row, label);
        matrixColLabels.set(row, label);
      }
    });

    const elements = this._topology.devices.map((d, i) => ({
      index: i,
      label: d.name,
      type: d.typeName,
      isNonlinear: false,
      isReactive: false,
      pinNodeIds: d.nodeIndices as readonly number[],
    }));

    return {
      matrixSize: this._topology.matrixSize,
      nodeCount: this._topology.nodeNames.size,
      branchCount: 0,
      elementCount: this._topology.devices.length,
      elements,
      nodeLabels,
      matrixRowLabels,
      matrixColLabels,
    };
  }

  /**
   * Clean up FFI resources.
   */
  dispose(): void {
    if (this._lib) {
      this._lib.func("void ni_instrument_register(void*)")(null);
      this._lib.func("void ni_topology_register(void*)")(null);
      this._lib = null;
    }
  }
}
