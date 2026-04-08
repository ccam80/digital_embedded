# Phase 3: ngspice Integration

Full specification with exact code changes: `docs/harness-implementation-spec.md` § Phase 3

## Task P3a: niiter.c instrumentation callback

**File:** `ref/ngspice/src/maths/ni/niiter.c`

**Change 1:** After `#include "ngspice/sperror.h"` (line ~21), add:
- `NI_InstrumentCallback` typedef (function pointer for iteration instrumentation)
- `static ni_instrument_cb` global pointer (NULL default)
- `ni_instrument_register()` function to register the callback

**Change 2:** After the STEPDEBUG printf block (after convergence check), add callback invocation:
```c
if (ni_instrument_cb) {
    ni_instrument_cb(
        iterno - 1,
        ckt->CKTmaxEqNum + 1,
        ckt->CKTrhs,
        ckt->CKTrhsOld,
        ckt->CKTstate0,
        ckt->CKTnumStates,
        ckt->CKTnoncon,
        (ckt->CKTnoncon == 0 && iterno != 1) ? 1 : 0
    );
}
```

See spec Phase 3a for exact OLD/NEW text with context.

**IMPORTANT:** The `ref/ngspice/` directory may not exist in the repo. If the file does not exist, create the directory structure and file. The file content is a modification of the standard ngspice niiter.c — if the base file doesn't exist, report this and ask the user how to proceed.

## Task P3b: Windows shared library build instructions

**File:** `ref/ngspice/BUILD-SHARED-WIN.md` (NEW)

Create build instructions document covering:
- Prerequisites (VS2022, CMake)
- Option A: Visual Studio Solution build
- Option B: CMake build
- Verifying instrumentation export (`dumpbin /exports`)
- Adding the `__declspec(dllexport)` if needed

See spec Phase 3b for the complete file contents.

## Task P3c: NgspiceBridge FFI module

**File:** `src/solver/analog/__tests__/harness/ngspice-bridge.ts` (NEW)

Create the Node FFI bridge to ngspice shared library. Contains:
- `RawNgspiceIteration` interface
- `NgspiceBridge` class with:
  - `init()` — async FFI setup via koffi
  - `loadNetlist(netlist)` — send SPICE netlist
  - `runDcOp()` — DC operating point
  - `runTran(stopTime, maxStep)` — transient analysis
  - `getCaptureSession()` — convert raw data to CaptureSession format
  - `dispose()` — cleanup

Guarded by `NGSPICE_DLL_PATH` environment variable. Tests using this bridge should skip when the env var is not set.

See spec Phase 3c for the complete file contents.
