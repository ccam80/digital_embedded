// Probe — feed a hand-written SPICE deck mirroring the optocoupler-internal
// topology directly to ngspice (bypassing harness deck-generation, which
// silently truncates composite-decomposed elements).
//
// If ngspice converges, our engine has a numerical/structural bug on a
// circuit that ngspice handles fine. If ngspice also fails to converge, the
// circuit's DCOP is genuinely pathological and the optocoupler model itself
// (or its default params) is the issue.
import { describe, it } from "vitest";

import { NgspiceBridge } from "../harness/ngspice-bridge.js";
import { DLL_PATH, dllAvailable } from "../ngspice-parity/parity-helpers.js";

(dllAvailable() ? describe : describe.skip)("probe — ngspice direct deck for optocoupler-equivalent", () => {
  it("feeds the hand-rolled .CIR and checks DCOP convergence", async () => {
    // Mirror the inside of OPTOCOUPLER_NETLIST as a flat ngspice deck.
    //   Diode (anode -> senseMid)
    //   V_vSense (senseMid -> 0, value 0)
    //   F_couple (base -> 0, controlling source = V_vSense, gain = 1)
    //   Q_bjt   (collector base 0)
    //   Outer source-and-load: Vled, Rled, Vcc, Rcol
    const deck = [
      "* hand-rolled optocoupler equivalent",
      ".model Dmod D (Is=1e-14 N=1)",
      ".model Qmod NPN",
      "Vled vledpos 0 5",
      "Rled vledpos anode 1k",
      "D1 anode senseMid Dmod",
      "Vsense senseMid 0 0",
      "Fcouple base 0 Vsense 1",   // F: NP NN Vname gain — gain*I(Vsense) flows OUT of N+ INTO N- inside source, so external current flows INTO N+ from circuit (matches InternalCccs pos=base, neg=emitter convention)
      "Q1 collector base 0 Qmod",
      "Vcc vccpos 0 5",
      "Rcol vccpos collector 1k",
      ".end",
    ].join("\n");

    delete process.env.NGSPICE_LOG;
    // Deliberately UNGUARDED, in-process bridge: in-repo diagnostic probe off
    // the MCP path, not the agent-facing harness_run surface. Must never be
    // pointed at a VDMOS deck; crash-prone / agent-driven runs go through
    // runNgspiceGuarded.
    const bridge = new NgspiceBridge(DLL_PATH);
    await bridge.init();
    const raw = bridge as unknown as { _cmd: (s: string) => void };
    // Surface the convergence path. STEPDEBUG would need a recompile; turn
    // on the runtime debug flags ngspice exposes.
    raw._cmd("set noaskquit");
    raw._cmd("option noinit");
    bridge.loadNetlist(deck);
    raw._cmd("status");
    // eslint-disable-next-line no-console
    console.log("--- Running ngspice .OP on hand-rolled optocoupler deck ---");
    bridge.runDcOp();
    raw._cmd("status");
    raw._cmd("print all");
    raw._cmd("print v(base) i(Vsense)");
    const iters = (bridge as unknown as { _iterations: Array<{ iteration: number; phaseFlags: number; phaseGmin: number; phaseSrcFact: number; converged: boolean; rhs: Float64Array; preSolveRhs?: Float64Array; matrix?: Array<{ row: number; col: number; value: number }> }> })._iterations;
    // eslint-disable-next-line no-console
    console.log("--- ngspice .OP done; matrix size =", bridge.getRawTopology()?.matrixSize, "; iterations:", iters.length, "---");
    const topo = bridge.getRawTopology();
    if (topo) {
      // eslint-disable-next-line no-console
      console.log("--- ngspice node order ---");
      for (const n of topo.nodes) {
        // eslint-disable-next-line no-console
        console.log(`  n${n.number} = "${n.name}"`);
      }
    }
    if (iters[0]) {
      const it0 = iters[0];
      // eslint-disable-next-line no-console
      console.log(`--- ngspice iter 0 pre-solve rhs: [${it0.preSolveRhs ? Array.from(it0.preSolveRhs).map(v => v.toExponential(3)).join(",") : "n/a"}]`);
      if (it0.matrix && it0.matrix.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`--- ngspice iter 0 matrix entries (${it0.matrix.length}): ---`);
        const sorted = [...it0.matrix].sort((a, b) => a.row - b.row || a.col - b.col);
        for (const e of sorted) {
          // eslint-disable-next-line no-console
          console.log(`  M[${e.row}][${e.col}] = ${e.value.toExponential(4)}`);
        }
      }
    }
  });

  it("compares against the same topology run through our engine", async () => {
    // (For reference: same topology built top-level via our engine — already
    // shown to fail in probe-stagnation.test.ts. This test exists so the
    // pairing is colocated.)
    // Empty: the ours-side reproducer is in probe-stagnation.test.ts.
  });
});
