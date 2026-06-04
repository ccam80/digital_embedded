# Reconstruction spec — `analysis#recon/tf`

Build the ngspice DC small-signal **transfer-function** driver (`.tf`) — the
thin analysis that, over the already-linearized and LU-factored DC
operating-point Jacobian, computes three scalars:

- the **transfer ratio** d(output variable)/d(input source),
- the **input resistance** seen at the input source,
- the **output resistance** seen at the output port.

`.tf` is an **IN** analysis driver (open question **#57**,
`OPEN-QUESTIONS-WORKLOG.md:120, 523-538`, **RESOLVED — IN, thin recon**;
`analysis-scope.md` amended in-place 2026-05-29 to list `.tf` under implemented).
It is in scope because it is a small, self-contained re-use of the DC solve
digiTS already performs: ngspice TFanal does no new matrix assembly and no new
iteration — it injects a unit RHS into the matrix the operating-point solve
already factored and runs one forward/back-substitution per port. There is no
driver of this shape in digiTS today, so this is a reconstruction (a new driver
over the existing solve), not a per-hunk port.

digiTS target: a new `.tf` driver co-located with the DC operating-point solver
(`src/solver/analog/dc-operating-point.ts`), exposed up through the engine, the
facade, and a `circuit_tf` MCP tool.

ngspice baseline: `ref/ngspice/src/spicelib/analysis/tfanal.c::TFanal`
(`tfanal.c:17-165`), read by hand for every citation below.

Authoring contract: this spec is **documentation**. No code. No tests. No ledger
edit. No commit. The implementer authors the TypeScript edit against this spec;
the verifier checks the edit against the `tfanal.c` citations herein. Per
`CLAUDE.md` comment-hygiene, every reconstructed source comment cites the current
`ref/ngspice/src/spicelib/analysis/tfanal.c` line and explains the mechanism in
present tense, with no v26/v41/era tags and no migration narrative.

## Ledger reconciliation

`analysis#recon/tf` is currently `state: ESCALATED` in the ledger
(`progress.json:794-809`; `raisedBy: applier`, `trigger: "reconstruction spec
absent"`). The escalation decisionNeeded is precisely "author
`spec/v41-port/reconstruction/analysis-tf.md` … then rebuild the ledger so
specExists flips true and this item returns to PENDING for the builder."
Authoring this file satisfies that condition. The follow-up (a **user /
ledger-owner** action, NOT part of this documentation pass) is to re-run
`node spec/v41-port/build-ledger.mjs`, which flips `specExists` to `true` for
`analysis#recon/tf`, clears the `ESCALATED` state back to `PENDING`, and keeps
the two blocked hunks `analysis/tfanal.c#h001` and `analysis/tfanal.c#h002`
(`ledger.json:42655, 42686`, both `blockedBy: analysis#recon/tf`) blocked until
the recon-builder delivers the driver. The planning record already carries the
intended shape (`planning/analysis-decisions.json:1258-1272`,
`tsFile: src/solver/analog/dc-operating-point.ts`, `state: PENDING`,
`blocks: [analysis/tfanal.c#h001, analysis/tfanal.c#h002]`).

## Current digiTS state

digiTS has **no** `.tf` driver. The DC analysis surface is:

- `solveDcOperatingPoint(ctx)` (`dc-operating-point.ts:309-521`) — the ngspice
  `CKTop` three-level fallback. On success it writes `ctx.dcopResult` and leaves
  the sparse matrix **factored** (the final clean NR solve inside each ladder
  level runs `solver.solve()` against a factored matrix; `dc-operating-point.ts:628,
  752, 812, 904, 954`). This is the same invariant AC analysis depends on
  (`ac-analysis.ts:398-406`: the matrix already carries a factorization, the
  preceding DC-OP factored it).
- The sparse solver exposes `solve(rhs, solution, iRHS?, iSolution?)`
  (`sparse-solver.ts:784-789`) which asserts `IS_FACTORED`
  (`sparse-solver.ts:790-794`) and runs forward-elimination + back-substitution
  against the existing LU **without re-factoring**. This is the exact primitive
  ngspice TFanal calls (`SMPsolve`, `tfanal.c:87, 150`). The solver has **no**
  transpose-solve entry point (see Ratification item R-2).
- The engine interface (`analog-engine-interface.ts:361-524`) exposes
  `dcOperatingPoint()` (`:373`) and `acAnalysis()` (`:382`) but **no** transfer-
  function method and **no** public "re-solve the factored DC matrix with a new
  RHS" surface (see R-1).
- `DcOpResult` (`analog-engine-interface.ts:284-295`) carries `nodeVoltages`
  (indexed by MNA node ID) and `converged`/`method`/`iterations`/`diagnostics`.
- The facade interface `SimulatorFacade` (`facade.ts:28+`) has no DC-analysis
  method of its own; `DefaultSimulatorFacade` surfaces the operating point via
  `getDcOpResult()` (`default-facade.ts:383-386`, delegating to
  `this._coordinator.dcOperatingPoint()`). There is no transfer-function facade
  method.
- The MCP layer registers `circuit_dc_op` (`simulation-tools.ts:276-345`) and
  `circuit_ac_sweep` (`simulation-tools.ts:351+`); there is no `circuit_tf`.

The recon adds the driver and the three cross-surface touch-points
(Part A–Part E), grounded one-for-one against `tfanal.c`.

## Part A — ngspice `TFanal` walk (the algorithm, line-for-line)

`TFanal` (`tfanal.c:17-165`) does the following, in order. The identifier map to
digiTS follows.

1. **Operating point** (`tfanal.c:43-47`): `CKTop(ckt, …MODEDCOP|MODEINITJCT,
   …MODEDCOP|MODEINITFLOAT, CKTdcMaxIter)`. This is the DC operating-point solve
   digiTS already performs as `solveDcOperatingPoint(ctx)`
   (`dc-operating-point.ts:309`). At its return the Jacobian is factored.
2. **Resolve the input source** (`tfanal.c:49-71`): look up `job->TFinSrc`,
   verify it is a `Vsource` or `Isource` and set `TFinIsV` / `TFinIsI`. Error
   `E_NOTFOUND` if absent or not a source.
3. **Zero the RHS** (`tfanal.c:73-76`): `size = SMPmatSize(matrix); for i in
   0..size: CKTrhs[i] = 0`.
4. **Inject the input excitation** (`tfanal.c:78-84`):
   - current input (`TFinIsI`): `CKTrhs[node0] -= 1; CKTrhs[node1] += 1;`
     (`tfanal.c:79-80`) — a 1 A probe between the source two nodes.
   - voltage input (else): `insrc = CKTfndBranch(TFinSrc); CKTrhs[insrc] += 1;`
     (`tfanal.c:82-83`) — a unit excitation into the source branch-current row.
5. **First re-solve** (`tfanal.c:87-88`): `SMPsolve(matrix, CKTrhs, CKTrhsSpare);
   CKTrhs[0] = 0;` — one forward/back-substitution against the **already-factored**
   matrix. No re-factor.
6. **Transfer ratio** outputs[0] (`tfanal.c:111-118`):
   - voltage output: `CKTrhs[TFoutPos->number] - CKTrhs[TFoutNeg->number]`
     (`tfanal.c:113-114`).
   - current output: `outsrc = CKTfndBranch(TFoutSrc); CKTrhs[outsrc]`
     (`tfanal.c:116-117`).
7. **Input resistance** outputs[1] (`tfanal.c:120-130`):
   - current input: `CKTrhs[node1] - CKTrhs[node0]` (`tfanal.c:122-123`) — the
     node-pair voltage developed by the 1 A probe.
   - voltage input: if `fabs(CKTrhs[insrc]) < 1e-20` then `1e20`, else
     `-1 / CKTrhs[insrc]` (`tfanal.c:125-129`). The branch current returned by
     the unit-voltage injection is the negative input admittance; Rin = -1/i.
8. **Output-resistance shortcut** (`tfanal.c:132-139`): if the output is a
   current through the **same** source as the input (`TFoutIsI &&
   TFoutSrc == TFinSrc`), then `outputs[2] = outputs[1]` and skip the second
   solve (`goto done`).
9. **Second RHS zero + output excitation** (`tfanal.c:140-149`): zero `CKTrhs`
   again, then inject the unit probe at the **output** port:
   - voltage output: `CKTrhs[TFoutPos->number] -= 1; CKTrhs[TFoutNeg->number] += 1;`
     (`tfanal.c:145-146`).
   - current output: `CKTrhs[outsrc] += 1;` (`tfanal.c:148`).
10. **Second re-solve** (`tfanal.c:150-151`): `SMPsolve(matrix, CKTrhs,
    CKTrhsSpare); CKTrhs[0] = 0;` — again against the same factored matrix.
11. **Output resistance** outputs[2] (`tfanal.c:152-157`):
    - voltage output: `CKTrhs[TFoutNeg->number] - CKTrhs[TFoutPos->number]`
      (`tfanal.c:153-154`) — note the **Neg − Pos** order (opposite of the
      transfer ratio Pos − Neg), pinned for sign correctness.
    - current output: `1 / MAX(1e-20, CKTrhs[outsrc])` (`tfanal.c:156`).
12. **Output** (`tfanal.c:158-164`): emit the three-element vector `outputs[]`
    as the result.

### Identifier map (ngspice to digiTS)

| ngspice (`tfanal.c`) | digiTS | Note |
|---|---|---|
| `CKTop(...)` (`:44`) | `solveDcOperatingPoint(ctx)` (`dc-operating-point.ts:309`) | same DC-OP solve; leaves matrix factored |
| `SMPmatSize(matrix)` (`:73`) | `ctx.solver.matrixSize` (`dc-operating-point.ts:311`) | |
| `CKTrhs[]` (`:74-88, 111-157`) | `ctx.rhs` | the working RHS / solution buffer |
| `CKTrhsSpare` (`:87, 150`) | the `solution` arg of `solver.solve()` | `SMPsolve(M, b, spare)` maps to `solver.solve(rhs, solution)` |
| `SMPsolve(matrix, CKTrhs, CKTrhsSpare)` (`:87, 150`) | `ctx.solver.solve(rhs, solution)` (`sparse-solver.ts:784`) | forward/back-sub against factored LU; **no** re-factor |
| `CKTfndBranch(ckt, TFinSrc)` (`:82`) | the source element MNA branch-current row id (R-3) | voltage-source / inductor branch row |
| `GENnode(ptr)[0]` / `[1]` (`:79-80, 122-123`) | the input source two pin MNA node ids | for a current-source input |
| `TFoutPos->number` / `TFoutNeg->number` (`:113-114, 145-154`) | the output node pair MNA node ids | resolved from output-variable address |
| `job->TFinIsV` / `TFinIsI` (`:55-65`) | derived from the resolved input element class | Vsource is V, Isource is I |
| `job->TFoutIsV` / `TFoutIsI` (`:97, 112, 132, 144, 152`) | derived from the output-port spec | node-pair is V, source-current is I |
| `outputs[0..2]` (`:113-156`) | `{ transferFunction, inputResistance, outputResistance }` (Part C) | |
| `CKTrhs[0] = 0` (`:88, 151`) | `ctx.rhs[0] = 0` | ground row is index 0; pinned after each solve |

## Part B — The driver (`runTransferFunction`)

Add a driver function co-located with `solveDcOperatingPoint` in
`dc-operating-point.ts`, exported and invoked through the engine (Part D). It
takes the already-prepared `CKTCircuitContext`, the resolved input/output port
descriptors, runs the DC-OP if not already current, then performs the two
RHS-injection re-solves exactly as Part A. The TS shape (mechanism-only;
comments cite `tfanal.c`):

```ts
export interface TfPortSpec {
  // Input source: its branch-current row (voltage source) or its two node ids (current source).
  input:
    | { kind: "vsource"; branch: number }
    | { kind: "isource"; nodePos: number; nodeNeg: number };
  // Output port: a node pair (voltage output) or a source branch row (current output).
  output:
    | { kind: "node"; nodePos: number; nodeNeg: number }
    | { kind: "branch"; branch: number; sameSourceAsInput: boolean };
}

export interface TfResult {
  transferFunction: number;   // tfanal.c:113-117 — outputs[0]
  inputResistance: number;    // tfanal.c:122-129 — outputs[1]
  outputResistance: number;   // tfanal.c:153-156 — outputs[2]
}

export function runTransferFunction(
  ctx: CKTCircuitContext,
  port: TfPortSpec,
): TfResult {
  const size = ctx.solver.matrixSize;
  const rhs = ctx.rhs;
  const sol = /* engine-owned spare/solution buffer, length size+1 */;

  // tfanal.c:73-76 — zero the RHS over [0..size].
  for (let i = 0; i <= size; i++) rhs[i] = 0;

  // tfanal.c:78-84 — inject the unit input excitation.
  let insrcBranch = -1;
  if (port.input.kind === "isource") {
    rhs[port.input.nodePos] -= 1;   // tfanal.c:79
    rhs[port.input.nodeNeg] += 1;   // tfanal.c:80
  } else {
    insrcBranch = port.input.branch;
    rhs[insrcBranch] += 1;          // tfanal.c:83
  }

  // tfanal.c:87-88 — one re-solve against the factored DC Jacobian (no re-factor).
  ctx.solver.solve(rhs, sol);
  rhs.set(sol);                     // SMPsolve writes the solution back into CKTrhs
  rhs[0] = 0;                       // tfanal.c:88

  // tfanal.c:111-118 — transfer ratio.
  let transferFunction: number;
  if (port.output.kind === "node") {
    transferFunction = rhs[port.output.nodePos] - rhs[port.output.nodeNeg]; // :113-114
  } else {
    transferFunction = rhs[port.output.branch];                            // :116-117
  }

  // tfanal.c:120-130 — input resistance.
  let inputResistance: number;
  if (port.input.kind === "isource") {
    inputResistance = rhs[port.input.nodeNeg] - rhs[port.input.nodePos];   // :122-123
  } else {
    const iin = rhs[insrcBranch];
    inputResistance = Math.abs(iin) < 1e-20 ? 1e20 : -1 / iin;             // :125-129
  }

  // tfanal.c:132-139 — output==input-source-current shortcut.
  if (port.output.kind === "branch" && port.output.sameSourceAsInput) {
    return { transferFunction, inputResistance, outputResistance: inputResistance };
  }

  // tfanal.c:140-149 — second RHS zero + unit output excitation.
  for (let i = 0; i <= size; i++) rhs[i] = 0;
  if (port.output.kind === "node") {
    rhs[port.output.nodePos] -= 1;  // :145
    rhs[port.output.nodeNeg] += 1;  // :146
  } else {
    rhs[port.output.branch] += 1;   // :148
  }

  // tfanal.c:150-151 — second re-solve against the same factored matrix.
  ctx.solver.solve(rhs, sol);
  rhs.set(sol);
  rhs[0] = 0;                       // tfanal.c:151

  // tfanal.c:152-157 — output resistance (note Neg − Pos order for the node case).
  let outputResistance: number;
  if (port.output.kind === "node") {
    outputResistance = rhs[port.output.nodeNeg] - rhs[port.output.nodePos]; // :153-154
  } else {
    outputResistance = 1 / Math.max(1e-20, rhs[port.output.branch]);       // :156
  }

  return { transferFunction, inputResistance, outputResistance };
}
```

Mechanism notes pinned for parity:
- The `rhs[0] = 0` after each `solve()` (`tfanal.c:88, 151`) is load-bearing:
  index 0 is the ground row, and the solve can leave a non-zero residual there
  that would otherwise poison the node-pair subtractions.
- The output-resistance node case subtracts **Neg − Pos** (`tfanal.c:153-154`),
  the reverse of the transfer-ratio **Pos − Neg** (`tfanal.c:113-114`). Both
  orders are reproduced verbatim — this is a sign convention, not a free choice.
- The `1e-20` / `1e20` clamps (`tfanal.c:126, 156`) are reproduced exactly,
  including `MAX(1e-20, …)` for the current-output resistance.
- No transpose, no adjoint: ngspice solves the **same** factored system with a
  shifted RHS. See R-2 for why the brief "transpose-solve for the adjoint"
  framing is not what `tfanal.c` does.

## Part C — Output shape

`TfResult` mirrors ngspice three-element `outputs[]` vector
(`tfanal.c:113-156`, emitted at `tfanal.c:158-162`):

| field | ngspice | meaning |
|---|---|---|
| `transferFunction` | outputs[0] (`:113-117`) | d(output)/d(input); dimensionless (V/V or A/A), Ohm (V/A), or S (A/V) depending on port kinds |
| `inputResistance` | outputs[1] (`:122-129`) | Ohm seen at the input source |
| `outputResistance` | outputs[2] (`:153-156`) | Ohm seen at the output port |

The result surfaces through the engine, facade, and MCP layers (Parts D, E)
alongside the input/output port labels the caller specified.

## Part D — Engine surface (re-solve against the factored DC Jacobian)

`runTransferFunction` consumes the **factored** DC Jacobian. ngspice gets this
for free because `TFanal` calls `CKTop` itself and then re-uses `ckt->CKTmatrix`
(`tfanal.c:44, 87`). digiTS `solveDcOperatingPoint` likewise leaves
`ctx.solver` factored on success, and AC analysis already relies on exactly this
post-DC-OP factored state (`ac-analysis.ts:398-406`). So the engine method:

1. runs `solveDcOperatingPoint(ctx)` (or reuses the current factored state if the
   operating point is already valid),
2. resolves the input/output port specs from caller-supplied labels into the
   MNA branch/node ids (`TfPortSpec`),
3. calls `runTransferFunction(ctx, port)`,
4. returns `TfResult` plus the resolved port metadata.

Add to the `AnalogEngine` interface (`analog-engine-interface.ts:361-524`),
beside `dcOperatingPoint()` (`:373`) and `acAnalysis()` (`:382`):

```ts
export interface TfParams {
  // Label of the independent source providing the input excitation (e.g. "V1").
  inputSource: string;
  // Output port. Either a node-pair voltage ("Vout" or "Vout,Vref" — second
  // defaults to ground) or a source-branch current ("I(V2)" form).
  output: string;
}

export interface TfResult {
  transferFunction: number;
  inputResistance: number;
  outputResistance: number;
  // Resolved input/output descriptors echoed back for the caller.
  inputSource: string;
  output: string;
  // False (with a diagnostic) if the underlying DC-OP did not converge.
  converged: boolean;
  diagnostics: Diagnostic[];
}

// Run a DC small-signal transfer-function analysis (ngspice tfanal.c TFanal).
transferFunction(params: TfParams): TfResult;
```

The implementer wires `MNAEngine.transferFunction` to the DC-OP +
`runTransferFunction` sequence above, and the coordinator forwards it (mirroring
how `dcOperatingPoint()` / `acAnalysis()` are surfaced through the coordinator
today; cf. `default-facade.ts:385` and `simulation-tools.ts:312, 388`).

**Ratification item R-1 (engine re-solve boundary). RESOLVED = generic
`reSolveFactored(rhs)`.** The engine gains a reusable primitive
`reSolveFactored(rhs): Float64Array` — re-solve the post-DC-OP factored matrix
with a caller-supplied RHS (one forward/back-substitution against the existing LU,
no re-factor). `runTransferFunction` (Part B) consumes `reSolveFactored` rather
than reaching `ctx.solver.solve()` directly; `acAnalysis()` already consumes the
same factored state internally, and a future `.sens` shares this primitive. The
driver in Part B is unchanged in behavior — its two re-solve steps now call the
`reSolveFactored` primitive instead of `ctx.solver.solve()` inline.

**Ratification item R-3 (branch-row resolution). RESOLVED = full I/O via the
existing branch registry + thin accessor.** For a voltage-source input and a
current output, `.tf` needs the source branch-current row id (`CKTfndBranch`,
`tfanal.c:82, 116`). digiTS HAS this analogue: `ctx.findDevice`
(`src/core/mna-subcircuit-netlist.ts:11`, documented as "the ngspice CKTfndBranch
/ CKTfndDev analogues"), and branch rows are allocated per-label via
`ctx.makeCur(label, "branch")` (e.g. the bridge driver,
`src/solver/analog/behavioral-drivers/bridge-output-driver.ts:112`). The
implementer resolves a source label to its branch row through this EXISTING
makeCur/findDevice branch registry. `CompiledAnalogCircuit.labelToNodeId` covers
nodes (`analog-engine-interface.ts:314`) but exposes no public label→branch-row
accessor, so the recon adds a THIN accessor over the existing registry — not a new
mechanism. Both the voltage-source-input / current-output paths and the node-pair
paths (current-source input, voltage output) are IN this recon; nothing is
deferred.

## Part E — Facade and MCP surfaces

### Facade (`default-facade.ts` + `facade.ts`)

Add a `transferFunction(params: TfParams): TfResult | null` method to the
`SimulatorFacade` interface (`facade.ts:28+`) and implement it on
`DefaultSimulatorFacade` by delegating to the coordinator, mirroring
`getDcOpResult()` (`default-facade.ts:383-386`):

```ts
// Run a DC transfer-function analysis, or null if no analog backend.
transferFunction(params: TfParams): TfResult | null {
  return this._coordinator.transferFunction(params);
}
```

The coordinator gains the matching `transferFunction` / `supportsTf()` pair,
parallel to `dcOperatingPoint()` / `supportsDcOp()` and `acAnalysis()` /
`supportsAcSweep()` (`simulation-tools.ts:303, 385`).

### MCP tool `circuit_tf` (`simulation-tools.ts`)

Register a `circuit_tf` tool beside `circuit_dc_op` (`simulation-tools.ts:276`)
and `circuit_ac_sweep` (`:351`), following the same `registerTool` + `wrapTool` +
`ensureEngine` shape:

```ts
server.registerTool(
  "circuit_tf",
  {
    title: "DC Transfer Function",
    description:
      "Compute the DC small-signal transfer function of the compiled analog " +
      "or mixed-signal circuit (ngspice .tf). Returns the transfer ratio " +
      "d(output)/d(inputSource), the input resistance at the source, and the " +
      "output resistance at the output port. Errors if the circuit has no " +
      "analog domain.",
    inputSchema: {
      handle: z.string().describe("Circuit handle"),
      inputSource: z.string().describe("Label of the input independent source (e.g. V1)"),
      output: z.string().describe("Output port: node (Vout or Vout,Vref) or source current (I(V2))"),
    },
  },
  wrapTool<{ handle: string; inputSource: string; output: string }>(
    "circuit_tf error",
    ({ handle, inputSource, output }) => {
      const coordinator = ensureEngine(handle, facade, session);
      if (!coordinator.supportsTf()) {
        return "Transfer-function analysis not available (no analog domain)";
      }
      const r = coordinator.transferFunction({ inputSource, output });
      if (!r) return "Transfer-function analysis not available (no analog domain)";
      const lines = [
        `Transfer Function (.tf):`,
        `  Input source: ${r.inputSource}`,
        `  Output: ${r.output}`,
        `  Converged: ${r.converged}`,
        `  Transfer ratio d(${r.output})/d(${r.inputSource}) = ${r.transferFunction}`,
        `  Input resistance  = ${r.inputResistance} Ohm`,
        `  Output resistance = ${r.outputResistance} Ohm`,
      ];
      // Surface DC-OP diagnostics like circuit_dc_op (simulation-tools.ts:331-341).
      for (const d of r.diagnostics) lines.push(`    [${d.severity}] ${d.code}: ${d.message}`);
      return lines.join("\n");
    },
  ),
);
```

Per the Three-Surface Testing Rule (`CLAUDE.md`), the implementer accompanying
tests (authored against this spec, not in this pass) cover all three surfaces: a
headless `DefaultSimulatorFacade.transferFunction()` test, a `circuit_tf`
MCP-handler test, and an E2E/parity test exercising the postMessage/UI path if
`.tf` is surfaced there.

## Ratification items

- **R-1 — engine re-solve boundary. RESOLVED = generic `reSolveFactored(rhs)`.**
  The public re-solve-against-the-factored-DC-matrix surface is a reusable engine
  primitive `reSolveFactored(rhs)`: re-solve the post-DC-OP factored matrix with a
  caller-supplied RHS (one forward/back-substitution against the existing LU, no
  re-factor). The `.tf` driver (`transferFunction()`) consumes `reSolveFactored`
  rather than reaching `ctx.solver.solve()` directly, and a future `.sens` shares
  the same primitive. The driver (Part B) is unchanged in behavior either way; the
  boundary is now settled on the generic primitive.
- **R-2 — no transpose-solve. RESOLVED = follow `tfanal.c`, no transpose.** This
  is settled fact: `tfanal.c:87, 150` call `SMPsolve` on the same `ckt->CKTmatrix`
  with a shifted RHS — no transpose, no adjoint. `TFanal` solves the same factored
  system J x = e with a unit RHS e injected at the input port, then again at the
  output port. The authoring brief's "transpose-solve for the adjoint" wording was
  wrong. The solver has no transpose entry point (`sparse-solver.ts:784`), and none
  is needed. This spec correctly follows `tfanal.c` (RHS injection, no transpose);
  no transpose surface is required.
- **R-3 — label-to-branch-row map. RESOLVED = full I/O via the existing branch
  registry + thin accessor.** Voltage-source-input and current-output paths need
  `CKTfndBranch` (`tfanal.c:82, 116`), and digiTS HAS the analogue: `ctx.findDevice`
  (`src/core/mna-subcircuit-netlist.ts:11` documents it as "the ngspice
  CKTfndBranch / CKTfndDev analogues"), with branch rows allocated per-label via
  `ctx.makeCur(label, "branch")` (e.g.
  `src/solver/analog/behavioral-drivers/bridge-output-driver.ts:112`). So the recon
  resolves source labels to branch rows through the EXISTING makeCur/findDevice
  branch registry. `CompiledAnalogCircuit` exposes `labelToNodeId`
  (`analog-engine-interface.ts:314`) but no public label→branch-row accessor, so the
  recon adds a THIN accessor over that existing registry — it does NOT invent a new
  mechanism. Full I/O is therefore IN this recon: the voltage-source-input and
  current-output paths are no longer deferred; they ship alongside the node-pair
  (current-source-input / voltage-output) paths.

## Acceptance criteria

1. A `runTransferFunction(ctx, port)` driver exists co-located with
   `solveDcOperatingPoint` in `dc-operating-point.ts`, performing the two
   RHS-injection re-solves against the **already-factored** DC Jacobian exactly
   per `tfanal.c:73-157` — including the `rhs[0]=0` after each solve
   (`tfanal.c:88, 151`), the Pos−Neg transfer-ratio vs Neg−Pos output-resistance
   node ordering (`tfanal.c:113-114` vs `:153-154`), the `-1/i` input-resistance
   with the `1e-20`/`1e20` clamp (`tfanal.c:125-129`), the `MAX(1e-20,…)`
   current-output resistance (`tfanal.c:156`), and the
   output==input-source-current shortcut (`tfanal.c:132-139`). No re-factor occurs
   between the DC-OP solve and the two `.tf` re-solves.
2. `TfResult` carries `transferFunction` / `inputResistance` / `outputResistance`
   mapping to outputs[0] / [1] / [2] (`tfanal.c:113-156`).
3. `AnalogEngine.transferFunction(params: TfParams): TfResult` is declared
   (`analog-engine-interface.ts`) and implemented on `MNAEngine`, running the
   DC-OP-then-re-solve sequence (Part D). The re-solve goes through the generic
   `reSolveFactored(rhs)` engine primitive (R-1 RESOLVED): the driver calls
   `reSolveFactored` rather than `ctx.solver.solve()` directly, and the primitive
   re-solves the post-DC-OP factored matrix with the caller-supplied RHS without
   re-factoring.
4. `SimulatorFacade.transferFunction()` is declared (`facade.ts`) and implemented
   on `DefaultSimulatorFacade` (`default-facade.ts`), delegating to the
   coordinator, with a `supportsTf()` guard parallel to `supportsDcOp()` /
   `supportsAcSweep()`.
5. A `circuit_tf` MCP tool is registered (`simulation-tools.ts`) with
   `{ handle, inputSource, output }` inputs, mirroring the `circuit_dc_op` /
   `circuit_ac_sweep` registration shape, and surfacing the three scalars plus
   DC-OP diagnostics.
6. The feature is tested across all three surfaces per the Three-Surface Testing
   Rule: (1) headless facade `coordinator.transferFunction` and (2) the
   `circuit_tf` MCP handler — both in `scripts/mcp/__tests__/circuit-tf.test.ts`;
   (3) the paired-ngspice bit-exact gate in
   `src/solver/analog/__tests__/ngspice-parity/tf-parity.test.ts`. `.tf` is an
   agent/headless analysis and is **not** surfaced through the postMessage adapter
   or the UI, so there is no Playwright/postMessage surface to exercise; the
   paired-ngspice parity test is the third surface (full DLL-paired stack).
7. With `analysis#recon/tf` `APPLIED`, the two blocked v41 hunks
   `analysis/tfanal.c#h001` (`GENnode(ptr)[0]/[1]` accessor form for the
   current-source RHS injection, `analysis.md` diff at `tfanal.c:78-84`) and
   `analysis/tfanal.c#h002` (`GENnode(ptr)[1]-[0]` accessor form for the
   current-input resistance, `tfanal.c:119-126`) apply onto the rebuilt driver as
   ordinary per-hunk deltas — both are the GENnode1/GENnode2 to GENnode(ptr)[…]
   accessor rename over the current-source node-pair access this recon already
   builds. `build-ledger.mjs` re-runs cleanly with `analysis#recon/tf` `APPLIED`
   and the two hunks unblocked.
8. **Paired-ngspice scalar comparison (not the per-iteration divergence chain).**
   `.tf` produces three scalars from two re-solves over the factored Jacobian —
   it has no NR iterations or transient steps, so the `harness_first_divergence`
   / `harness_get_attempt` model (built for stepped/iterated analyses) does not
   represent it. The gate instead compares digiTS's three `.tf` scalars against
   the ngspice DLL's `outputs[0..2]` directly:
   - the ngspice bridge gains a `tf` analysis kind (`NgspiceJobAnalysis`,
     ngspice-bridge.ts) that issues `tf <output> <insrc>` and captures
     `outputs[0..2]` bit-exact through a `tf_register` instrumentation hook fired
     at the `tfanal.c` `done:` label (mirrors the `ni_*_register` hooks). No plot
     round-trip, no vector-name parsing.
   - `ComparisonSession.runTf({ inputSource, output, ngOutput })` runs both sides
     (ours via `coordinator.transferFunction`, ngspice via the guarded worker) and
     `tfCompare()` returns per-scalar `absDelta` + `maxAbsDelta`.
   - The gate fixture is the existing
     `src/solver/analog/__tests__/ngspice-parity/fixtures/resistive-divider.dts`
     (V1=5, R1=R2=1k). A voltage-input / node-pair-output `.tf` gives transfer 0.5,
     Rin 2kΩ, Rout 500Ω; a voltage-input / source-current-output `.tf` (`I(V1)`)
     exercises the same-source shortcut (tfanal.c:132-139, Rout = Rin). Both match
     the ngspice DLL `.tf` `maxAbsDelta === 0` — bit-exact, no tolerance qualifier.
   (`vcvs-gate.dts` is unsuitable as a `.tf` reference: its DC-OP raises a
   competing-voltage-constraints error, so it is not a clean controlled-source
   net; the current-output shortcut path covers the second code path instead.)

Status: RATIFIED 2026-05-30 (user). R-1 = generic reSolveFactored(rhs); R-2 = follow tfanal.c (no transpose); R-3 = full I/O via existing ctx.findDevice/makeCur branch registry + thin label→branch accessor.

## As-built reconciliation (2026-06-04)

This recon is **APPLIED and verified**, not pending. The driver and all five
production surfaces (Parts B–E) were built by a prior pass and are present today:
`runTransferFunction` (dc-operating-point.ts), `reSolveFactored` /
`transferFunction` on `MNAEngine`, `TfParams`/`TfResult` +
`AnalogEngine.transferFunction` (src/core/analog-engine-interface.ts), the
facade/coordinator `transferFunction` + `supportsTf`, and the `circuit_tf` MCP
tool. The verification layer (acceptance #6, #8) was added in the 2026-06-04 pass:
the harness `tf` bridge mode + `ComparisonSession.runTf`, the Surface-1/2 tests
(scripts/mcp/__tests__/circuit-tf.test.ts) and the Surface-3 paired parity test
(ngspice-parity/tf-parity.test.ts).

One real defect was found and fixed during verification: `transferFunction`
originally ran the **standalone `.op`** DC-OP (`MNAEngine.dcOperatingPoint`), whose
`dcopFinalize` smsig `CKTload` (dcop.c:153) **un-factors** the matrix — so the two
`.tf` re-solves hit the `IS_FACTORED` assertion. ngspice's `TFanal` calls bare
`CKTop` (tfanal.c:44), not `DCop`; the smsig load is `.op`-only. The fix extracts
the CKTop ladder into a shared `MNAEngine._runDcOpLadder()` (leaves the matrix
factored); `dcOperatingPoint()` (`.op`) and `AcAnalysis` (`ACan`) append
`dcopFinalize` themselves, while `_transientDcop` (`DCtran`) and `transferFunction`
(`TFanal`) consume the bare ladder. This corrects the spec's Part-D assumption:
the claim that "AC analysis already relies on the post-DC-OP factored state"
(in "Current digiTS state" / Part D above) is **wrong** — AC re-stamps and
re-factors its own complex matrix per frequency (`solver._resetForAssembly()`,
ac-analysis.ts:390), so `.tf` is the first real consumer of the factored-matrix
invariant.

Per the no-tolerance bar, acceptance #8 was re-specified above from the
inapplicable per-iteration `harness_first_divergence` chain to a paired-ngspice
**scalar** comparison (`ComparisonSession.runTf` / `tfCompare`, `maxAbsDelta === 0`).
The ledger STALE→APPLIED flip + `tfanal.c#h001/h002` unblock is the port-loop
driver's job (do not hand-edit the state field).
