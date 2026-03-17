# circuiTS Engine Specification

**Status:** Draft — Phases 0-4c specced in detail (see `spec/phase-0-interface-abstraction.md`, `spec/phase-1-mna-engine-core.md`, `spec/phase-2-tier-1-components.md`, `spec/phase-3-analog-ui-features.md`, `spec/phase-4a-digital-analog-interface.md`, `spec/phase-4b-two-engine-bridge.md`, `spec/phase-4c-transistor-level-models.md`)
**Date:** 2026-03-17
**Scope:** Analog simulation engine for the digiTS shell, porting and improving upon CircuitJS's MNA solver

## 1. Overview

circuiTS adds analog circuit simulation to the digiTS shell by implementing a Modified Nodal Analysis (MNA) engine as a pluggable alternative to the existing digital event-driven engine. The two engines coexist: the editor toggles between digital (.dts) and analog (.cts) modes, presenting the appropriate component palette and engine. Mixed-signal simulation is supported at the subcircuit boundary.

### Design Principles

1. **Engine-agnostic editor** — the analog engine plugs into the same editor shell via a parallel `AnalogEngine` interface; no editor code changes beyond mode switching
2. **Correct by default** — LTE timestep control, Gmin stepping, BDF-2 integration from day 1; no "toy simulator" compromises
3. **Diagnostics as pedagogy** — every solver fallback, failure, and anomaly produces a plain-language diagnostic with circuit-level attribution
4. **Sparse from day 1** — COO assembly → CSC format → symbolic factorization → numeric LU; no dense matrix path
5. **Level 2 device models** — junction capacitances, channel-length modulation, body effect; `.MODEL` import support for user-supplied parameters
6. **Symbol reuse** — ~20 existing digiTS component symbols reused directly; ~20 new analog-specific symbols

### Relationship to Existing Specs

- `spec/plan.md` — the digiTS implementation plan; circuiTS is a parallel effort that plugs into the same shell
- `spec/author_instructions.md` — TS idiom guide applies equally to circuiTS code
- `CLAUDE.md` — engine-agnostic architecture constraint is the foundation this spec builds on

---

## 2. AnalogEngine Interface

**Decision (Phase 0 spec):** `AnalogEngine` extends a new `Engine` base interface extracted from `SimulationEngine`. The hierarchy is: `Engine` (lifecycle) → `SimulationEngine extends Engine` (digital) / `AnalogEngine extends Engine` (analog). `SimulationEngine` keeps its name to avoid a 25-file rename; the class `DigitalEngine` implements it. The analog class `MNAEngine` implements `AnalogEngine`. Both are assignable to `Engine`, enabling the mixed-signal coordinator (Phase 4) to hold either type.

The editor selects which interface to use based on circuit metadata (`engineType: "digital" | "analog"`), toggled via the Edit menu.

### Contract

```typescript
interface AnalogEngine {
  // --- Lifecycle ---
  /** Load a compiled analog circuit. */
  load(circuit: CompiledAnalogCircuit): void;

  /** Find DC operating point. Emits diagnostics on fallback/failure. */
  dcOperatingPoint(): DcOpResult;

  /** Advance transient simulation by one adaptive timestep. */
  step(): void;  // Returns void to match Engine base interface; read lastDt/simTime after.

  /** Reset to initial conditions or DC operating point. */
  reset(): void;

  /** Current simulation time in seconds. */
  readonly simTime: number;

  /** Last accepted timestep in seconds. */
  readonly lastDt: number;

  // --- Breakpoints (for mixed-signal coordination and source discontinuities) ---
  /** Register a time at which the timestep controller must land a step exactly. */
  addBreakpoint(time: number): void;
  /** Remove all registered breakpoints. */
  clearBreakpoints(): void;

  // --- State Access ---
  /** Node voltage (floating-point). */
  getNodeVoltage(nodeId: number): number;

  /** Branch current through a voltage source or inductor. */
  getBranchCurrent(branchId: number): number;

  /** Instantaneous current through any two-terminal element. */
  getElementCurrent(elementId: number): number;

  /** Instantaneous power dissipated by an element. */
  getElementPower(elementId: number): number;

  // --- Configuration ---
  /** Simulation parameters (timestep bounds, tolerances, integration method). */
  configure(params: Partial<SimulationParams>): void;

  // --- Diagnostics ---
  /** Register callback for solver diagnostics. */
  onDiagnostic(callback: (diag: SolverDiagnostic) => void): void;

  // --- Analysis (day 1: dcOP + transient; stubs for future) ---
  /** Run AC small-signal analysis. Stub — throws 'not implemented' until v2. */
  acAnalysis?(params: AcParams): AcResult;
}
```

### SimulationParams

```typescript
interface SimulationParams {
  maxTimeStep: number;          // seconds, default 5e-6
  minTimeStep: number;          // seconds, default 1e-14
  reltol: number;               // relative convergence tolerance, default 1e-3
  abstol: number;               // absolute voltage tolerance, default 1e-6
  chargeTol: number;            // charge tolerance for LTE, default 1e-14
  maxIterations: number;        // NR iterations before declaring failure, default 100
  integrationMethod: 'auto' | 'trapezoidal' | 'bdf1' | 'bdf2';  // default 'auto'
  gmin: number;                 // minimum conductance, default 1e-12
}
```

### DcOpResult

```typescript
interface DcOpResult {
  converged: boolean;
  method: 'direct' | 'gmin-stepping' | 'source-stepping';
  iterations: number;
  nodeVoltages: Float64Array;
  diagnostics: SolverDiagnostic[];
}
```

---

## 3. Sparse Solver

### Architecture

```
Component stamp calls           Symbolic analysis          Numeric factorization
─────────────────────          ──────────────────          ────────────────────
stamp(row, col, val) ──→ COO triplet list ──→ CSC matrix ──→ AMD ordering ──→
                                                             symbolic LU pattern ──→
                                                             numeric LU values ──→
                                                             forward/back solve
```

### API

```typescript
interface SparseSolver {
  /** Begin a new matrix assembly. Clears triplet list. */
  beginAssembly(size: number): void;

  /** Add value to matrix position (row, col). Accumulates duplicates. */
  stamp(row: number, col: number, value: number): void;

  /** Add value to RHS vector. */
  stampRHS(row: number, value: number): void;

  /** Finalize assembly: COO → CSC, run symbolic analysis if topology changed. */
  finalize(): void;

  /** Numeric LU factorization of the current matrix values. */
  factor(): FactorResult;

  /** Solve Ax = b using the current factorization. Writes solution into x. */
  solve(x: Float64Array): void;

  /** Mark topology as changed (forces re-symbolize on next finalize). */
  invalidateTopology(): void;
}

interface FactorResult {
  success: boolean;
  conditionEstimate?: number;  // rough condition number for diagnostic use
  singularRow?: number;        // if singular, which row
}
```

### Implementation Notes

- **COO → CSC conversion**: sort triplets by column, then row; sum duplicates. ~50 LOC.
- **AMD ordering**: Approximate Minimum Degree. Reduces fill-in during factorization. Well-known algorithm, ~200 LOC or use a published TS implementation.
- **Symbolic factorization**: determine nonzero pattern of L and U factors without computing values. Runs once per topology change. ~100 LOC.
- **Numeric factorization**: fill in values using the symbolic pattern. Runs every NR iteration for nonlinear circuits, once per timestep for linear. ~150 LOC.
- **Partial pivoting**: for numerical stability. Track permutation vector alongside symbolic pattern.

### Performance Targets

| Circuit size | Symbolic (once) | Numeric factor | Solve | Memory |
|-------------|----------------|----------------|-------|--------|
| 50 nodes | < 0.1ms | < 0.05ms | < 0.02ms | ~10KB |
| 200 nodes | < 0.5ms | < 0.2ms | < 0.1ms | ~80KB |
| 1000 nodes | < 5ms | < 2ms | < 1ms | ~500KB |

---

## 4. Integration Methods

### Supported Methods

| Method | Order | Damping | Use Case |
|--------|-------|---------|----------|
| Backward Euler (BDF-1) | 1 | Heavy | Startup (first 2 timesteps), stiff switching |
| Trapezoidal | 2 | None | Smooth regions, best accuracy/cost |
| BDF-2 (Gear order 2) | 2 | Moderate | Stiff circuits, switching transients |

### Companion Model Coefficients

For a capacitor C with timestep h:

| Method | Conductance (geq) | History current (ieq) |
|--------|-------------------|----------------------|
| BDF-1 | C / h | -geq * v(n) |
| Trapezoidal | 2C / h | -geq * v(n) - i(n) |
| BDF-2 | 3C / (2h) | -geq * (4/3 * v(n) - 1/3 * v(n-1)) |

Inductor L: same pattern with L replacing C, voltage/current roles swapped.

### Auto-Switching Logic

Default mode (`integrationMethod: 'auto'`):
1. Start with BDF-1 for first 2 accepted timesteps (suppress startup transients)
2. Switch to trapezoidal for smooth simulation
3. Detect trap ringing: if a reactive element's voltage alternates sign across 3 consecutive timesteps, switch to BDF-2 for that element
4. After 5 consecutive non-oscillating steps on BDF-2, switch back to trapezoidal

Ringing detection runs once per accepted timestep, not per NR iteration. Cost: one sign comparison per reactive element.

### History Storage

BDF-2 requires v(n) and v(n-1) per reactive element. Storage: two `Float64Array` vectors, length = number of reactive elements. Rotated (pointer swap, no copy) each timestep.

---

## 5. LTE Timestep Control

### Algorithm

After each accepted timestep, estimate local truncation error for every reactive element:

```
For trapezoidal:  LTE ≈ (h³/12) * d³q/dt³  ≈  (1/12) * (q(n+1) - q_predicted)
For BDF-2:        LTE ≈ (2h³/9) * d³q/dt³
```

Where q is charge (capacitor) or flux (inductor), and q_predicted uses the previous timestep's derivative extrapolation.

Compute the ratio: `r = tolerance / max(LTE across all elements)`

New timestep: `h_new = h * min(2.0, max(0.5, 0.9 * r^(1/3)))`

- Factor of 0.9: safety margin
- Clamp to [0.5h, 2h]: prevent wild jumps
- Clamp to [minTimeStep, maxTimeStep]: hard bounds

### Timestep Rejection

If `r < 1` (error exceeds tolerance), reject the timestep:
1. Halve h
2. Restore state to beginning of timestep
3. Retry with new h
4. If h < minTimeStep, emit diagnostic and accept anyway with warning

### Diagnostic Attribution

When LTE forces a timestep reduction, record which element had the largest error. Surface this in diagnostics: "Timestep reduced to {h} at t={t} — {element label} is changing rapidly."

---

## 6. Convergence Stack

### Newton-Raphson Core

```
for iteration = 1 to maxIterations:
    1. Stamp all linear elements (R, companion models)
    2. Stamp all nonlinear elements at current operating point
       (linearized conductance + current source)
    3. Factor and solve matrix
    4. Apply voltage limiting (pnjlim for diodes/BJTs, fetlim for MOSFETs)
    5. Check convergence:
       - |v_new - v_old| < abstol + reltol * |v_new|  for every node
       - Element-specific checks (diode/BJT report via converged flag)
    6. If converged, accept. If not, update operating points, loop.
```

### Voltage Limiting

Prevents exponential runaway during NR iteration:

- **pnjlim** (diodes, BJT junctions): if voltage step > 2*Vt, compress logarithmically. Clamp to Vcrit = Vt * ln(Vt / (Is * sqrt(2))). ~10 LOC.
- **fetlim** (MOSFETs): clamp Vgs change to 0.5V per iteration when above threshold. ~10 LOC.

### Fallback Stack

If NR fails to converge within maxIterations:

**Level 1: Gmin Stepping** (DC operating point only)
1. Add gmin_large (1e-2) conductance from every node to ground
2. Solve
3. Reduce gmin by 10× steps: 1e-2 → 1e-3 → ... → 1e-12
4. At each step, use previous solution as initial guess
5. If all steps converge, accept final solution
6. Emit diagnostic: code `dc-op-gmin`, severity `info`

**Level 2: Source Stepping** (DC operating point only)
1. Scale all independent sources to 0
2. Solve (trivial — all zeros)
3. Ramp sources: 10% → 20% → ... → 100%
4. At each step, solve using previous as initial guess
5. Emit diagnostic: code `dc-op-source-step`, severity `warning`

**Level 3: Failure**
- Emit diagnostic: code `dc-op-failed` or `convergence-failed`, severity `error`
- Include blame attribution: which element, which node, what voltage range was oscillating

### Blame Tracking

The solver maintains per-NR-iteration metadata:

```typescript
interface ConvergenceTrace {
  /** Element whose stamp changed most between iterations. */
  largestChangeElement: number;
  /** Node with largest voltage delta. */
  largestChangeNode: number;
  /** Whether voltage at that node is oscillating (alternating sign). */
  oscillating: boolean;
  /** Current NR iteration count. */
  iteration: number;
  /** Which fallback level is active. */
  fallbackLevel: 'none' | 'gmin' | 'source-step';
}
```

---

## 7. Diagnostic API

### Structure

```typescript
interface SolverDiagnostic {
  code: SolverDiagnosticCode;
  severity: 'info' | 'warning' | 'error';

  // Plain language — what happened + why + what to do
  summary: string;
  explanation: string;
  suggestions: DiagnosticSuggestion[];

  // Machine-readable attribution (for schematic highlighting)
  involvedNodes?: number[];
  involvedElements?: number[];
  simTime?: number;

  // Numerical context (for advanced users / debugging)
  detail?: Record<string, number | string>;
}

type SolverDiagnosticCode =
  // DC operating point
  | 'dc-op-converged'
  | 'dc-op-gmin'
  | 'dc-op-source-step'
  | 'dc-op-failed'
  // Transient convergence
  | 'timestep-reduced'
  | 'timestep-at-minimum'
  | 'convergence-slow'
  | 'convergence-failed'
  // Integration
  | 'trap-ringing-detected'
  | 'method-switch'
  // Topology
  | 'singular-matrix'
  | 'voltage-source-loop'
  | 'floating-node'
  | 'inductor-loop'
  // Model
  | 'model-param-ignored'
  | 'model-level-unsupported';

interface DiagnosticSuggestion {
  text: string;
  /** Can the UI offer a one-click fix for this? */
  automatable: boolean;
  /** If automatable, what patch operation would fix it. */
  patch?: PatchOp;
}
```

### Emission Points

| Solver phase | Possible diagnostics |
|-------------|---------------------|
| Topology analysis (at compile) | `singular-matrix`, `voltage-source-loop`, `floating-node`, `inductor-loop` |
| DC operating point | `dc-op-converged`, `dc-op-gmin`, `dc-op-source-step`, `dc-op-failed` |
| NR iteration (transient) | `convergence-slow`, `convergence-failed` |
| Timestep control | `timestep-reduced`, `timestep-at-minimum` |
| Integration method | `trap-ringing-detected`, `method-switch` |
| Model loading | `model-param-ignored`, `model-level-unsupported` |

### Requirements

1. Every diagnostic MUST include circuit-level attribution (which element/node) — not just matrix row numbers
2. Every `error`-severity diagnostic MUST include at least one suggestion
3. Suggestions SHOULD be actionable by a student who does not know linear algebra
4. Numerical detail (iteration counts, voltage values, matrix condition) is available in the `detail` field for advanced users but MUST NOT appear in `summary` or `explanation`
5. Diagnostic messages are authored during implementation, not in this spec — but the structure and attribution machinery is load-bearing and must be built into the solver from day 1

---

## 8. Device Model Infrastructure

### Model Storage

```typescript
interface DeviceModel {
  name: string;
  type: 'NPN' | 'PNP' | 'NMOS' | 'PMOS' | 'NJFET' | 'PJFET' | 'D';
  level: 1 | 2;
  params: Record<string, number>;
}
```

### Built-in Models

The engine ships with sensible defaults for each device type at Level 2. These serve as fallbacks when no `.MODEL` is specified.

### .MODEL Import

Parser accepts standard SPICE `.MODEL` syntax:

```
.MODEL <name> <type> (<param>=<value> ...)
```

On import:
1. Parse parameters into `Record<string, number>`
2. Validate against known parameter names for the device type
3. For unknown parameters: store but flag with `model-param-ignored` diagnostic, explaining which physical effect the parameter controls and why it's not modeled
4. For Level 3+ model cards: emit `model-level-unsupported` diagnostic, simulate using Level 2 equations with whatever Level 2 parameters are present

### Level 2 Parameter Sets

**Diode** (14 parameters):
IS, N, RS, BV, IBV, CJO, VJ, M, TT, EG, XTI, KF, AF, FC

**BJT** (26 parameters):
IS, BF, NF, VAF, IKF, ISE, NE, BR, NR, VAR, IKB, ISC, NC, RB, RE, RC, CJE, VJE, MJE, CJC, VJC, MJC, TF, TR, XTF, ITF

**MOSFET Level 2** (25 parameters):
VTO, KP, LAMBDA, PHI, GAMMA, CBD, CBS, CGSO, CGDO, CGBO, RSH, IS, JS, PB, MJ, MJSW, TOX, LD, U0, UTRA, VMAX, XJ, NSUB, NEFF, TPG

**JFET** (12 parameters):
VTO, BETA, LAMBDA, IS, RD, RS, CGS, CGD, PB, FC, KF, AF

### Component ↔ Model Binding

Each analog component instance can reference a model by name. If no model is specified, the built-in default is used. Multiple instances can share a model.

---

## 9. Digital-Analog Interface Layer

### Unified Pin Electrical Model

Every digital component pin has an analog equivalent circuit that manifests when the pin participates in an analog context. The model is a **shared primitive** used by behavioral stamps (individual digital components in MNA), two-engine bridge adapters (subcircuit boundaries), and digital-in-analog components (Phase 6).

**Output pin analog equivalent:**

| Digital State | Analog Model | Default (CMOS 3.3V) |
|---|---|---|
| Output HIGH | Norton source: conductance 1/R_out + current V_OH/R_out, plus C_out companion | 3.3V, 50Ω, 5pF |
| Output LOW | Norton source: conductance 1/R_out + current V_OL/R_out, plus C_out companion | 0.0V, 50Ω, 5pF |
| Output Hi-Z | Conductance 1/R_HiZ to ground (voltage source disconnected) | 10MΩ |

**Input pin analog equivalent:**

| Analog Model | Purpose | Default (CMOS 3.3V) |
|---|---|---|
| R_in to ground | Input loading on analog source | 10MΩ |
| C_in companion | Input capacitance | 5pF |
| Threshold detector | V > V_IH → 1, V < V_IL → 0, between → hold previous | V_IH=2.0V, V_IL=0.8V |

Pin capacitances provide natural edge softening: a hard voltage switch through R_out + C_out produces a realistic RC transient without requiring a FET model at the boundary. Multi-bit digital signals crossing into analog are handled bit-by-bit (each bit gets its own pin model); explicit DAC/ADC components are separate user-placed components with real internal behavior.

### Logic Family Configuration

Default pin electrical parameters come from a circuit-level **logic family** setting with named presets:

| Family | VDD | V_OH | V_OL | V_IH | V_IL | R_out | R_in | C_in | C_out | R_HiZ |
|--------|-----|------|------|------|------|-------|------|------|-------|-------|
| CMOS 3.3V | 3.3 | 3.3 | 0.0 | 2.0 | 0.8 | 50Ω | 10MΩ | 5pF | 5pF | 10MΩ |
| CMOS 5V | 5.0 | 5.0 | 0.0 | 3.5 | 1.5 | 50Ω | 10MΩ | 5pF | 5pF | 10MΩ |
| TTL | 5.0 | 3.4 | 0.35 | 2.0 | 0.8 | 80Ω | 4kΩ | 5pF | 5pF | 10MΩ |

**Parameter cascade:** pin override > component override > circuit logic family > default (CMOS 3.3V). VDD is easily set in the circuit metadata; thresholds and margins are configurable in a settings editor.

### Simulation Modes

Every digital component can operate in one of three modes when placed in an analog context. The mode is a per-component property, user-selectable:

| Mode | Internal Model | When to Use |
|------|---------------|-------------|
| **Behavioral** (default) | Truth table + pin electrical model in MNA | Individual components or small groups in analog circuits |
| **Digital (bridged)** | Separate digital engine + pin model as bridge | Large digital subcircuits where MNA overhead is prohibitive |
| **Transistor-level** | Expands to MOSFET subcircuit, no pin model wrapper | Teaching transistor-level design, physical accuracy |

Defaults follow circuit structure: individual components in analog circuits default to behavioral; digital-engine subcircuits embedded in analog circuits default to bridged. The user can override any component's mode in its property panel.

### Mixed-Signal Architecture (Bridged Mode)

```
analog circuit (MNA engine)
  │
  ├── analog components (MNA stamps)
  ├── behavioral digital components (pin model + truth table in MNA)
  │
  └── embedded digital subcircuit (bridged)
        │
        ├── pin electrical model (stamped into outer MNA)
        │     ├── output pins: Norton equivalent + C_out
        │     └── input pins: R_in + C_in + threshold detector
        │
        └── digital components (separate digital engine)
              └── (can embed analog subcircuits recursively)
```

### Timing Synchronization (Bridged Mode)

Event-driven with breakpoints:
- The outer engine drives simulation time
- When a digital output changes state, the bridge registers a breakpoint via `addBreakpoint()` so the analog timestep controller lands exactly on the transition
- The voltage source hard-switches; pin capacitance provides natural edge softening
- For analog outer → digital inner: the analog engine detects threshold crossings on digital input pins and evaluates the digital subcircuit at the crossing time
- For digital outer → analog inner: the analog subcircuit is stepped to the current simulation time before the outer engine reads its outputs

### File Format

- `.dts` — unified digiTS circuit file (renamed from `.digb`). Both digital and analog circuits use the same JSON format; `metadata.engineType` distinguishes them.
- Embedded subcircuits are referenced by path or inline, same as existing digiTS subcircuit mechanism

---

## 10. Analog-Specific UI Features

These features are tied to the analog engine's continuous-value state. They register as UI plugins when the analog engine is active and deregister when switching to digital mode.

### 10.1 Current Flow Visualization

**What:** Animated dots moving along wires and through components, speed proportional to current magnitude, direction matches conventional current flow.

**Engine requirement:** `getElementCurrent(elementId)` per element, called once per render frame.

**Rendering:** Dots are drawn as small circles on the wire path. Position advances by `current * scale * dt_render` per frame. Dot density is constant; speed varies.

**Controls:**
- Toggle on/off (default: on in analog mode)
- Speed scale slider (log scale, affects visual speed without changing simulation)

### 10.2 Voltage Coloring

**What:** Wires and component leads colored on a continuous gradient based on node voltage.

**Engine requirement:** `getNodeVoltage(nodeId)` per node, called once per render frame.

**Color mapping:**
- Voltage range auto-scaled to [min_V, max_V] across circuit, or user-set range
- Gradient: red (most positive) → gray (ground) → green (most negative), matching CircuitJS convention
- Ground nodes: neutral gray

**Integration with editor:** Extends `WireSignalAccess` to return `{ value: number; type: 'analog' }`. The wire renderer uses a continuous color function instead of the discrete HIGH/LOW/Z mapping.

### 10.3 Power Dissipation Display

**What:** Optional overlay showing instantaneous power per element, either as text labels or heat-map coloring on component bodies.

**Engine requirement:** `getElementPower(elementId)` per element.

**Modes:**
- Off (default)
- Text labels (e.g., "47mW" next to resistor)
- Heat map (component body tinted yellow→orange→red by power)

### 10.4 Live Parameter Sliders

**What:** Drag a slider to change a component parameter in real-time while the simulation runs. The simulation updates continuously as the slider moves.

**Engine requirement:** ability to change a component's stamped value mid-simulation. For linear elements (R, C, L): re-stamp and re-factor. For nonlinear element model parameters: takes effect at next NR iteration.

**UX:**
- Right-click component → "Add slider"
- Slider appears in a panel below the canvas
- Slider range: defaults to 0.1× to 10× current value (log scale for R, L, C; linear for voltages)
- Multiple sliders can be active simultaneously
- Slider position is not persisted in the circuit file (it's a runtime-only tool)

**Performance note:** changing a linear element's value only requires numeric re-factorization (not symbolic), since topology hasn't changed. This is fast — << 1ms for typical circuits.

### 10.5 Analog Scope / Waveform Viewer

Extends the existing timing diagram viewer with continuous-signal support.

**Shared architecture (reuse from digital timing diagram):**
- Time axis with zoom/pan
- Per-signal trace rows
- Trigger/cursor infrastructure
- Capture buffer (ring buffer of samples)

**Analog-specific additions:**
- Y-axis: continuous voltage/current with auto-ranging and grid lines
- Dual axis: voltage (left) and current (right) on same trace
- Rendered as polyline (not step function)
- Min/max envelope when zoomed out (capture min and max per pixel column)
- Optional FFT view (magnitude spectrum of selected trace)
- Measurement cursors: ΔV, ΔT, frequency, RMS, peak-to-peak

**Engine integration:** the scope captures `getNodeVoltage()` / `getBranchCurrent()` at every accepted timestep (not every NR iteration). The capture rate matches the simulation timestep, which varies — the scope must handle non-uniform time samples.

### 10.6 Probe Tooltip

**What:** Hover over a wire or component pin to see instantaneous voltage. Hover over a component body to see current and power.

**Engine requirement:** same as voltage coloring + current flow.

**UX:** tooltip appears after 200ms hover delay, shows:
- Wire/pin: "3.42V" (relative to ground)
- Component: "4.7mA, 22mW" (through and dissipated)
- Two pins on same component: "ΔV = 2.1V" (voltage across)

---

## 11. Component Tiering

### Tier 1 — Core Analog (MVP)

20 components. Target: engine + symbols + tests complete.

| # | Component | Symbol Source | Model Complexity |
|---|-----------|-------------|-----------------|
| 1 | Resistor | New (zigzag) | Linear stamp |
| 2 | Capacitor | New (plates) | Companion model (trap/BDF) |
| 3 | Inductor | New (coils) | Companion model (trap/BDF) |
| 4 | Potentiometer | New (resistor+arrow) | Two linear stamps |
| 5 | Diode | New (triangle+bar) | Shockley + N-R, Level 2 (CJ, TT) |
| 6 | Zener Diode | New (variant) | Shockley + reverse breakdown |
| 7 | LED | Reuse digiTS | Forward drop + color |
| 8 | NPN BJT | New (circle+arrow) | Gummel-Poon Level 2 (CJE, CJC, RB) |
| 9 | PNP BJT | New (variant) | Same, reversed polarity |
| 10 | N-MOSFET | New (gate/body/arrow) | 3-region Level 2 (LAMBDA, CBD, CBS, CGS, CGD) |
| 11 | P-MOSFET | New (variant) | Same, reversed |
| 12 | Op-Amp (ideal) | New (triangle ±) | High gain + saturation, N-R |
| 13 | DC Voltage Source | New (circle ±) | Voltage stamp |
| 14 | AC Voltage Source | New (circle ~) | Time-dependent voltage stamp |
| 15 | Current Source | New (circle →) | Current stamp |
| 16 | Ground | New (standard symbol) | Node-to-zero constraint |
| 17 | Wire | Reuse digiTS | Zero-resistance connection |
| 18 | Switch (SPST) | Reuse digiTS | Variable resistance (0 / 1e9) |
| 19 | Switch (SPDT) | Reuse digiTS | Same, two positions |
| 20 | Probe / Voltmeter | Reuse digiTS | Read-only (no stamp) |

### Tier 2 — Extended Analog

30 additional components. Post-MVP.

Passive+: Polarized Cap, Transformer, Tapped Transformer, Transmission Line, Fuse, Crystal, Memristor
Semiconductor+: N-JFET, P-JFET, SCR, Triac, Diac, Varactor, Tunnel Diode, NPN/PNP Darlington, Triode
Sources+: Clock, Square Wave, Sweep, Variable Rail, AM, FM, Noise
Active blocks: Analog Switch (SPST/SPDT), Schmitt Trigger (both), VCCS, VCVS, CCCS, CCVS
Sensors: NTC Thermistor, LDR, Spark Gap

### Tier 3 — Digital-in-Analog + Specialty

50+ components. These operate within the MNA engine using Phase 4a's pin electrical model (input impedance + capacitance + threshold detection, output impedance + capacitance + voltage source). Each component wraps a truth table or state machine inside the `BehavioralGateElement` / `BehavioralFlipflopElement` framework. Transistor-level alternatives are available for components that ship a `transistorModel` subcircuit.

Logic gates, flip-flops, counters, mux/demux, shift registers, 555, ADC/DAC, SRAM, custom logic, real op-amp (composite), OTA, comparator, optocoupler, audio I/O, DC motor, LED array, 7-segment.

### Shared Components (both engines)

These components exist in both digital and analog modes with different execution backends:

| Component | Digital Backend | Analog Backend |
|-----------|----------------|----------------|
| Switch (SPST/SPDT) | Binary state, instant | Variable resistance |
| LED | On/off by bit value | Forward voltage/current model |
| Relay | Digital coil/contact | Coil inductance + contact resistance |
| Fuse | Binary blown/intact | Thermal model |
| 7-Segment Display | Bit-per-segment | Voltage threshold per segment |
| Logic gates | Truth table evaluation | Voltage source output, threshold input |

---

## 12. File Formats

### .dts Format (Unified)

Single native JSON format for both digital and analog circuits (renamed from `.digb`). The `metadata.engineType` field (`"digital"` or `"analog"`) distinguishes circuit type. No separate `.cts` extension — one format, one loader.

Analog circuits additionally include:
- Component types drawn from the analog registry
- No `bitWidth` on wires (omitted or ignored)
- Model references: `properties.model: "2N2222"` referencing a `.MODEL` in the file's model library section
- `metadata.logicFamily`: logic family configuration for digital-analog pin interfaces

Format tag: `format: 'dts'`. Backward compatibility: files with `format: 'digb'` are accepted by the deserializer.

### .MODEL Import

Standalone `.model` / `.lib` / `.subckt` text files can be imported. Parsed at load time, added to the circuit's model library.

### CTZ URL Format

CircuitJS uses a compressed URL encoding for circuit sharing. A parser for this format will be ported from an existing project (code already available). This provides read-only import of CircuitJS circuits.

---

## 13. Implementation Phases

**Detailed specs for Phases 0-1 are in `spec/phase-0-interface-abstraction.md` and `spec/phase-1-mna-engine-core.md`.** Key architectural decisions made during spec work:

- **Interface hierarchy**: `Engine` (base) → `SimulationEngine` (digital) / `AnalogEngine` (analog). `SimulationEngine` name retained (25 import sites, zero functional gain from rename).
- **Component registration**: `ComponentDefinition` gains `analogFactory?: (nodeIds, branchIdx, props) => AnalogElement`. One registry, one definition type, two engine factories.
- **Engine type trichotomy**: `ComponentDefinition.engineType` is `"digital" | "analog" | "both"`. Pure digital components omit the field (defaults to `"digital"`). Pure analog components set `"analog"`. Shared components (switch, LED, probe, relay, fuse, 7-seg) set `"both"` — they provide both `executeFn` (digital) and `analogFactory` (analog), same visual symbol, same property definitions. `getByEngineType()` includes `"both"` in both palettes.
- **AnalogElement interface**: Separate `stamp()` (linear, once per NR solve) and `stampNonlinear?()` (every NR iteration). Reactive elements implement `updateCompanion?()`.
- **step() semantics**: `Engine.step()` returns void. `AnalogEngine` exposes `readonly simTime` and `readonly lastDt` as properties. Breakpoints (`addBreakpoint`/`clearBreakpoints`) enable Phase 4 coordination and source discontinuities.
- **File placement**: `src/analog/` for engine-level code (solver, assembler, models, expression parser). Analog components follow the digital pattern: `src/components/passives/`, `src/components/semiconductors/`, `src/components/sources/`, `src/components/active/`.
- **Runner**: Single `SimulationRunner` handles both engine types via `Engine` base.
- **Mode toggle**: Edit menu, writes `circuit.metadata.engineType`, swaps palette filter.
- **Sparse solver**: Built in-house (~500 LOC), referencing CSparse (Tim Davis). No external dependency.
- **Ground**: Explicit Ground component required. Missing ground emits diagnostic.
- **Wire in analog mode**: Wires are not analog components — the compiler merges connected wires into the same node (zero resistance, no matrix entry). Current flow visualization on wires uses a KCL resolver in the rendering layer (Phase 3): given component currents from the engine, the renderer walks the wire topology and propagates currents via Kirchhoff's Current Law. This keeps the solver clean and avoids numerical issues from huge conductances.
- **Analog component categories**: Four new `ComponentCategory` values: `PASSIVES` (R, C, L, pot), `SEMICONDUCTORS` (diode, zener, BJT, MOSFET), `SOURCES` (voltage, current, ground), `ACTIVE` (op-amp, OTA, comparator).

### Phase 0: Interface Abstraction (1-2 weeks)
- Define `AnalogEngine` interface in `src/core/`
- Add `engine: "digital" | "analog"` to circuit metadata
- Add engine factory to `SimulationRunner` (replace hardcoded `DigitalEngine`)
- Extend `WireSignalAccess` for continuous values
- Add analog `ThemeColor` entries for voltage gradient
- Editor mode toggle (palette swap, engine swap)

### Phase 1: MNA Engine Core (2-3 weeks)
- Sparse solver (COO → CSC → AMD → symbolic LU → numeric LU → solve)
- MNA matrix construction (node mapping, stamping API)
- Newton-Raphson iteration loop with voltage limiting (pnjlim, fetlim)
- Companion models for L, C (trapezoidal + BDF-1 + BDF-2, auto-switching)
- LTE timestep control
- DC operating point solver with Gmin stepping + source stepping fallback
- Diagnostic infrastructure (blame tracking, emission, callback)

### Phase 2: Tier 1 Components (6-8 weeks)
**Detailed spec: `spec/phase-2-tier-1-components.md`** — 6 waves, 15 tasks, 20 components.
- Infrastructure: `engineType: "both"`, new categories (PASSIVES, SEMICONDUCTORS, SOURCES, ACTIVE), `noOpAnalogExecuteFn`
- Linear elements: resistor, ground, DC voltage source, current source, probe (shared)
- Reactive elements: capacitor, inductor, potentiometer
- .MODEL parser, model library with built-in Level 2 defaults, compiler model binding
- Semiconductor devices: diode, zener, LED (shared), NPN/PNP BJT, N/P-MOSFET (with Level 2 models)
- Active blocks: ideal op-amp (5-terminal with saturation)
- AC voltage source (sine/square/triangle/sawtooth + expression mode)
- Switches SPST/SPDT (shared)
- Arithmetic expression parser (recursive descent, trig/exp/log, variable binding)

### Phase 3: Analog UI Features (3-4 weeks)
**Detailed spec: `spec/phase-3-analog-ui-features.md`** — 5 waves, 9 tasks.
- Voltage coloring: continuous red→gray→green gradient via computed `setRawColor()`, global auto-range with user override
- KCL wire-current resolver in editor layer + animated current flow dots
- Analog scope: new `AnalogScopePanel` with non-uniform sample buffer, polyline/envelope rendering, dual Y-axis
- FFT spectrum view: in-house radix-2 Cooley-Tukey (~60 LOC), Hann windowing, dB display
- Measurement cursors: ΔT, ΔV, frequency, RMS, peak-to-peak, mean with SI formatting
- Probe tooltip (hover for V/I/P with 200ms delay)
- Power dissipation display (text labels or heat-map overlay)
- Live parameter sliders (log-scale for R/C/L, linear for V/I, numeric re-factorization only)

### Phase 4a: Digital-Analog Interface Layer + Behavioral Stamps (2-3 weeks)
**Detailed spec: `spec/phase-4a-digital-analog-interface.md`** — 6 waves, 9 tasks.
- File format rename: `.digb` → `.dts` (unified format, `engineType` metadata distinguishes digital/analog)
- Logic family config: `LogicFamilyConfig` type + CMOS 3.3V/5V/TTL presets + `CircuitMetadata.logicFamily`
- Pin electrical spec: `PinElectricalSpec` on `ComponentDefinition` with resolution cascade (pin > component > circuit > default)
- `DigitalPinModel`: reusable MNA stamp helper for output pins (Norton source + R_out + C_out) and input pins (R_in + C_in + threshold)
- Behavioral combinational gates: parameterized `BehavioralGateElement` (NOT, AND, NAND, OR, NOR, XOR) as `AnalogElement` with truth table factory
- Behavioral D flip-flop: edge detection in `updateCompanion()` (once per accepted timestep, not per NR iteration)
- Simulation mode property: per-component `simulationMode: 'digital' | 'behavioral' | 'transistor'` toggle
- Compiler integration: analog compiler handles `engineType: "both"` components via `analogFactory`

### Phase 4b: Two-Engine Bridge (2-3 weeks)
**Detailed spec: `spec/phase-4b-two-engine-bridge.md`** — 4 waves, 5 tasks.
Depends on Phase 4a for pin model.
- `BridgeOutputAdapter` / `BridgeInputAdapter`: MNA elements using `DigitalPinModel`, driven by coordinator
- Selective flattening: `flattenCircuit()` returns `FlattenResult` with `crossEngineBoundaries` for cross-engine subcircuits
- Analog compiler bridge insertion: creates adapters, compiles inner digital circuit separately
- `MixedSignalCoordinator`: breakpoint-based timing sync, threshold crossing detection, digital engine stepping
- Bridge diagnostics: indeterminate input warning, oscillating input detection, impedance mismatch

### Phase 4c: Transistor-Level Models (1-2 weeks)
**Detailed spec: `spec/phase-4c-transistor-level-models.md`** — 3 waves, 3 tasks.
Depends on Phase 2 (MOSFET components). Parallel with Phase 4b.
- `expandTransistorModel()`: compiler expansion of components into transistor-level subcircuits
- CMOS gate models: inverter, NAND, NOR, AND, OR, XOR, buffer (standard CMOS topology)
- CMOS D flip-flop: transmission-gate master-slave design (~22 MOSFETs), exhibits real metastability
- `transistorModel` field on `ComponentDefinition`, `simulationMode: 'transistor'` toggle

### Phase 5: Tier 2 Components (4-6 weeks)
**Detailed spec: `spec/phase-5-tier-2-components.md`** — 8 waves, 25 tasks, 30+ components.
Depends on Phase 2 (Tier 1 components, expression parser). Many waves parallel.
- Passive extensions: polarized capacitor (ESR + leakage + polarity diagnostic), quartz crystal (Butterworth-Van Dyke model), analog fuse (I²t thermal model)
- Source waveform extensions: sweep, AM, FM, noise modes on AC source; variable rail source; analog clock factory
- Expression parser enhancements: `V(label)`, `I(label)`, `time` variable bindings; symbolic differentiation of AST for Jacobian computation
- Expression-driven controlled sources: VCVS, VCCS, CCVS, CCCS with arbitrary transfer functions via expression parser; symbolic Jacobian for NR convergence
- Shared FET base class: `AbstractFetElement` refactors Phase 2 MOSFETs, then N-JFET/P-JFET extend it (Shichman-Hodges model, 12 SPICE parameters)
- Thyristors: standalone SCR (alpha-dependent two-transistor model), triac (bidirectional), diac (breakover trigger)
- Exotic semiconductors: varactor (voltage-dependent junction capacitance), tunnel diode (NDR region with careful NR limiting), triode vacuum tube (Koren model)
- Coupled inductors + transformers: mutual inductance M = k·√(L₁·L₂), companion model cross-terms; two-winding transformer; center-tapped transformer (3×3 coupling matrix)
- Lossy transmission line: lumped RLCG model with N segments; user specifies Z₀, τ, loss, segments
- Sensors: NTC thermistor (B-parameter + optional self-heating thermal ODE), LDR (power-law R vs lux), spark gap (breakdown + hysteresis)
- Memristor: Joglekar window function model, charge-dependent resistance, pinched hysteresis loop
- NPN/PNP Darlington: subcircuit expansion via Phase 4c infrastructure
- Analog switch SPST/SPDT: tanh-smoothed variable resistance for NR convergence
- Schmitt trigger: inverting + non-inverting with hysteresis band, uses Phase 4a pin model

### Phase 6: Tier 3 Components + Polish (6-8 weeks)
**Detailed spec: `spec/phase-6-tier-3-and-polish.md`** — 6 waves, 12 tasks.
Depends on Phase 4a (behavioral framework), Phase 5 (controlled sources, expression enhancements).
- Digital-in-analog behavioral extensions: analog factories for all remaining flip-flops (JK, RS, T + async variants), counters, registers, shift registers, mux/demux/decoder, tri-state drivers, LED, 7-segment, relay — every component with electrical pins gets `engineType: "both"`
- Specialty analog components: 555 timer (behavioral model with internal comparators/flip-flop/discharge transistor), real op-amp (finite GBW, slew rate, offset, current limit, rail saturation), OTA (bias-controllable transconductance), comparator (open-collector output, optional hysteresis), optocoupler (galvanically isolated LED→phototransistor with CTR)
- ADC + DAC converters: N-bit DAC (threshold-detected digital inputs → analog voltage output), N-bit ADC (SAR behavioral model, analog input → digital output codes)
- AC small-signal analysis: linearize at DC operating point, complex sparse solver, frequency sweep, Bode plot renderer (magnitude + phase)
- CTZ URL import: CircuitJS compressed URL parser, component type mapping (~40 types), read-only import
- Monte Carlo / parameter sweep: batch simulation with Gaussian/uniform parameter variation, statistics collection (mean, std dev, percentiles, histograms); parameter sweep with linear/log stepping; supports DC, transient, and AC inner analyses

### Total: ~22-38 weeks for full scope; MVP (Phases 0-3) in ~14-18 weeks.
