# ngspice Comparison Harness — How To Use

## Purpose

The harness captures **per-NR-iteration** internal state from both our engine and ngspice, enabling side-by-side comparison of node voltages, branch currents, device states, and convergence behavior. This is the **primary tool** for diagnosing numerical discrepancies.

## What You Get Per Iteration

| Data | Our Engine | ngspice |
|------|-----------|---------|
| Node voltages (all nodes) | `IterationSnapshot.voltages` | `CKTrhs` via callback |
| Previous iteration voltages | `IterationSnapshot.prevVoltages` | `CKTrhsOld` via callback |
| RHS vector | `IterationSnapshot.rhs` | Not available |
| Matrix entries | `IterationSnapshot.matrix` | Not available |
| Device state vector | `IterationSnapshot.elementStates` | `CKTstate0` (full vector) |
| noncon counter | `IterationSnapshot.noncon` | From callback |
| Convergence flag | `IterationSnapshot.globalConverged` | From callback |

## Prerequisites

1. **ngspice DLL** built from `ref/ngspice/visualc-shared/sharedspice.sln` in Visual Studio (Release x64). The instrumented `niiter.c` fires a callback per NR iteration.
2. **koffi** npm package: `npm install koffi`
3. DLL path: set `NGSPICE_DLL_PATH` env var or use the default path `ref/ngspice/visualc-shared/x64/Release/bin/spice.dll`.

## Quick Start — Comparison Test

```typescript
import { NgspiceBridge } from './harness/ngspice-bridge.js';
import { createIterationCaptureHook } from './harness/capture.js';
import type { MNAEngine } from '../analog-engine.js';

// --- ngspice side ---
const bridge = new NgspiceBridge(process.env.NGSPICE_DLL_PATH!);
await bridge.init();
bridge.loadNetlist(`* My circuit
V1 1 0 DC 10
R1 1 2 1k
R2 2 0 1k
.end`);
bridge.runDcOp();
// or: bridge.runTran('100n', '5n');
const ngSession = bridge.getCaptureSession();

// ngSession.steps[i].iterations[j].voltages = per-iteration node voltages
// ngSession.steps[i].iterations[j].noncon = convergence counter

bridge.dispose();

// --- Our engine side ---
const engine = coordinator.getAnalogEngine() as MNAEngine;
const { hook, getSnapshots, clear } = createIterationCaptureHook(
  engine.solver!, engine.elements, engine.statePool,
);
engine.postIterationHook = hook;

coordinator.step();
const snapshots = getSnapshots(); // per-iteration data
clear();
```

## Matching Nodes Between Engines

ngspice and our engine have **different matrix sizes** because:
- ngspice includes BJT internal nodes (B', C', E') when base/collector/emitter resistance > 0
- ngspice includes branch rows for current-sense voltage sources (Vic_npn, Vic_pnp, Vdiode in buckbjt.cir)
- Our engine may collapse internal nodes when resistance = 0

To match nodes, compare converged DC OP voltages and identify corresponding values (e.g., VCC=10V appears in both). The SPICE netlist node names help: `v(col_npn)`, `v(base_npn)`, etc.

## Device State Comparison

The `device-mappings.ts` file maps our state pool slot names to ngspice `CKTstate0` offsets:

```typescript
import { DEVICE_MAPPINGS } from './harness/device-mappings.js';
// DEVICE_MAPPINGS.BJT maps slots like 'VBE', 'VBC', 'GM', 'GO', etc.
// to ngspice state0 offsets
```

ngspice's `state0` is a flat array containing all device states. The offset for each device depends on its position in the circuit. Use known values (e.g., VBE ≈ 0.7V for a forward-biased BJT) to locate the device's state block within the array.

## Running Tests

```bash
# With env var
NGSPICE_DLL_PATH=ref/ngspice/visualc-shared/x64/Release/bin/spice.dll \
  npx vitest run src/solver/analog/__tests__/buckbjt-ngspice-compare.test.ts

# Or set permanently in .env
```

## Existing Test Files

- `ngspice-bridge-smoke.test.ts` — basic bridge verification (voltage divider)
- `buckbjt-ngspice-compare.test.ts` — DC OP + transient comparison for buckbjt
- `buckbjt-nr-probe.test.ts` — our engine only, detailed per-iteration dump

## SPICE Netlist Tips

- Load netlists via `bridge.loadNetlist(spiceText)` — uses `circbyline` internally
- Remove `.control`/`.endc` blocks from netlists before loading
- The `.tran` line in the netlist is ignored; use `bridge.runTran('stopTime', 'maxStep')` instead
- DC OP: `bridge.runDcOp()`
- Multiple analyses: dispose and create a new bridge instance (ngspice global state)

## Limitations

- **No LTE estimates** from ngspice (callback is inside NIiter, not CKTtrunc)
- **No assembled matrix** from ngspice (only solution vectors)
- **One analysis per bridge instance** — dispose and re-create for multiple runs
- ngspice state0 offsets must be manually matched to devices using known operating point values
