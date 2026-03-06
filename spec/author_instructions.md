# Author Instructions for Implementation Agents

These instructions supplement `spec/plan.md`. All implementation agents must read this document before writing code.

## Porting Approach: Informed Port, Not Straight Port

Read the Java source to understand *what it does and why*, then write idiomatic TypeScript that preserves the semantics but uses TS-native patterns. Do not translate Java line-by-line.

### TypeScript Idiom Guide

| Java pattern | Do this in TypeScript |
|---|---|
| Class hierarchy with `extends` | Prefer interfaces + composition. Use `extends` only for genuine is-a relationships. |
| Visitor pattern | Discriminated unions + `switch` |
| Enum with methods/fields | `const enum` for values, lookup `Map` or plain functions for behavior |
| Checked exceptions | Let errors propagate naturally. Use typed error classes from task 1.3.5. No try/catch in component code. |
| `getX()` / `setX()` | Direct property access or `get`/`set` accessors |
| `static factory` methods | Plain exported functions |
| `null` + null checks | Strict null types, optional chaining (`?.`), nullish coalescing (`??`) |
| `Iterator` / streams | Array methods (`.map`, `.filter`), generators, `for...of` |
| `HashMap` / `HashSet` | `Map` / `Set` |
| Package-private visibility | Module-level scoping — only export what's part of the public API |
| `final` fields | `readonly` properties |
| `interface` with default methods | Interface + standalone helper functions, or abstract class only if genuinely needed |
| `synchronized` / threading | Not applicable — single-threaded JS. Use Web Worker message passing where concurrency is needed. |

### Priority Order

When making implementation tradeoffs, favor in this order:
1. **Architectural consistency** — interfaces, contracts, and patterns must be uniform across the codebase
2. **Performance** — zero-allocation hot paths, monomorphic dispatch, typed arrays for engine state
3. **Implementation ease** — convenience is last priority; do not sacrifice 1 or 2 for developer ergonomics

## Review Checkpoints

The following phases require author review before downstream work begins. Agents must stop and flag these for review.

### Checkpoint 1: Phase 1 Interface Review

After Phase 1 (Foundation & Type System) is complete, **pause before starting Phases 2–5**.

The author will review:
- `CircuitElement` interface — does it support the engine-agnostic constraint? Could a future analog engine use the same interface?
- Engine interface — does `getSignalRaw()` / `getSignalValue()` dual representation look clean? Is the interface Web Worker-compatible?
- Signal types — is the `BitVector` ↔ `Uint32Array` conversion ergonomic for both UI code and engine internals?
- Error taxonomy — are the error types sufficient and well-structured?
- Overall patterns — does the code feel like idiomatic TypeScript, not "Java written in TypeScript"?

Estimated review time: ~30 minutes.

### Checkpoint 2: Phase 5 Exemplar Component Review

Task 5.1.1 (`And` gate) is the **exemplar component**. It must be implemented first and reviewed before the remaining ~109 components begin.

The `And` gate implementation must demonstrate:
- Correct `CircuitElement` interface implementation
- Standalone flat `executeFn` function for the compiled engine's function table (NOT a method on CircuitElement — see Decision 1)
- .dig attribute mapping registration (read `wideShape`, `Inputs`, `inverterConfig` from XML)
- Rendering with `RenderContext` — both IEEE/US and IEC/DIN gate shapes
- Complete unit tests: logic correctness (all input combinations, multi-bit, HIGH_Z, UNDEFINED propagation) and rendering (mock context records correct draw calls)
- Help text declaration

Every subsequent component copies this pattern exactly. Inconsistency across 110 component files is unacceptable.

Estimated review time: ~15 minutes.

### Checkpoint 3: Phase 2 UI Layout Review

Before Phase 2 implementation begins, the author will provide or approve a UI layout. Agents cannot invent the layout because the simulator is embedded in university course tutorials — the author knows the teaching context.

Layout decisions to resolve:
- Panel placement (palette, property editor, data table, timing diagram)
- Toolbar organization
- Standalone vs iframe-embedded appearance
- Locked mode presentation
- How display components (Terminal, VGA, LED Matrix) present their output panels

## UI Layout

Clone Digital's layout:

- **Left panel**: Tree-based component palette with collapsible category nodes. Search/filter at top. Recently-placed history section.
- **Right panel**: Collapsible property editor showing selected element's properties with type-appropriate inputs.
- **Top**: Toolbar with file operations, simulation controls, tools.
- **Center**: Canvas with grid, pan/zoom.
- **Display components** (Terminal, LED Matrix, VGA, Scope): Separate floating panels.
- **All panels are collapsible** for iframe-embedded mode. Full functionality is preserved — panels hide but can be re-shown. No functionality is removed in embedded mode.
- **Presentation mode** (F4): Fullscreen canvas, minimal sim-only toolbar, all panels hidden.

## Component Implementation Template

Every component file must follow this structure:

```typescript
// src/components/<category>/<name>.ts

// 1. Imports
import type { CircuitElement, RenderContext } from '../../core/element';
import type { Pin } from '../../core/pin';
// ...

// 2. Component class implementing CircuitElement
//    - All properties declared with types
//    - draw() uses RenderContext abstraction, never Canvas2D directly
//    - NO execute() method — simulation logic is in the standalone flat function below
//    - serialize()/deserialize() for persistence
//    - help() returns documentation text

// 3. Flat execution function for compiled engine
//    - Standalone function, not a method
//    - Operates on typed array state by index
//    - Zero allocations
export function executeAnd(index: number, state: Uint32Array): void { ... }

// 4. .dig attribute mapping registration
//    - Maps XML attribute names to component properties
//    - Uses the attribute mapping framework from 4.2.1

// 5. Registry registration
//    - Registers component type name, constructor, type ID, and flat execute function
```

Exact patterns will be established by the exemplar component (task 5.1.1).
