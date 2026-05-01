/**
 * Tests for subcircuit-store.ts- IndexedDB persistence for user-created subcircuits.
 *
 * Uses an in-memory IndexedDB mock (vi.stubGlobal) to exercise the real
 * store logic without requiring a browser or fake-indexeddb package.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  storeSubcircuit,
  loadAllSubcircuits,
  deleteSubcircuit,
  type StoredSubcircuit,
} from "../subcircuit-store.js";

// ---------------------------------------------------------------------------
// In-memory IndexedDB mock
// ---------------------------------------------------------------------------
//
// Design: each test gets a fresh Map<name, StoredSubcircuit> as backing store.
// Transactions are modelled as synchronous operations whose callbacks are fired
// on microtask boundaries, matching the real IDB event model closely enough
// that the Promise-based store code resolves correctly.
//

function createMockIDB() {
  // Shared backing store for all IDB opens in a single test.
  const backing = new Map<string, StoredSubcircuit>();

  function makeTransaction(_mode: string) {
    let oncompleteCb: (() => void) | null = null;
    let onerrorCb: (() => void) | null = null;

    // oncomplete fires after all synchronous work in the current microtask
    // queue is done. We use a 4-tick delay so that:
    //   tick 1: openDB onsuccess fires
    //   tick 2: store.get onsuccess fires (inside tx)
    //   tick 3: store.put runs (inside getReq.onsuccess)
    //   tick 4: tx.oncomplete fires → Promise resolves
    const scheduleComplete = () => {
      Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => Promise.resolve())
        .then(() => Promise.resolve())
        .then(() => oncompleteCb?.());
    };

    const objectStore = {
      get(key: IDBValidKey) {
        const value = backing.get(key as string);
        const req = {
          result: value as unknown,
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void),
        };
        // Fire onsuccess on next microtask
        Promise.resolve().then(() => req.onsuccess?.());
        return req;
      },

      put(record: StoredSubcircuit) {
        backing.set(record.name, { ...record });
        return { result: record.name as IDBValidKey };
      },

      delete(key: IDBValidKey) {
        backing.delete(key as string);
        return { result: undefined };
      },

      getAll() {
        const result = Array.from(backing.values());
        const req = {
          result: result as unknown,
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void),
        };
        Promise.resolve().then(() => req.onsuccess?.());
        return req;
      },
    };

    const tx = {
      get oncomplete() { return oncompleteCb; },
      set oncomplete(fn: (() => void) | null) {
        oncompleteCb = fn;
        scheduleComplete();
      },
      get onerror() { return onerrorCb; },
      set onerror(fn: (() => void) | null) { onerrorCb = fn; },
      objectStore(_name: string) { return objectStore; },
    };

    return tx;
  }

  const fakeDB = {
    objectStoreNames: { contains: (_n: string) => true },
    transaction(_storeName: string, mode: string) {
      return makeTransaction(mode);
    },
    close() {},
    createObjectStore(_name: string, _opts?: unknown) {},
  };

  return {
    open(_name: string, _version?: number) {
      const req = {
        result: fakeDB as unknown as IDBDatabase,
        error: null as DOMException | null,
        onupgradeneeded: null as null | ((e: IDBVersionChangeEvent) => void),
        onsuccess: null as null | ((e: Event) => void),
        onerror: null as null | ((e: Event) => void),
      };
      Promise.resolve().then(() => req.onsuccess?.({} as Event));
      return req as unknown as IDBOpenDBRequest;
    },
    deleteDatabase(_name: string) { return {} as IDBOpenDBRequest; },
    cmp(_a: unknown, _b: unknown) { return 0; },
    databases() { return Promise.resolve([]); },
  } satisfies typeof globalThis.indexedDB;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal("indexedDB", createMockIDB());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storeSubcircuit", () => {
  it("stores a new entry and loadAllSubcircuits returns it", async () => {
    await storeSubcircuit("MyAdder", "<circuit/>");
    const all = await loadAllSubcircuits();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("MyAdder");
    expect(all[0].xml).toBe("<circuit/>");
  });

  it("sets created and modified timestamps on new entry", async () => {
    const before = Date.now();
    await storeSubcircuit("Alu", "<circuit/>");
    const after = Date.now();
    const all = await loadAllSubcircuits();
    expect(all[0].created).toBeGreaterThanOrEqual(before);
    expect(all[0].created).toBeLessThanOrEqual(after);
    expect(all[0].modified).toBeGreaterThanOrEqual(before);
    expect(all[0].modified).toBeLessThanOrEqual(after);
  });

  it("upsert: updates xml and modified but preserves created", async () => {
    await storeSubcircuit("MyAdder", "<circuit><v1/></circuit>");
    const allAfterFirst = await loadAllSubcircuits();
    const createdFirst = allAfterFirst[0].created;
    const modifiedFirst = allAfterFirst[0].modified;

    await new Promise<void>((r) => setTimeout(r, 5));

    await storeSubcircuit("MyAdder", "<circuit><v2/></circuit>");
    const allAfterSecond = await loadAllSubcircuits();

    expect(allAfterSecond).toHaveLength(1);
    expect(allAfterSecond[0].xml).toBe("<circuit><v2/></circuit>");
    expect(allAfterSecond[0].created).toBe(createdFirst);
    expect(allAfterSecond[0].modified).toBeGreaterThan(modifiedFirst);
  });

  it("stores multiple distinct entries", async () => {
    await storeSubcircuit("Adder", "<circuit><adder/></circuit>");
    await storeSubcircuit("Alu", "<circuit><alu/></circuit>");
    await storeSubcircuit("Register", "<circuit><register/></circuit>");

    const all = await loadAllSubcircuits();
    expect(all).toHaveLength(3);
    const names = all.map((s) => s.name);
    expect(names).toContain("Adder");
    expect(names).toContain("Alu");
    expect(names).toContain("Register");
  });
});

describe("loadAllSubcircuits", () => {
  it("returns empty array when store is empty", async () => {
    const all = await loadAllSubcircuits();
    expect(all).toEqual([]);
  });

  it("returns StoredSubcircuit objects with correct values", async () => {
    await storeSubcircuit("Test", "<circuit/>");
    const all = await loadAllSubcircuits();
    const entry = all[0];
    expect(entry.name).toBe("Test");
    expect(entry.xml).toBe("<circuit/>");
    expect(entry.created).toBeGreaterThan(0);
    expect(entry.modified).toBeGreaterThanOrEqual(entry.created);
  });
});

describe("deleteSubcircuit", () => {
  it("removes an entry by name", async () => {
    await storeSubcircuit("Adder", "<circuit/>");
    await storeSubcircuit("Mux", "<circuit/>");
    await deleteSubcircuit("Adder");

    const all = await loadAllSubcircuits();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Mux");
  });

  it("is a no-op when name does not exist", async () => {
    await storeSubcircuit("Alu", "<circuit/>");
    await deleteSubcircuit("DoesNotExist");

    const all = await loadAllSubcircuits();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Alu");
  });

  it("leaves store empty after deleting sole entry", async () => {
    await storeSubcircuit("Only", "<circuit/>");
    await deleteSubcircuit("Only");
    const all = await loadAllSubcircuits();
    expect(all).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onupgradeneeded path- fresh database (objectStore does not exist yet)
// ---------------------------------------------------------------------------

describe("openDB onupgradeneeded", () => {
  it("calls createObjectStore when the store does not exist yet", async () => {
    // Build a mock where contains() returns false so the upgrade branch runs.
    const backing = new Map<string, StoredSubcircuit>();

    const createObjectStoreSpy = vi.fn();

    function makeTransaction(_mode: string) {
      let oncompleteCb: (() => void) | null = null;
      const scheduleComplete = () => {
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => Promise.resolve())
          .then(() => Promise.resolve())
          .then(() => oncompleteCb?.());
      };

      const objectStore = {
        get(key: IDBValidKey) {
          const value = backing.get(key as string);
          const req = {
            result: value as unknown,
            onsuccess: null as null | (() => void),
            onerror: null as null | (() => void),
          };
          Promise.resolve().then(() => req.onsuccess?.());
          return req;
        },
        put(record: StoredSubcircuit) {
          backing.set(record.name, { ...record });
          return { result: record.name as IDBValidKey };
        },
        delete(key: IDBValidKey) {
          backing.delete(key as string);
          return { result: undefined };
        },
        getAll() {
          const result = Array.from(backing.values());
          const req = {
            result: result as unknown,
            onsuccess: null as null | (() => void),
            onerror: null as null | (() => void),
          };
          Promise.resolve().then(() => req.onsuccess?.());
          return req;
        },
      };

      const tx = {
        get oncomplete() { return oncompleteCb; },
        set oncomplete(fn: (() => void) | null) {
          oncompleteCb = fn;
          scheduleComplete();
        },
        get onerror() { return null; },
        set onerror(_fn: (() => void) | null) {},
        objectStore(_name: string) { return objectStore; },
      };
      return tx;
    }

    const freshDB = {
      // contains returns false → triggers createObjectStore in onupgradeneeded
      objectStoreNames: { contains: (_n: string) => false },
      transaction(_storeName: string, mode: string) {
        return makeTransaction(mode);
      },
      close() {},
      createObjectStore: createObjectStoreSpy,
    };

    vi.stubGlobal("indexedDB", {
      open(_name: string, _version?: number) {
        const req = {
          result: freshDB as unknown as IDBDatabase,
          error: null as DOMException | null,
          onupgradeneeded: null as null | ((e: IDBVersionChangeEvent) => void),
          onsuccess: null as null | ((e: Event) => void),
          onerror: null as null | ((e: Event) => void),
        };
        // Fire onupgradeneeded first, then onsuccess (mirrors real IDB behaviour)
        Promise.resolve().then(() => {
          req.onupgradeneeded?.({} as IDBVersionChangeEvent);
          req.onsuccess?.({} as Event);
        });
        return req as unknown as IDBOpenDBRequest;
      },
      deleteDatabase(_name: string) { return {} as IDBOpenDBRequest; },
      cmp(_a: unknown, _b: unknown) { return 0; },
      databases() { return Promise.resolve([]); },
    } satisfies typeof globalThis.indexedDB);

    // Any store operation triggers openDB; storeSubcircuit is the simplest.
    await storeSubcircuit("FreshDB", "<circuit/>");

    // createObjectStore must have been called during onupgradeneeded
    expect(createObjectStoreSpy).toHaveBeenCalledWith("subcircuits", { keyPath: "name" });
  });
});
