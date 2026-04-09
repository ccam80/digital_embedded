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
   * String arrays arrive as single null-delimited buffers (char*) because
   * koffi cannot marshal char** across FFI callbacks. We split on '\0'.
   */
  private _registerTopologyCallback(koffi: any, uid: string): void {
    // Callback signature matches the C typedef:
    //   void(char*, int*, int, char*, char*, int*, int, int, int)
    const topoCbType = koffi.proto(
      `void ni_topo_cb${uid}(` +
      `str, _Inout_ int*, int, ` +
      `str, str, ` +
      `_Inout_ int*, int, ` +
      `int, int)`,
    );

    const registerFn = this._lib.func(
      `void ni_topology_register(ni_topo_cb${uid}*)`,
    );

    const callback = koffi.register(
      (nodeNamesJoined: string, nodeNumbersPtr: any, nodeCount: number,
       devNamesJoined: string, devTypesJoined: string,
       devStateBasesPtr: any, devCount: number,
       matrixSize: number, numStates: number) => {

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

        const nodes: RawNgspiceTopology["nodes"] = [];
        for (let i = 0; i < nodeCount; i++) {
          nodes.push({ name: nodeNames[i] ?? "", number: nodeNumbers[i] ?? i });
        }

        const devices: RawNgspiceTopology["devices"] = [];
        for (let i = 0; i < devCount; i++) {
          devices.push({
            name: devNames[i] ?? "",
            typeName: devTypes[i] ?? "",
            stateBase: devStateBases[i] ?? 0,
            nodeIndices: [],
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
   * Register the per-iteration instrumentation callback (extended format).
   */
  private _registerIterationCallback(koffi: any, uid: string): void {
    const callbackType = koffi.proto(
      `void ni_instrument_cb_ex${uid}(` +
      `int, int, ` +
      `_Inout_ double*, _Inout_ double*, _Inout_ double*, ` +
      `_Inout_ double*, int, int, int, ` +
      `double, double, int)`,
    );

    const registerFn = this._lib.func(
      `void ni_instrument_register(ni_instrument_cb_ex${uid}*)`,
    );

    const callback = koffi.register(
      (iteration: number, matrixSize: number,
       rhsPtr: any, rhsOldPtr: any, preSolveRhsPtr: any,
       state0Ptr: any, numStates: number, noncon: number, converged: number,
       simTime: number, dt: number, cktMode: number) => {

        const rhs = rhsPtr
          ? Float64Array.from(koffi.decode(rhsPtr, "double", matrixSize))
          : new Float64Array(matrixSize);
        const rhsOld = rhsOldPtr
          ? Float64Array.from(koffi.decode(rhsOldPtr, "double", matrixSize))
          : new Float64Array(matrixSize);
        const preSolveRhs = preSolveRhsPtr
          ? Float64Array.from(koffi.decode(preSolveRhsPtr, "double", matrixSize))
          : new Float64Array(matrixSize);
        const state0 = state0Ptr
          ? Float64Array.from(koffi.decode(state0Ptr, "double", numStates))
          : new Float64Array(numStates);

        this._iterations.push({
          iteration, matrixSize, rhs, rhsOld, preSolveRhs, state0,
          numStates, noncon, converged: converged !== 0,
          simTime, dt, cktMode,
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
   * Unpack the flat CKTstate0 array into per-device ElementStateSnapshot[]
   * using the topology callback data and device mappings.
   */
  private _unpackElementStates(state0: Float64Array): ElementStateSnapshot[] {
    if (!this._topology || this._topology.devices.length === 0) return [];

    const snapshots: ElementStateSnapshot[] = [];

    for (const dev of this._topology.devices) {
      // Canonicalize ngspice type name to our device type key
      const deviceType = this._canonicalizeDeviceType(dev.typeName);
      const mapping = deviceType ? DEVICE_MAPPINGS[deviceType] : undefined;
      if (!mapping) continue;

      const slots: Record<string, number> = {};

      // Use ngspiceToSlot (offset → our slot name) to extract values
      for (const [offsetStr, slotName] of Object.entries(mapping.ngspiceToSlot)) {
        const offset = Number(offsetStr);
        const absOffset = dev.stateBase + offset;
        if (absOffset < state0.length) {
          slots[slotName] = state0[absOffset];
        }
      }

      if (Object.keys(slots).length > 0) {
        snapshots.push({
          elementIndex: -1, // ngspice doesn't have a stable element index
          label: dev.name.toUpperCase(), // ngspice uses lowercase, we use uppercase
          slots,
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

      const elementStates = this._unpackElementStates(raw.state0);

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
        limitingEvents: [],
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
