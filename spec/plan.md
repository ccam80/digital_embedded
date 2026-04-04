# Analog State Pool & Write-Back Removal — Execution Plan

## Spec
`spec/analog-state-pool-and-writeback-removal.md`

## Phase Dependency Graph
```
Phase 1 (Infrastructure) → Phase 2 (Diode prototype) → Phase 3 (Remaining PN devices)
                                                      → Phase 4 (MOSFET/JFET)
                                                      → Phase 5 (Reactive passives)
Phase 3 + Phase 4 + Phase 5 → Phase 6 (Engine integration)
```

## Phases and Waves

### Phase 1: Infrastructure (non-breaking)
Spec: `spec/analog-state-pool-and-writeback-removal.md` § Phase 1

#### Wave 1.1
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| W1T1 | Create StatePool class | M | `src/solver/analog/state-pool.ts` (new) |
| W1T2 | Add stateSize/stateBaseOffset/initState to AnalogElement interfaces | S | `src/core/analog-types.ts`, `src/solver/analog/element.ts` |
| W1T3 | Add allocation loop to compiler + statePool on CompiledAnalogCircuit | M | `src/solver/analog/compiler.ts` |
| W1T4 | StatePool unit tests | S | `src/solver/analog/__tests__/state-pool.test.ts` (new) |

### Phase 2: Diode prototype
Spec: `spec/analog-state-pool-and-writeback-removal.md` § Phase 2

#### Wave 2.1
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| W2T1 | Migrate Diode to state pool, remove write-back | M | `src/components/semiconductors/diode.ts` |
| W2T2 | Diode write-back elimination test | S | `src/solver/analog/__tests__/diode-state-pool.test.ts` (new) or inline |

### Phase 3: Remaining PN-junction devices
Spec: `spec/analog-state-pool-and-writeback-removal.md` § Phase 3

#### Wave 3.1 (parallel safe — independent files)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| W3T1 | Migrate Zener to state pool | S | `src/components/semiconductors/zener.ts` |
| W3T2 | Migrate LED to state pool | S | `src/components/io/led.ts` |
| W3T3 | Migrate Tunnel Diode to state pool | S | `src/components/semiconductors/tunnel-diode.ts` |
| W3T4 | Migrate Varactor to state pool | S | `src/components/semiconductors/varactor.ts` |

#### Wave 3.2 (parallel safe — independent files)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| W3T5 | Migrate BJT simple to state pool | M | `src/components/semiconductors/bjt.ts` (simple model section) |
| W3T6 | Migrate BJT SPICE L1 to state pool | M | `src/components/semiconductors/bjt.ts` (SPICE L1 section) |
| W3T7 | Migrate SCR to state pool | S | `src/components/semiconductors/scr.ts` |
| W3T8 | Migrate Triac to state pool | S | `src/components/semiconductors/triac.ts` |
| W3T9 | Migrate test helper to state pool | S | `src/solver/analog/__tests__/test-helpers.ts` |

### Phase 4: MOSFET/JFET
Spec: `spec/analog-state-pool-and-writeback-removal.md` § Phase 4

#### Wave 4.1
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| W4T1 | Migrate AbstractFetElement to state pool (getter/setter) | M | `src/solver/analog/fet-base.ts` |
| W4T2 | MOSFET/JFET state pool verification test | S | test file |

### Phase 5: Reactive passives
Spec: `spec/analog-state-pool-and-writeback-removal.md` § Phase 5

#### Wave 5.1
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| W5T1 | Migrate Capacitor to state pool | M | `src/components/passives/capacitor.ts` |
| W5T2 | Migrate Inductor to state pool | M | `src/components/passives/inductor.ts` |

### Phase 6: Engine integration
Spec: `spec/analog-state-pool-and-writeback-removal.md` § Phase 6

#### Wave 6.1
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| W6T1 | Wire checkpoint/rollback/acceptTimestep into analog-engine.ts | L | `src/solver/analog/analog-engine.ts` |
| W6T2 | Convergence regression integration tests | M | test files |
| W6T3 | Make voltages param Readonly<Float64Array> in updateOperatingPoint | S | `src/core/analog-types.ts`, device files |

## Test Command
```bash
npm run test:q
```

## Acceptance Criteria
- Zero `voltages[...] =` write-backs in any device updateOperatingPoint
- All existing tests pass
- StatePool checkpoint/rollback works correctly
- Engine step() uses checkpoint/rollback for NR failure recovery
