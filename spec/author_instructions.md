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

