# resistor stamp G=1/R via facade harness

## Category

`contract-update`

## Problem

`src/components/passives/__tests__/resistor.test.ts::resistor_load_interface::"load(ctx) stamps G=1/R bit-exact for R=1kΩ"` fails with `expected undefined to be defined` at line 376. The test calls `element.load(ctx.loadCtx)` on a hand-rolled `LoadContext` produced by `makeSimpleCtx`, then queries `ctx.solver.getCSCNonZeros()` and looks for the stamped entry at `(row=1, col=1)`. The find returns `undefined` because:

1. `makeSimpleCtx` produces a `SparseSolver` instance, but the test calls `solver._initStructure()` on it before `load()`. After `_initStructure()` the linked CSC structure is empty until `load()` calls `solver.allocElement(...)` followed by `solver.stampElement(...)`. The element does call both, but `getCSCNonZeros()` reports the post-factor structure — and the four resistor stamps land in the structure but are wiped by some intermediate `_resetForAssembly` / structural-reset path that `makeSimpleCtx` triggers, OR the test is ordering operations such that `_initStructure()` is called *after* the element has already done its allocation in a previous fixture build (the resistor's `setup()` is called by `makeSimpleCtx` before the explicit `_initStructure()`).

The companion test `resistor_load_dcop_parity::"3-resistor divider Vs=5V R=1k/1k/1k matches ngspice bit-exact"` at line 267 *passes* on the same machinery — the only structural difference is that it uses three resistors in series and does its `_initStructure()` and `load()` calls in the same order. So the problem is fragile reliance on a hand-built load harness that relies on the call sequence between `setup()` (run inside `makeSimpleCtx`) and `_initStructure()` (called explicitly afterwards). When the order is wrong the resistor's allocated handles point at columns that get released by the structure reset, and the stamps land in nonexistent slots — `getCSCNonZeros()` reports nothing for them.

The fix is to compile a 1kΩ resistor circuit through the facade, run DC-OP, and assert the matrix entries via the same `getCSCNonZeros()` surface the harness already uses, so the test exercises the production setup→load→stamp pipeline.

## Failing test / site

`src/components/passives/__tests__/resistor.test.ts`:

| Test | Lines | Failure |
|------|-------|---------|
| `resistor_load_interface > load(ctx) stamps G=1/R bit-exact for R=1kΩ` | 354-384 | `expect(entry11).toBeDefined()` — undefined |

Sibling `resistor_load_dcop_parity` test (lines 267-343) is passing today and shows the *correct* shape for a stamp-bit-exact assertion: it constructs a multi-element circuit, calls `_initStructure()` once on a context produced from all elements simultaneously, then loads each element. That pattern works but is still hand-rolled — it should also migrate.

## ngspice citation

Verified against `ref/ngspice/src/spicelib/devices/res/resload.c`:

```c
// resload.c:34-37
*(here->RESposPosptr) += m * here->RESconduct;
*(here->RESnegNegptr) += m * here->RESconduct;
*(here->RESposNegptr) -= m * here->RESconduct;
*(here->RESnegPosptr) -= m * here->RESconduct;
```

`RESconduct` is `1.0 / R` (set by `restemp.c` during temperature-update; `m` is the per-instance multiplier, default 1.0). For a 1kΩ resistor, `RESconduct = 0.001` exactly under IEEE-754 (the single division `1.0 / 1000.0` produces `0x3F50624DD2F1A9FC = 0.001` bit-exact). The four stamps at (pos,pos), (neg,neg), (pos,neg), (neg,pos) are the four entries the test asserts.

The citation in the test source (line 350: `resload.c:45-48`) cites the AC-load function (`RESacload`), not the DC-load function (`RESload`). `RESload` lives at lines 16-41 of the file; the four stamps are at lines 34-37. Update the comment when migrating.

## Migration

Compile a 1kΩ resistor circuit through `DefaultSimulatorFacade`, run DC-OP, then read `engine.solver!.getCSCNonZeros()` directly. The harness's `captureTopology` / `createIterationCaptureHook` already use the same `getCSCNonZeros()` surface for matrix capture (`src/solver/analog/__tests__/harness/capture.ts:310, :363`); no new public accessor is required.

### Replacement test body

```ts
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";

it("load(ctx) stamps G=1/R bit-exact for R=1kΩ", () => {
  // Build VS=0V — R=1kΩ — GND so the resistor sits between two MNA nodes
  // with a defined branch row. (A bare resistor with both pins on user nodes
  // and no source is degenerate; the facade rejects it.)
  const facade = new DefaultSimulatorFacade(createDefaultRegistry());
  const circuit = facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { voltage: 0 } },
      { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:A"],
      ["r1:B",   "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
  facade.compile(circuit);

  const coordinator = facade.getActiveCoordinator()!;
  const engine = coordinator.getAnalogEngine() as MNAEngine;
  engine.dcOperatingPoint();

  const entries = engine.solver!.getCSCNonZeros();
  const NGSPICE_G_REF = 1 / 1000; // resload.c:34-37; one division — bit-exact 0.001.
  // Resistor pins land at MNA node ids 1 (vs:pos / r1:A) and 2 (would be r1:B,
  // but r1:B is wired to gnd which collapses to ground row 0). Inspect the
  // netlist to confirm the actual row/col ids.
  const e11 = entries.find((e) => e.row === 1 && e.col === 1);
  expect(e11).toBeDefined();
  expect(e11!.value).toBe(NGSPICE_G_REF);
  // Off-diagonal stamps onto ground row are filtered (ground row 0 is the
  // trashcan slot in the sparse solver) — only the (1,1) diagonal is
  // observable when one pin is grounded. To recover all four stamps, run a
  // VS — R — VS₂ topology so neither pin grounds.
});
```

If the test must observe all four stamps (pos-pos, neg-neg, pos-neg, neg-pos), use a non-grounded resistor topology. Insert a second voltage source between `r1:B` and `gnd:out` so neither resistor pin collapses to row 0:

```ts
connections: [
  ["vs:pos", "r1:A"],
  ["r1:B",   "vs2:pos"],
  ["vs2:neg", "gnd:out"],
  ["vs:neg",  "gnd:out"],
],
```

Then assert all four entries at (1,1), (2,2), (1,2), (2,1).

### Apply the same migration to `resistor_load_dcop_parity` (lines 267-343)

That test currently passes but uses the same hand-rolled `makeSimpleCtx` machinery; it should migrate to the facade for the same contract-stability reason. The test's voltage-divider topology (Vs → R1 → R2 → R3 → GND) maps directly onto a facade-built circuit and the per-resistor stamp assertions become reads from `getCSCNonZeros()` after `dcOperatingPoint()`.

## Tensions / uncertainties

- The `getCSCNonZeros()` accessor is the supported matrix-inspection surface. The harness uses it; the facade-level migration uses it. No new public accessor is needed. If the user wants to add a structured `engine.captureMatrix()` wrapper, that's a refactor concern — not a blocker for this fix.
- One open question: `getCSCNonZeros()` reports the *post-factor* matrix when called after `dcOperatingPoint()`. For this test the post-factor entries equal the load-time stamps because the resistor circuit is linear and the LU pivot at the diagonal is the diagonal value (the comment at `sparse-solver.ts:1030-1033` notes this). For nonlinear circuits the post-factor read differs from the load-time stamp. If a future test wants the *pre-factor* stamp, it must wire `engine.preFactorHook` to capture before LU. That's out of scope here but worth flagging.
- Escalation candidate: `MNAEngine.solver` returns `null` until `_compiled` is set, but the matrix is only populated after the first `dcOperatingPoint()` call. The test must call `dcOperatingPoint()` before reading `getCSCNonZeros()`. If the user wants a "stamp without solving" path for unit tests, that's a new public API request — flag, do not invent.
- The original test's claim that `resload.c:45-48` is the citation site is wrong (those lines are in `RESacload`). Migration must update the comment to `resload.c:34-37`.
