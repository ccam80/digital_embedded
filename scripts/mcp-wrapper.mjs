#!/usr/bin/env node
/**
 * MCP Stdio Proxy Wrapper
 *
 * Sits between the MCP client (Claude Code) and the real MCP server process.
 * Keeps the client's stdio pipe alive while allowing the server child to be
 * restarted (to pick up code changes) via the `server_restart` tool.
 *
 * The wrapper captures the MCP initialize/initialized handshake and replays
 * it to each new child. All other messages are proxied transparently.
 *
 * Usage (in .mcp.json):
 *   "command": "node", "args": ["scripts/mcp-wrapper.mjs"]
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

// -- Config ------------------------------------------------------------------

const CHILD_CMD = "node";
const CHILD_ARGS = ["--import", "tsx/esm", "scripts/circuit-mcp-server.ts"];
const RESTART_EXIT_CODE = 120; // Server exits with this to request restart

// -- State -------------------------------------------------------------------

/** @type {{ method: string, id?: number|string, params?: any }[]} */
let initMessages = []; // captured init handshake (client → server)
let child = null;
/** @type {Map<number|string, boolean>} */
const pendingRequests = new Map(); // track in-flight request IDs
let restarting = false;
/** @type {Set<number|string>} IDs of replayed init messages- suppress their responses */
const suppressedIds = new Set();

// -- Child lifecycle ---------------------------------------------------------

function spawnChild() {
  child = spawn(CHILD_CMD, CHILD_ARGS, {
    stdio: ["pipe", "pipe", "inherit"], // inherit stderr for diagnostics
    cwd: process.cwd(),
  });

  // Child stdout → client stdout (proxy responses back)
  const childRL = createInterface({ input: child.stdout, crlfDelay: Infinity });
  childRL.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      // Suppress responses to replayed init messages (client didn't ask for these)
      if (msg.id !== undefined && !msg.method) {
        if (suppressedIds.has(msg.id)) {
          suppressedIds.delete(msg.id);
          return; // swallow- client already got this response on first boot
        }
        pendingRequests.delete(msg.id);
      }
    } catch {
      // Not valid JSON- proxy anyway
    }
    process.stdout.write(line + "\n");
  });

  child.on("exit", (code) => {
    if (code === RESTART_EXIT_CODE || restarting) {
      restarting = false;
      process.stderr.write("[mcp-wrapper] Server exited for restart, spawning new child...\n");
      spawnChild();
      replayInit();
    } else {
      // Unexpected exit- propagate to client
      process.stderr.write(`[mcp-wrapper] Server exited with code ${code}, shutting down.\n`);
      process.exit(code ?? 1);
    }
  });

  child.on("error", (err) => {
    process.stderr.write(`[mcp-wrapper] Child spawn error: ${err.message}\n`);
    process.exit(1);
  });
}

function replayInit() {
  for (const msg of initMessages) {
    // Mark request IDs so their responses are suppressed (client already got them)
    if (msg.id !== undefined) {
      suppressedIds.add(msg.id);
    }
    sendToChild(msg);
  }
}

function sendToChild(msg) {
  if (child?.stdin?.writable) {
    child.stdin.write(JSON.stringify(msg) + "\n");
  }
}

// -- Client stdin → child stdin (proxy requests) ----------------------------

function handleClientMessage(line) {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // Not valid JSON- forward raw
    sendToChild(line);
    return;
  }

  // Capture init handshake for replay on restart
  if (msg.method === "initialize" || msg.method === "notifications/initialized") {
    initMessages.push(msg);
  }

  // Track pending requests
  if (msg.id !== undefined && msg.method) {
    pendingRequests.set(msg.id, true);
  }

  sendToChild(msg);
}

// -- Main --------------------------------------------------------------------

spawnChild();

const stdinRL = createInterface({ input: process.stdin, crlfDelay: Infinity });
stdinRL.on("line", handleClientMessage);

// If client disconnects, tear down everything
stdinRL.on("close", () => {
  if (child) child.kill();
  process.exit(0);
});

// Don't crash on broken pipe
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});
