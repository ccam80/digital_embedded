# ngspice Comparison Harness — Execution Plan

## Spec
`docs/harness-implementation-spec.md`

## Phase Dependency Graph
```
Phase 1 (Engine Accessors) → Phase 2 (Harness Modules) → Phase 3 (ngspice Integration)
```

## Phases and Waves

### Phase 1: Engine Accessor Changes
Spec: `docs/harness-implementation-spec.md` § Phase 1

#### Wave 1.1 (parallel — independent files)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| P1a | SparseSolver instrumentation accessors | S | `src/solver/analog/sparse-solver.ts` |
| P1b | postIterationHook on NROptions + call site | M | `src/solver/analog/newton-raphson.ts` |
| P1d | Extend NRAttemptRecord with iterationDetails | S | `src/solver/analog/convergence-log.ts` |
| P1e | Remove dead getLteEstimate interface method | S | `src/solver/analog/element.ts`, `src/core/analog-types.ts`, `src/solver/analog/timestep.ts`, `src/components/semiconductors/bjt.ts` |

#### Wave 1.2 (depends on Wave 1.1 — P1b must exist for postIterationHook type)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| P1c | MNAEngine harness accessors + hook wiring | M | `src/solver/analog/analog-engine.ts` |

### Phase 2: Harness TypeScript Modules (New Files)
Spec: `docs/harness-implementation-spec.md` § Phase 2

#### Wave 2.1 (foundation — types must exist before other modules)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| P2a | Common harness types | M | `src/solver/analog/__tests__/harness/types.ts` (new) |

#### Wave 2.2 (parallel — all depend on 2a types only)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| P2b | Capture functions | M | `src/solver/analog/__tests__/harness/capture.ts` (new) |
| P2c | Device mappings | M | `src/solver/analog/__tests__/harness/device-mappings.ts` (new) |
| P2d | Comparison engine | M | `src/solver/analog/__tests__/harness/compare.ts` (new) |
| P2e | Query API | M | `src/solver/analog/__tests__/harness/query.ts` (new) |

### Phase 3: ngspice Integration
Spec: `docs/harness-implementation-spec.md` § Phase 3

#### Wave 3.1 (parallel — independent files)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| P3a | niiter.c instrumentation callback | M | `ref/ngspice/src/maths/ni/niiter.c` |
| P3b | Windows shared library build instructions | S | `ref/ngspice/BUILD-SHARED-WIN.md` (new) |
| P3c | NgspiceBridge FFI module | L | `src/solver/analog/__tests__/harness/ngspice-bridge.ts` (new) |

## Test Command
```bash
npm run test:q
```

## Acceptance Criteria
- SparseSolver exposes dimension, getRhsSnapshot(), getCSCNonZeros()
- NR postIterationHook fires after every convergence check
- MNAEngine exposes solver, statePool, elements, compiled, and postIterationHook field
- All harness modules compile without errors
- Dead getLteEstimate interface method removed
- ngspice niiter.c has instrumentation callback infrastructure
- All existing tests pass
