// Probe — diagnose engine stagnation on the optocoupler init fixture.
// Builds the bench manually, enables convergence logging, manually drives
// the warm-start sequence and dumps the per-attempt blame info.
import { describe, it } from "vitest";

import { createDefaultRegistry } from "../../../../components/register-all.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";

function tryDcop(label: string, build: (f: DefaultSimulatorFacade) => unknown, dumpLog = false): void {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  build(facade);
  const coord = facade.getActiveCoordinator()!;
  coord.setConvergenceLogEnabled(true);
  const engine = coord.getAnalogEngine() as unknown as { dcOperatingPoint?: () => { converged: boolean; iterations: number; nodeVoltages: Float64Array; diagnostics: unknown[] } };
  const dc = engine.dcOperatingPoint!();
  // eslint-disable-next-line no-console
  console.log(
    `[${label}] converged=${dc.converged} iters=${dc.iterations} nodes=[${Array.from(dc.nodeVoltages).map((v) => v.toFixed(4)).join(",")}]`,
  );
  if (!dc.converged) {
    // eslint-disable-next-line no-console
    console.log(`  diag: ${(dc.diagnostics as Array<{ code?: string; message?: string }>).map((d) => `${d.code}:${d.message?.slice(0, 80)}`).join(" | ")}`);
  }
  if (dumpLog) {
    const log = coord.getConvergenceLog() ?? [];
    // eslint-disable-next-line no-console
    console.log(`  Log records: ${log.length}`);
    for (const r of log) {
      // eslint-disable-next-line no-console
      console.log(`    step=${r.stepNumber} sim=${r.simTime} dt=${r.entryDt}->${r.acceptedDt} outcome=${r.outcome} att=${r.attempts.length}`);
      for (let j = 0; j < r.attempts.length; j++) {
        const a = r.attempts[j]!;
        // eslint-disable-next-line no-console
        console.log(`      att${j}: dt=${a.dt} iter=${a.iterations} conv=${a.converged} blameEl=${a.blameElement} blameNode=${a.blameNode} trig=${a.trigger}`);
      }
    }
  }
}

describe("probe — DCOP failure isolation", () => {
  it("isolates the failing topology piece", () => {
    // 1: Just the LED side
    tryDcop("LED+rLed+gnd (Diode only)", (f) => {
      const c = f.build({
        components: [
          { id: "v",   type: "DcVoltageSource", props: { label: "v",   voltage: 5 } },
          { id: "r",   type: "Resistor",       props: { label: "r",   resistance: 1000 } },
          { id: "d1",  type: "Diode",          props: { label: "d1" } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["v:pos", "r:pos"], ["r:neg", "d1:A"], ["d1:K", "gnd:out"], ["v:neg", "gnd:out"],
        ],
      });
      f.compile(c);
    });

    // 2: Just the BJT side, base grounded via 100k
    tryDcop("BJT+rCol+gnd (NpnBJT only, base grounded)", (f) => {
      const c = f.build({
        components: [
          { id: "vCC", type: "DcVoltageSource", props: { label: "vCC", voltage: 5 } },
          { id: "rC",  type: "Resistor",       props: { label: "rC",  resistance: 1000 } },
          { id: "q1",  type: "NpnBJT",         props: { label: "q1" } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vCC:pos", "rC:pos"], ["rC:neg", "q1:C"], ["q1:E", "gnd:out"], ["q1:B", "gnd:out"], ["vCC:neg", "gnd:out"],
        ],
      });
      f.compile(c);
    });

    // 3: BJT base biased through diode chain (no Optocoupler composite)
    tryDcop("Diode->resistor->BJT base (manual coupling)", (f) => {
      const c = f.build({
        components: [
          { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: 5 } },
          { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: 1000 } },
          { id: "d1",   type: "Diode",          props: { label: "d1" } },
          { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: 5 } },
          { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: 1000 } },
          { id: "q1",   type: "NpnBJT",         props: { label: "q1" } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vLed:pos", "rLed:pos"], ["rLed:neg", "d1:A"], ["d1:K", "gnd:out"], ["vLed:neg", "gnd:out"],
          ["vCC:pos", "rCol:pos"], ["rCol:neg", "q1:C"], ["q1:E", "gnd:out"], ["q1:B", "gnd:out"], ["vCC:neg", "gnd:out"],
        ],
      });
      f.compile(c);
    });

    // 2c: BJT with floating base (no DC path to ground), like inside Optocoupler.
    tryDcop("BJT+rCol+gnd, base floating (no DC path)", (f) => {
      const c = f.build({
        components: [
          { id: "vCC", type: "DcVoltageSource", props: { label: "vCC", voltage: 5 } },
          { id: "rC",  type: "Resistor",       props: { label: "rC",  resistance: 1000 } },
          { id: "q1",  type: "NpnBJT",         props: { label: "q1" } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vCC:pos", "rC:pos"], ["rC:neg", "q1:C"], ["q1:E", "gnd:out"], ["vCC:neg", "gnd:out"],
          // q1:B left dangling — inside Optocoupler before CCCS injects current.
        ],
      });
      f.compile(c);
    });

    // 6: Transformer composite (simpler, two-coil composite)
    tryDcop("Transformer composite (DCOP, primary excited)", (f) => {
      const c = f.build({
        components: [
          { id: "v",  type: "DcVoltageSource", props: { label: "v",  voltage: 5 } },
          { id: "rp", type: "Resistor",       props: { label: "rp", resistance: 1000 } },
          { id: "rs", type: "Resistor",       props: { label: "rs", resistance: 1000 } },
          { id: "tr", type: "Transformer",    props: { label: "tr" } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["v:pos", "rp:pos"], ["rp:neg", "tr:P1"], ["tr:P2", "gnd:out"], ["v:neg", "gnd:out"],
          ["tr:S1", "rs:pos"], ["rs:neg", "gnd:out"], ["tr:S2", "gnd:out"],
        ],
      });
      f.compile(c);
    });

    // 5a: Optocoupler with vCC=0 (no collector bias)
    tryDcop("Optocoupler bench, vCC=0", (f) => {
      const c = f.build({
        components: [
          { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: 5 } },
          { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: 1000 } },
          { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: 0 } },
          { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: 1000 } },
          { id: "tx",   type: "Optocoupler",    props: { label: "tx" } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vLed:pos", "rLed:pos"], ["rLed:neg", "tx:anode"], ["tx:cathode", "gnd:out"], ["vLed:neg", "gnd:out"],
          ["vCC:pos", "rCol:pos"], ["rCol:neg", "tx:collector"], ["tx:emitter", "gnd:out"], ["vCC:neg", "gnd:out"],
        ],
      });
      f.compile(c);
    });

    // 5b: Optocoupler with both vLed=0 AND vCC=0 (totally dead)
    tryDcop("Optocoupler bench, all sources 0V", (f) => {
      const c = f.build({
        components: [
          { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: 0 } },
          { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: 1000 } },
          { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: 0 } },
          { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: 1000 } },
          { id: "tx",   type: "Optocoupler",    props: { label: "tx" } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vLed:pos", "rLed:pos"], ["rLed:neg", "tx:anode"], ["tx:cathode", "gnd:out"], ["vLed:neg", "gnd:out"],
          ["vCC:pos", "rCol:pos"], ["rCol:neg", "tx:collector"], ["tx:emitter", "gnd:out"], ["vCC:neg", "gnd:out"],
        ],
      });
      f.compile(c);
    });

    // 4a: Optocoupler with ctr=0 (no coupling — diode + isolated BJT)
    tryDcop("Optocoupler bench, ctr=0 (no coupling)", (f) => {
      const c = f.build({
        components: [
          { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: 5 } },
          { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: 1000 } },
          { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: 5 } },
          { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: 1000 } },
          { id: "tx",   type: "Optocoupler",    props: { label: "tx", ctr: 0 } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vLed:pos", "rLed:pos"], ["rLed:neg", "tx:anode"], ["tx:cathode", "gnd:out"], ["vLed:neg", "gnd:out"],
          ["vCC:pos", "rCol:pos"], ["rCol:neg", "tx:collector"], ["tx:emitter", "gnd:out"], ["vCC:neg", "gnd:out"],
        ],
      });
      f.compile(c);
    });

    // 4b: Optocoupler with vLed=0 (LED off, no current to mirror)
    tryDcop("Optocoupler bench, vLed=0 (LED off)", (f) => {
      const c = f.build({
        components: [
          { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: 0 } },
          { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: 1000 } },
          { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: 5 } },
          { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: 1000 } },
          { id: "tx",   type: "Optocoupler",    props: { label: "tx" } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vLed:pos", "rLed:pos"], ["rLed:neg", "tx:anode"], ["tx:cathode", "gnd:out"], ["vLed:neg", "gnd:out"],
          ["vCC:pos", "rCol:pos"], ["rCol:neg", "tx:collector"], ["tx:emitter", "gnd:out"], ["vCC:neg", "gnd:out"],
        ],
      });
      f.compile(c);
    });

    // 4: Original optocoupler bench (with full log dump)
    tryDcop("Optocoupler bench (original failing case)", (f) => {
      const c = f.build({
        components: [
          { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: 5 } },
          { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: 1000 } },
          { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: 5 } },
          { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: 1000 } },
          { id: "tx",   type: "Optocoupler",    props: { label: "tx" } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vLed:pos", "rLed:pos"], ["rLed:neg", "tx:anode"], ["tx:cathode", "gnd:out"], ["vLed:neg", "gnd:out"],
          ["vCC:pos", "rCol:pos"], ["rCol:neg", "tx:collector"], ["tx:emitter", "gnd:out"], ["vCC:neg", "gnd:out"],
        ],
      });
      f.compile(c);
    });
  });
});

describe("probe — dump optocoupler internals", () => {
  it("dumps element list, deviceMap, matrix size", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const c = facade.build({
      components: [
        { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: 5 } },
        { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: 1000 } },
        { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: 5 } },
        { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: 1000 } },
        { id: "tx",   type: "Optocoupler",    props: { label: "tx" } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vLed:pos", "rLed:pos"], ["rLed:neg", "tx:anode"], ["tx:cathode", "gnd:out"], ["vLed:neg", "gnd:out"],
        ["vCC:pos", "rCol:pos"], ["rCol:neg", "tx:collector"], ["tx:emitter", "gnd:out"], ["vCC:neg", "gnd:out"],
      ],
    });
    facade.compile(c);
    const coord = facade.getActiveCoordinator()!;
    coord.setConvergenceLogEnabled(true);
    const engine = coord.getAnalogEngine() as unknown as {
      _compiled: { elements: Array<{ label: string; ngspiceLoadOrder: number; pinNodes?: Map<string, number>; branchIndex?: number; constructor: { name: string } }> };
      _ctx: { rhs: Float64Array };
      _solver: { matrixSize: number };
      _deviceMap: Map<string, unknown>;
      dcOperatingPoint: () => { converged: boolean; iterations: number };
      detailedConvergence: boolean;
      postIterationHook: { drainForLog?: () => unknown[] } | null;
    };
    engine.detailedConvergence = true;
    // Install a postIterationHook to capture per-iteration RHS values.
    type PostIterArgs = [number, Float64Array, Float64Array, Float64Array, boolean, Float64Array, unknown[], unknown[], { rhs: Float64Array; solver: { getCSCNonZeros: () => Array<{ row: number; col: number; value: number }> } }];
    const dumps: Array<{ iter: number; rhs: number[]; conv: boolean }> = [];
    let firstMatrix: Array<{ row: number; col: number; value: number }> | null = null;
    let firstPreSolveRhs: Float64Array | null = null;
    type SolverProxy = { getCSCNonZeros: () => Array<{ row: number; col: number; value: number }> };
    type CtxProxy = { rhs: Float64Array; solver: SolverProxy };
    (engine as unknown as { preFactorHook: ((ctx: CtxProxy) => void) | null }).preFactorHook =
      (ctx: CtxProxy) => {
        if (firstMatrix === null) {
          firstMatrix = ctx.solver.getCSCNonZeros() as Array<{ row: number; col: number; value: number }>;
          firstPreSolveRhs = new Float64Array(ctx.rhs);
        }
      };
    (engine as unknown as { postIterationHook: ((...a: PostIterArgs) => void) | null }).postIterationHook =
      (iter: number, rhs: Float64Array, _rhsOld: Float64Array, _noncon: Float64Array, globalConv: boolean) => {
        if (dumps.length < 30) {
          dumps.push({ iter, rhs: Array.from(rhs).map((v) => Number(v.toFixed(6))), conv: globalConv });
        }
      };
    // Force setup (it runs during dcOperatingPoint, but we can call directly).
    const dc = engine.dcOperatingPoint();
    const capturedRhs = firstPreSolveRhs as Float64Array | null;
    if (capturedRhs) {
      // eslint-disable-next-line no-console
      console.log("Our iter 0 pre-solve RHS:", "[" + Array.from(capturedRhs).map((v: number) => v.toExponential(3)).join(",") + "]");
    }
    const capturedMatrix = firstMatrix as Array<{ row: number; col: number; value: number }> | null;
    if (capturedMatrix) {
      // eslint-disable-next-line no-console
      console.log(`Our iter 0 matrix (${capturedMatrix.length} entries):`);
      const sorted = [...capturedMatrix].sort((a, b) => a.row - b.row || a.col - b.col);
      for (const e of sorted) {
        // eslint-disable-next-line no-console
        console.log(`  M[${e.row}][${e.col}] = ${e.value.toExponential(4)}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log("First 30 NR iterations (all phases mixed):");
    for (const d of dumps) {
      // eslint-disable-next-line no-console
      console.log(`  iter${d.iter} conv=${d.conv} rhs=${JSON.stringify(d.rhs)}`);
    }
    const log = coord.getConvergenceLog() ?? [];
    // eslint-disable-next-line no-console
    console.log("Log records=", log.length);
    for (const rec of log) {
      // eslint-disable-next-line no-console
      console.log(`  step=${rec.stepNumber} sim=${rec.simTime} outcome=${rec.outcome} attempts=${rec.attempts.length}`);
      for (let i = 0; i < rec.attempts.length; i++) {
        const a = rec.attempts[i]!;
        // eslint-disable-next-line no-console
        console.log(
          `    att${i}: dt=${a.dt} method=${a.method} iter=${a.iterations} conv=${a.converged} blameEl=${a.blameElement} blameNode=${a.blameNode} trig=${a.trigger}`,
        );
        const det = (a as unknown as { iterationDetails?: Array<{ iter: number; vMax: number; iMax: number; vMaxNode?: number; iMaxNode?: number; gminParam?: number; srcFact?: number }> }).iterationDetails;
        if (det && det.length > 0) {
          // eslint-disable-next-line no-console
          console.log(`      iterationDetails (${det.length}):`);
          for (let j = 0; j < Math.min(det.length, 8); j++) {
            const d = det[j]!;
            // eslint-disable-next-line no-console
            console.log(`        iter${d.iter}: vMax=${d.vMax} (n${d.vMaxNode}), iMax=${d.iMax} (n${d.iMaxNode}), gmin=${d.gminParam}, srcFact=${d.srcFact}`);
          }
          if (det.length > 8) {
            const last = det[det.length - 1]!;
            // eslint-disable-next-line no-console
            console.log(`        ...last: iter${last.iter}: vMax=${last.vMax}, iMax=${last.iMax}, gmin=${last.gminParam}, srcFact=${last.srcFact}`);
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log("DCOP converged=", dc.converged, " iters=", dc.iterations);
    // eslint-disable-next-line no-console
    console.log("matrixSize=", engine._solver.matrixSize);
    // eslint-disable-next-line no-console
    console.log("deviceMap size=", engine._deviceMap.size);
    // eslint-disable-next-line no-console
    console.log("Elements (sorted by ngspiceLoadOrder):");
    const els = engine._compiled.elements
      .map((e, i) => ({ idx: i, label: e.label, type: e.constructor.name, order: e.ngspiceLoadOrder, pins: Object.fromEntries(e.pinNodes ?? new Map()), branch: e.branchIndex }));
    for (const e of els) {
      // eslint-disable-next-line no-console
      console.log(`  [${e.order}] (${e.type})  label="${e.label}"  pins=${JSON.stringify(e.pins)}  branch=${e.branch ?? "-"}`);
    }
  });
});

describe("probe — optocoupler stagnation root cause", () => {
  it("dumps DCOP convergence log", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: 5 } },
        { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: 1000 } },
        { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: 5 } },
        { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: 1000 } },
        { id: "tx",   type: "Optocoupler",    props: { label: "tx" } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vLed:pos",   "rLed:pos"],
        ["rLed:neg",   "tx:anode"],
        ["tx:cathode", "gnd:out"],
        ["vLed:neg",   "gnd:out"],
        ["vCC:pos",    "rCol:pos"],
        ["rCol:neg",   "tx:collector"],
        ["tx:emitter", "gnd:out"],
        ["vCC:neg",    "gnd:out"],
      ],
    });

    facade.compile(circuit);
    const coord = facade.getActiveCoordinator()!;
    coord.setConvergenceLogEnabled(true);

    // Run a *standalone* DCOP first so we get the dcOperatingPoint() recording
    // path (which records iteration details when convergenceLog.enabled).
    const engine = coord.getAnalogEngine() as unknown as { dcOperatingPoint?: () => unknown; _ctx?: { rhs: Float64Array } };
    if (typeof engine.dcOperatingPoint === "function") {
      const dc = engine.dcOperatingPoint() as { converged: boolean; iterations: number; nodeVoltages: Float64Array; diagnostics: unknown[] };
      // eslint-disable-next-line no-console
      console.log("STANDALONE DCOP: converged=", dc.converged, " iters=", dc.iterations, " nodeVoltages=", Array.from(dc.nodeVoltages));
      // eslint-disable-next-line no-console
      console.log("DCOP diagnostics:", JSON.stringify(dc.diagnostics, null, 2).slice(0, 1500));
    }

    let threw: Error | null = null;
    try { coord.step(); } catch (e) { threw = e as Error; }
    const log = coord.getConvergenceLog() ?? [];

    // eslint-disable-next-line no-console
    console.log("THREW:", threw?.message ?? "(no throw)");
    // eslint-disable-next-line no-console
    console.log("LOG length:", log.length);
    for (let i = 0; i < log.length; i++) {
      const r = log[i]!;
      // eslint-disable-next-line no-console
      console.log(
        `  step ${r.stepNumber} simTime=${r.simTime} entryDt=${r.entryDt} acceptedDt=${r.acceptedDt} ` +
        `outcome=${r.outcome} attempts=${r.attempts.length} method=${r.entryMethod}->${r.exitMethod} ` +
        `lteRej=${r.lteRejected} lteWorst=${r.lteWorstRatio}`,
      );
      for (let j = 0; j < r.attempts.length; j++) {
        const a = r.attempts[j]!;
        // eslint-disable-next-line no-console
        console.log(
          `    att ${j}: dt=${a.dt} method=${a.method} iter=${a.iterations} ` +
          `converged=${a.converged} blameEl=${a.blameElement} blameNode=${a.blameNode} ` +
          `trigger=${a.trigger}`,
        );
      }
    }
  });
});
