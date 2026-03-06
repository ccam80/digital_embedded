# Phase 11: Legacy Reference Review

**Depends on**: All previous phases

## Overview

Final cleanup sweep of the entire codebase. Remove any stale references to the old CheerpJ/Java bridge architecture that may have been introduced or overlooked during the porting process. Phase 0 did the initial dead code removal, but after building the entire native TypeScript codebase, a final audit ensures nothing was missed.

---

## Wave 11.1: Full Legacy Audit

### Task 11.1.1 — Repository-Wide Stale Reference Sweep

- **Description**: Search the entire repository for references to the old Java-based architecture and remove them all. This includes references in code, comments, configuration, and documentation.

  Search terms:
  - `CheerpJ` — old Java-to-JS transpiler
  - `Digital.jar` — old Java binary
  - `xstream` — old Java serialization library
  - `bridge.html` — old CheerpJ bridge page
  - `digital.html` (the old version, not `simulator.html`) — old entry point
  - `Launcher.java`, `JVM.java` — old Java references
  - `de.neemann.digital` — Java package names (in comments or strings, not in `ref/Digital/` which is the submodule)
  - `.class` — Java class file references
  - `jdk-shim` — old JDK compatibility shim
  - `xstream-shim` — old XStream compatibility shim
  - `xstream-patch` — old XStream patch directory
  - `test-bridge.html` — old test page
  - `stack-question-template.txt` — old Q&A template

  Exclusions:
  - `ref/Digital/` submodule — Java source is the reference, don't modify it
  - `spec/phase-0-dead-code-removal.md` — historical spec, OK to reference these terms
  - `spec/progress.md` — historical record, OK to reference these terms

  For each finding:
  - If it's dead code/comments: delete
  - If it's a stale import: remove
  - If it's documentation referencing old architecture: update to reference new architecture
  - If it's a legitimate reference (e.g., explaining the port history in CLAUDE.md): leave but verify accuracy

- **Files to modify**: Varies — any file containing stale references (excluding exclusions above)

- **Tests**:
  - `src/__tests__/legacy-audit.test.ts::noStaleReferences` — grep entire `src/` tree for all search terms → zero matches
  - `src/__tests__/legacy-audit.test.ts::noStaleHtmlReferences` — grep `*.html` files (excluding `ref/`) → zero matches for old file names
  - `src/__tests__/legacy-audit.test.ts::noJavaPackageNames` — grep `src/` for `de.neemann.digital` → zero matches (references in `ref/` are OK)

- **Acceptance criteria**:
  - Zero stale references in `src/`, `lib/`, `*.html`, `*.json`, `*.md` (excluding `ref/` and spec history files)
  - All code compiles cleanly
  - All tests pass
  - CLAUDE.md is up to date with final architecture
