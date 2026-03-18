/**
 * Node.js polyfill for the browser-native DecompressionStream API.
 *
 * The CTZ URL parser uses DecompressionStream('deflate') to decompress
 * CircuitJS URL fragments. In the browser this is a built-in API. In
 * Node.js (vitest environment) it is absent, so this polyfill installs
 * a compatible implementation using node:zlib.
 *
 * Import this file in test setup or at the top of any test that exercises
 * the CTZ parser.
 */

import { inflateRawSync } from "node:zlib";

/**
 * Minimal DecompressionStream polyfill for 'deflate-raw' (raw deflate,
 * no zlib wrapper). CircuitJS URL fragments use raw deflate after base64
 * decoding.
 *
 * The polyfill implements the TransformStream-like interface that the
 * CTZ parser uses: pipeThrough() support is provided by wrapping in a
 * standard ReadableStream pipeline.
 */
class NodeDecompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(format: string) {
    if (format !== "deflate" && format !== "deflate-raw") {
      throw new Error(
        `NodeDecompressionStream polyfill: unsupported format '${format}'. ` +
          `Only 'deflate' and 'deflate-raw' are supported.`,
      );
    }

    const chunks: Uint8Array[] = [];
    let resolveWritable!: () => void;
    const writableFinished = new Promise<void>((r) => {
      resolveWritable = r;
    });

    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
      close() {
        resolveWritable();
      },
    });

    this.readable = new ReadableStream<Uint8Array>({
      start(controller) {
        writableFinished
          .then(() => {
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const combined = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              combined.set(chunk, offset);
              offset += chunk.length;
            }
            const decompressed = inflateRawSync(combined);
            controller.enqueue(decompressed);
            controller.close();
          })
          .catch((err: unknown) => {
            controller.error(err);
          });
      },
    });
  }
}

// Install the polyfill only when the native API is absent.
if (typeof globalThis.DecompressionStream === "undefined") {
  (globalThis as Record<string, unknown>).DecompressionStream =
    NodeDecompressionStream;
}
