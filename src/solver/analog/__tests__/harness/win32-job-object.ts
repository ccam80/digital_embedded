/**
 * win32-job-object.ts — koffi binding for the Windows Job Object memory cap.
 *
 * A Job Object is the kernel-enforced way to bound a child process tree's
 * memory and to guarantee the children die if the parent does. We use it as the
 * SINGLE memory-isolation mechanism for the ngspice worker (no parent-side RSS
 * polling backstop — a soft guard is exactly what fails to stop a runaway native
 * deck from exhausting the host).
 *
 * Mechanism (all via kernel32 through koffi):
 *   1. CreateJobObjectW            — make an unnamed job.
 *   2. SetInformationJobObject     — apply JOBOBJECT_EXTENDED_LIMIT_INFORMATION
 *      with JOB_OBJECT_LIMIT_PROCESS_MEMORY (per-process commit cap) +
 *      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (kill the child if our handle closes,
 *      i.e. if the parent dies or disposes).
 *   3. OpenProcess(child.pid)      — Node gives us a PID, not a native HANDLE;
 *      reopen it with the access rights AssignProcessToJobObject needs.
 *   4. AssignProcessToJobObject    — bind the child to the job.
 * When the child's committed memory exceeds the cap, the kernel fails its
 * allocations (the deck then crashes / exits non-zero); the wall-clock timer in
 * the guard is the orthogonal hang backstop.
 *
 * Windows-only. On any other platform every entry point throws — the guard is
 * only sanctioned on the platform where the instrumented ngspice DLL exists.
 *
 * Struct field types reference the Win64 ABI:
 *   - JOBOBJECT_BASIC_LIMIT_INFORMATION / IO_COUNTERS / EXTENDED layout:
 *     winnt.h. SIZE_T fields are pointer-width (`size_t`), the two *TimeLimit
 *     fields are LARGE_INTEGER (`int64`).
 */

import koffi from "koffi";

// JOBOBJECTINFOCLASS::JobObjectExtendedLimitInformation (winnt.h).
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;

// JOB_OBJECT_LIMIT_* flags (winnt.h).
const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

// PROCESS_ALL_ACCESS — superset that includes PROCESS_SET_QUOTA |
// PROCESS_TERMINATE which AssignProcessToJobObject requires (winnt.h).
const PROCESS_ALL_ACCESS = 0x1f0fff;

interface Kernel32 {
  CreateJobObjectW: (lpSecurityAttributes: unknown, lpName: unknown) => unknown;
  SetInformationJobObject: (
    hJob: unknown,
    infoClass: number,
    info: unknown,
    infoLength: number,
  ) => boolean;
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  AssignProcessToJobObject: (hJob: unknown, hProcess: unknown) => boolean;
  TerminateJobObject: (hJob: unknown, exitCode: number) => boolean;
  CloseHandle: (handle: unknown) => boolean;
  GetLastError: () => number;
}

let _k32: Kernel32 | null = null;
let _extType: unknown = null;

function loadKernel32(): { k32: Kernel32; extType: unknown } {
  if (_k32 && _extType) return { k32: _k32, extType: _extType };
  if (process.platform !== "win32") {
    throw new Error(
      "win32-job-object: Job Object memory isolation is Windows-only; " +
        `current platform is "${process.platform}". The ngspice harness only ` +
        "runs where the instrumented DLL exists (win32).",
    );
  }

  const lib = koffi.load("kernel32.dll");

  const IO_COUNTERS = koffi.struct("IO_COUNTERS_jobcap", {
    ReadOperationCount: "uint64",
    WriteOperationCount: "uint64",
    OtherOperationCount: "uint64",
    ReadTransferCount: "uint64",
    WriteTransferCount: "uint64",
    OtherTransferCount: "uint64",
  });
  const BASIC = koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION_jobcap", {
    PerProcessUserTimeLimit: "int64",
    PerJobUserTimeLimit: "int64",
    LimitFlags: "uint32",
    MinimumWorkingSetSize: "size_t",
    MaximumWorkingSetSize: "size_t",
    ActiveProcessLimit: "uint32",
    Affinity: "size_t",
    PriorityClass: "uint32",
    SchedulingClass: "uint32",
  });
  const EXT = koffi.struct("JOBOBJECT_EXTENDED_LIMIT_INFORMATION_jobcap", {
    BasicLimitInformation: BASIC,
    IoInfo: IO_COUNTERS,
    ProcessMemoryLimit: "size_t",
    JobMemoryLimit: "size_t",
    PeakProcessMemoryUsed: "size_t",
    PeakJobMemoryUsed: "size_t",
  });

  const k32: Kernel32 = {
    CreateJobObjectW: lib.func("void* CreateJobObjectW(void*, const char16_t*)") as Kernel32["CreateJobObjectW"],
    // The struct goes in by pointer; typing the param as a pointer to EXT makes
    // koffi marshal the JS object into a native buffer of the right layout.
    SetInformationJobObject: lib.func("SetInformationJobObject", "bool", [
      "void*",
      "int",
      koffi.pointer(EXT),
      "uint32",
    ]) as Kernel32["SetInformationJobObject"],
    OpenProcess: lib.func("void* OpenProcess(uint32, bool, uint32)") as Kernel32["OpenProcess"],
    AssignProcessToJobObject: lib.func("bool AssignProcessToJobObject(void*, void*)") as Kernel32["AssignProcessToJobObject"],
    TerminateJobObject: lib.func("bool TerminateJobObject(void*, uint32)") as Kernel32["TerminateJobObject"],
    CloseHandle: lib.func("bool CloseHandle(void*)") as Kernel32["CloseHandle"],
    GetLastError: lib.func("uint32 GetLastError()") as Kernel32["GetLastError"],
  };

  _k32 = k32;
  _extType = EXT;
  return { k32, extType: EXT };
}

/**
 * Handle bundle for an active job. Hold it for the child's lifetime and call
 * `close()` exactly once when the child has exited (or to force-kill it via
 * `terminate()`). Closing the job handle with KILL_ON_JOB_CLOSE set is what
 * makes the child die if the parent forgets / crashes.
 */
export interface JobObjectGuard {
  /** Force-kill every process in the job immediately. */
  terminate(): void;
  /** Release the job + process handles. With KILL_ON_JOB_CLOSE this also kills
   *  any still-running child. Idempotent. */
  close(): void;
}

/**
 * Create a Job Object capped at `memLimitBytes` per process, then bind the
 * already-spawned child (`pid`) to it. Throws on any Win32 failure — the caller
 * (the guard) treats a throw as "isolation could not be established" and must
 * NOT proceed to run ngspice unguarded.
 */
export function assignProcessToMemoryCappedJob(pid: number, memLimitBytes: number): JobObjectGuard {
  const { k32, extType } = loadKernel32();

  const job = k32.CreateJobObjectW(null, null);
  if (!job) {
    throw new Error(`win32-job-object: CreateJobObjectW failed (GetLastError=${k32.GetLastError()})`);
  }

  const info = {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: memLimitBytes,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };

  const setOk = k32.SetInformationJobObject(
    job,
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
    info,
    koffi.sizeof(extType as never),
  );
  if (!setOk) {
    const err = k32.GetLastError();
    k32.CloseHandle(job);
    throw new Error(`win32-job-object: SetInformationJobObject failed (GetLastError=${err})`);
  }

  const proc = k32.OpenProcess(PROCESS_ALL_ACCESS, false, pid);
  if (!proc) {
    const err = k32.GetLastError();
    k32.CloseHandle(job);
    throw new Error(`win32-job-object: OpenProcess(pid=${pid}) failed (GetLastError=${err})`);
  }

  const assignOk = k32.AssignProcessToJobObject(job, proc);
  if (!assignOk) {
    const err = k32.GetLastError();
    k32.CloseHandle(proc);
    k32.CloseHandle(job);
    throw new Error(`win32-job-object: AssignProcessToJobObject(pid=${pid}) failed (GetLastError=${err})`);
  }

  let closed = false;
  return {
    terminate(): void {
      if (closed) return;
      k32.TerminateJobObject(job, 1);
    },
    close(): void {
      if (closed) return;
      closed = true;
      // Close the process handle first; closing the job last triggers
      // KILL_ON_JOB_CLOSE for any still-running child.
      k32.CloseHandle(proc);
      k32.CloseHandle(job);
    },
  };
}
