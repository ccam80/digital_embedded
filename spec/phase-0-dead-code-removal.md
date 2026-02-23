# Phase 0: Dead Code Removal

## Overview

Remove the entire CheerpJ prototype stack so the repository is clean for the native JS/TS port. After this phase, the repo contains only the tutorial shell, tutorial content, example circuits, and the spec tree.

## Wave 0.1: Remove CheerpJ Stack

### Task 0.1.1: Delete CheerpJ artifacts, delete PLANNING.md, rewrite CLAUDE.md

- **Description**: Delete all files that belong to the CheerpJ-based prototype. Delete `PLANNING.md` (superseded by `spec/plan.md`). Rewrite `CLAUDE.md` to accurately describe the post-deletion repo state. `tutorial.html` is left as-is — its iframe will 404 until Phase 6 wires it to the new simulator.

- **Files to delete**:
  - `Digital.jar` — hneemann/Digital Swing binary
  - `digital.html` — CheerpJ Swing loader with native method bridge
  - `bridge.html` — CheerpJ headless simulation bridge
  - `test-bridge.html` — integration test harness for CheerpJ bridges
  - `xstream-shim.jar` — patched XStream + Launcher (Java 8 bytecode)
  - `xstream-patch/` — entire directory (Java source for xstream-shim.jar, build artifacts)
  - `jdk-shim/` — entire directory (JDK property files for CheerpJ runtime)
  - `stack-question-template.txt` — Moodle/STACK grading template using CheerpJ bridge
  - `PLANNING.md` — superseded by `spec/plan.md`

- **Files to modify**:
  - `CLAUDE.md` — full rewrite. New content must describe:
    - Project overview: browser-based digital logic simulator, native JS/TS port of hneemann/Digital, purely static files
    - Planning pointer: "Read `spec/plan.md` for the implementation plan" (replaces the PLANNING.md pointer)
    - Current repo contents: `tutorial.html` (tutorial viewer shell, iframe currently broken — will be wired to simulator in Phase 6), `tutorial.json` (tutorial step definitions), `circuits/*.dig` (example checkpoint circuits), `spec/` (implementation plan and phase specs)
    - Reference codebase: hneemann/Digital only (no circuitjs1). Same table as PLANNING.md section 2.
    - Engine-agnostic editor constraint: same text as PLANNING.md section 1 ("Engine-Agnostic Editor")
    - Serving instructions: `python3 -m http.server 8080` (unchanged)
    - Tutorial authoring format: `tutorial.json` schema (unchanged)
    - postMessage API: preserved from current CLAUDE.md (unchanged)
    - No mention of CheerpJ, Digital.jar, bridge.html, xstream, Launcher.java, or any deleted artifact

- **Tests**:
  - `spec/phase-0-verify.sh::deleted_files_gone` — assert that none of these paths exist: `Digital.jar`, `digital.html`, `bridge.html`, `test-bridge.html`, `xstream-shim.jar`, `xstream-patch/`, `jdk-shim/`, `stack-question-template.txt`, `PLANNING.md`
  - `spec/phase-0-verify.sh::no_cheerpj_references` — grep the entire repo (excluding `.git/` and `spec/plan.md`) for the strings `CheerpJ`, `cheerpj`, `cheerpOSAddStringFile`, `cheerpjInit`, `cheerpjRunMain`, `cheerpjRunLibrary`, `cheerpjCreateDisplay`, `Digital.jar`, `xstream-shim`, `bridge.html` (the old file, not a prose mention), `digital.html` (the old file), `Launcher.java`, `JVM.java`, `jdk-shim`. Assert zero matches.
  - `spec/phase-0-verify.sh::kept_files_exist` — assert that these paths still exist: `tutorial.html`, `tutorial.json`, `circuits/and-gate.dig`, `circuits/half-adder.dig`, `circuits/sr-latch.dig`, `CLAUDE.md`, `spec/plan.md`, `spec/progress.md`
  - `spec/phase-0-verify.sh::claude_md_no_stale_refs` — grep `CLAUDE.md` for `CheerpJ`, `Digital.jar`, `bridge.html`, `digital.html`, `xstream`, `Launcher`, `jdk-shim`. Assert zero matches.
  - `spec/phase-0-verify.sh::claude_md_has_required_sections` — grep `CLAUDE.md` for `spec/plan.md`, `postMessage`, `tutorial.json`, `hneemann/Digital`, `python3 -m http.server`. Assert all present.

- **Acceptance criteria**:
  - `git status` shows only deletions and the modified `CLAUDE.md` — no new files except `spec/phase-0-dead-code-removal.md` (this spec) and `spec/phase-0-verify.sh` (verification script)
  - None of the 9 deleted files/directories exist on disk
  - `CLAUDE.md` accurately describes the post-deletion repo: no references to deleted artifacts, all required sections present
  - A recursive grep of the repo (excluding `.git/`) for CheerpJ-related strings returns zero results (with the exception of `spec/plan.md` which documents the phase that removed them)
  - `tutorial.html` is unchanged (its broken iframe is expected and intentional)
  - All tests in `spec/phase-0-verify.sh` pass
