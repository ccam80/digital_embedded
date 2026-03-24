/**
 * Tests for exportZip() — ZIP archive export.
 *
 * Spec tests:
 *   createsZip        — export returns a Blob with type application/zip
 *   containsMainCircuit — ZIP contains main .dig file named from circuit metadata
 *   containsSubcircuits — ZIP contains subcircuit .dig files
 *   containsDataFiles — ZIP contains hex data files
 *   roundTrip         — create ZIP, extract, verify file contents match originals
 */

import { describe, it, expect } from "vitest";
import { exportZip } from "../zip";
import { Circuit } from "../../core/circuit";
import { serializeCircuit } from "../../io/save";

/**
 * Helper to extract files from a ZIP Blob.
 * Uses fflate (already a dependency) to unzip.
 */
async function unzipBlob(blob: Blob): Promise<Map<string, Uint8Array>> {
  const { unzip } = await import("fflate");
  const buffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(buffer);

  return new Promise((resolve, reject) => {
    unzip(uint8, (err, unzipped) => {
      if (err) {
        reject(err);
      } else {
        const map = new Map<string, Uint8Array>();
        for (const [name, data] of Object.entries(unzipped)) {
          map.set(name, data as Uint8Array);
        }
        resolve(map);
      }
    });
  });
}

describe("exportZip", () => {
  it("createsZip — export returns a Blob with type application/zip", async () => {
    const circuit = new Circuit({ name: "main" });
    const subcircuits = new Map<string, string>();
    const dataFiles = new Map<string, ArrayBuffer>();

    const blob = await exportZip(circuit, subcircuits, dataFiles);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/zip");
  });

  it("containsMainCircuit — ZIP contains main .dig file named from circuit metadata", async () => {
    const circuit = new Circuit({ name: "circuit" });
    const subcircuits = new Map<string, string>();
    const dataFiles = new Map<string, ArrayBuffer>();

    const blob = await exportZip(circuit, subcircuits, dataFiles);
    const extracted = await unzipBlob(blob);

    expect(extracted.has("circuit.dig")).toBe(true);
    const mainContent = new TextDecoder().decode(extracted.get("circuit.dig")!);
    expect(mainContent).toBe(serializeCircuit(circuit));
  });

  it("containsSubcircuits — ZIP contains subcircuit .dig files", async () => {
    const circuit = new Circuit({ name: "circuit" });
    const sub1Xml = "<circuit><name>Sub1</name></circuit>";
    const sub2Xml = "<circuit><name>Sub2</name></circuit>";

    const subcircuits = new Map<string, string>([
      ["sub1.dig", sub1Xml],
      ["sub2.dig", sub2Xml],
    ]);
    const dataFiles = new Map<string, ArrayBuffer>();

    const blob = await exportZip(circuit, subcircuits, dataFiles);
    const extracted = await unzipBlob(blob);

    expect(extracted.has("sub1.dig")).toBe(true);
    expect(extracted.has("sub2.dig")).toBe(true);

    const sub1Content = new TextDecoder().decode(extracted.get("sub1.dig")!);
    const sub2Content = new TextDecoder().decode(extracted.get("sub2.dig")!);

    expect(sub1Content).toBe(sub1Xml);
    expect(sub2Content).toBe(sub2Xml);
  });

  it("containsDataFiles — ZIP contains hex data files", async () => {
    const circuit = new Circuit({ name: "circuit" });
    const subcircuits = new Map<string, string>();

    const dataContent = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const dataFiles = new Map<string, ArrayBuffer>([
      ["data.hex", dataContent.buffer],
    ]);

    const blob = await exportZip(circuit, subcircuits, dataFiles);
    const extracted = await unzipBlob(blob);

    expect(extracted.has("data.hex")).toBe(true);
    const extractedData = extracted.get("data.hex")!;
    expect(extractedData).toEqual(dataContent);
  });

  it("roundTrip — create ZIP, extract, verify file contents match originals", async () => {
    const circuit = new Circuit({ name: "main" });
    const sub1Xml = "<circuit><name>Sub1</name></circuit>";
    const dataContent = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    const subcircuits = new Map<string, string>([
      ["sub1.dig", sub1Xml],
    ]);
    const dataFiles = new Map<string, ArrayBuffer>([
      ["memory.hex", dataContent.buffer],
    ]);

    const blob = await exportZip(circuit, subcircuits, dataFiles);
    const extracted = await unzipBlob(blob);

    // Check main circuit
    expect(extracted.has("main.dig")).toBe(true);
    const mainExtracted = new TextDecoder().decode(extracted.get("main.dig")!);
    expect(mainExtracted).toBe(serializeCircuit(circuit));

    // Check subcircuit
    expect(extracted.has("sub1.dig")).toBe(true);
    const sub1Extracted = new TextDecoder().decode(extracted.get("sub1.dig")!);
    expect(sub1Extracted).toBe(sub1Xml);

    // Check data file
    expect(extracted.has("memory.hex")).toBe(true);
    const dataExtracted = extracted.get("memory.hex")!;
    expect(dataExtracted).toEqual(dataContent);
  });

  it("handles multiple data files correctly", async () => {
    const circuit = new Circuit({ name: "main" });
    const subcircuits = new Map<string, string>();

    const data1 = new Uint8Array([0x01, 0x02]);
    const data2 = new Uint8Array([0x03, 0x04, 0x05]);

    const dataFiles = new Map<string, ArrayBuffer>([
      ["data1.bin", data1.buffer],
      ["data2.bin", data2.buffer],
    ]);

    const blob = await exportZip(circuit, subcircuits, dataFiles);
    const extracted = await unzipBlob(blob);

    expect(extracted.size).toBe(3); // main + 2 data files

    const d1 = extracted.get("data1.bin")!;
    const d2 = extracted.get("data2.bin")!;

    expect(d1).toEqual(data1);
    expect(d2).toEqual(data2);
  });

  it("handles empty subcircuits and data files", async () => {
    const circuit = new Circuit({ name: "main" });
    const blob = await exportZip(circuit, new Map(), new Map());
    const extracted = await unzipBlob(blob);

    expect(extracted.size).toBe(1);
    expect(extracted.has("main.dig")).toBe(true);
  });

  it("preserves file structure in ZIP", async () => {
    const circuit = new Circuit({ name: "main" });
    const sub1Xml = "<circuit></circuit>";

    const subcircuits = new Map<string, string>([
      ["subcircuits/sub1.dig", sub1Xml],
    ]);

    const blob = await exportZip(circuit, subcircuits);
    const extracted = await unzipBlob(blob);

    expect(extracted.has("subcircuits/sub1.dig")).toBe(true);
  });

  it("derives filename from circuit metadata name", async () => {
    const circuit = new Circuit({ name: "my-adder" });
    const blob = await exportZip(circuit, new Map());
    const extracted = await unzipBlob(blob);

    expect(extracted.has("my-adder.dig")).toBe(true);
    expect(extracted.has("my-adder.dig.dig")).toBe(false);
  });
});
