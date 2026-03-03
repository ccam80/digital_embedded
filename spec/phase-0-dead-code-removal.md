# Phase 0: Dead Code Removal

## Overview

Remove the entire CheerpJ prototype stack so the repository is clean for the native JS/TS port. After this phase, the repo contains only the tutorial shell, tutorial content, example circuits, and the spec tree.

## Wave 0.1: Remove CheerpJ Stack

### Pre-completed deletions

The following files were deleted prior to Phase 0 execution:
- `PLANNING.md` — superseded by `spec/plan.md`
- `tutorial.html` — MWE tutorial viewer (will be rebuilt in Phase 6)
- `tutorial.json` — MWE tutorial step definitions (will be rebuilt in Phase 6)

`CLAUDE.md` has already been rewritten to point to `spec/plan.md` and remove stale references.

### Task 0.1.1: Delete remaining CheerpJ artifacts

- **Description**: Delete all remaining files that belong to the CheerpJ-based prototype.

- **Files to delete**:
  - `Digital.jar` — hneemann/Digital Swing binary
  - `digital.html` — CheerpJ Swing loader with native method bridge
  - `bridge.html` — CheerpJ headless simulation bridge
  - `test-bridge.html` — integration test harness for CheerpJ bridges
  - `xstream-shim.jar` — patched XStream + Launcher (Java 8 bytecode)
  - `xstream-patch/` — entire directory (Java source for xstream-shim.jar, build artifacts)
  - `jdk-shim/` — entire directory (JDK property files for CheerpJ runtime)
  - `stack-question-template.txt` — Moodle/STACK grading template using CheerpJ bridge

- **Tests**:
  - `spec/phase-0-verify.sh::deleted_files_gone` — assert that none of these paths exist: `Digital.jar`, `digital.html`, `bridge.html`, `test-bridge.html`, `xstream-shim.jar`, `xstream-patch/`, `jdk-shim/`, `stack-question-template.txt`, `PLANNING.md`, `tutorial.html` (old MWE), `tutorial.json` (old MWE)
  - `spec/phase-0-verify.sh::no_cheerpj_references` — grep the entire repo (excluding `.git/` and `spec/`) for the strings `CheerpJ`, `cheerpj`, `cheerpOSAddStringFile`, `cheerpjInit`, `cheerpjRunMain`, `cheerpjRunLibrary`, `cheerpjCreateDisplay`, `Digital.jar`, `xstream-shim`, `Launcher.java`, `JVM.java`, `jdk-shim`. Assert zero matches.
  - `spec/phase-0-verify.sh::kept_files_exist` — assert that these paths still exist: `circuits/and-gate.dig`, `circuits/half-adder.dig`, `circuits/sr-latch.dig`, `CLAUDE.md`, `spec/plan.md`, `spec/progress.md`
  - `spec/phase-0-verify.sh::claude_md_no_stale_refs` — grep `CLAUDE.md` for `CheerpJ`, `Digital.jar`, `bridge.html`, `digital.html`, `xstream`, `Launcher`, `jdk-shim`. Assert zero matches.
  - `spec/phase-0-verify.sh::claude_md_has_required_sections` — grep `CLAUDE.md` for `spec/plan.md`, `postMessage`, `hneemann/Digital`, `python3 -m http.server`. Assert all present.

- **Acceptance criteria**:
  - `git status` shows only deletions — no new files except spec files
  - None of the deleted files/directories exist on disk
  - `CLAUDE.md` accurately describes the post-deletion repo: no references to deleted artifacts, all required sections present
  - A recursive grep of the repo (excluding `.git/` and `spec/`) for CheerpJ-related strings returns zero results
  - All tests in `spec/phase-0-verify.sh` pass
