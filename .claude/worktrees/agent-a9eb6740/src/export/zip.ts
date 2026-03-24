/**
 * ZIP archive circuit export.
 *
 * Bundles a circuit file (main .dig), all referenced subcircuit .dig files,
 * and optional data files into a ZIP archive for distribution and compatibility
 * with the original Digital application.
 *
 * Uses fflate for ZIP creation (~8KB gzipped, pure JS, works in browser and Node).
 */

import { zip } from "fflate";
import type { Circuit } from "../core/circuit.js";
import { serializeCircuit } from "../io/save.js";

export interface ZipExportOptions {
  /**
   * Optional data files referenced by memory components.
   * Key: filename (e.g., "memory.hex"), Value: file content as ArrayBuffer.
   * Default: empty map.
   */
  dataFiles?: Map<string, ArrayBuffer>;
}

/**
 * Export a circuit and its dependencies to a ZIP Blob.
 *
 * The main circuit is serialized from the Circuit object. The filename is
 * derived from the circuit's metadata name with a ".dig" extension.
 *
 * @param circuit — The main circuit to serialize and include
 * @param subcircuits — Map of subcircuit filenames to their serialized XML content
 * @param dataFiles — Optional map of data files (filenames to ArrayBuffers)
 * @returns A promise that resolves with a Blob of type "application/zip"
 */
export function exportZip(
  circuit: Circuit,
  subcircuits: Map<string, string>,
  dataFiles?: Map<string, ArrayBuffer>,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    try {
      const mainFileName = `${circuit.metadata.name}.dig`;
      const mainCircuitContent = serializeCircuit(circuit);

      // Build the file map for fflate.zip()
      // fflate expects: { [path: string]: Uint8Array | [Uint8Array, { ...options }] }
      const files: Record<string, Uint8Array | [Uint8Array, object]> = {};

      // Add main circuit
      files[mainFileName] = new TextEncoder().encode(mainCircuitContent);

      // Add subcircuits
      for (const [filename, content] of subcircuits) {
        files[filename] = new TextEncoder().encode(content);
      }

      // Add data files (binary data)
      if (dataFiles) {
        for (const [filename, buffer] of dataFiles) {
          files[filename] = new Uint8Array(buffer);
        }
      }

      // Create the ZIP archive
      zip(files, (err, data) => {
        if (err) {
          reject(new Error("ZIP creation failed"));
          return;
        }

        // Convert Uint8Array to Blob
        const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/zip" });
        resolve(blob);
      });
    } catch (err) {
      reject(err);
    }
  });
}
