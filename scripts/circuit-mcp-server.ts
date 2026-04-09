/**
 * Circuit MCP Server
 *
 * Exposes the headless circuit API as Model Context Protocol tools.
 * This is the primary interface for LLM agents to interact with circuits.
 *
 * Run with: npx tsx scripts/circuit-mcp-server.ts
 * The server listens on stdin/stdout using the MCP stdio transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDefaultRegistry } from "../src/components/register-all.js";
import { DefaultSimulatorFacade } from "../src/headless/default-facade.js";
import { SessionState } from "./mcp/tool-helpers.js";
import { registerCircuitTools } from "./mcp/circuit-tools.js";
import { registerTutorialTools } from "./mcp/tutorial-tools.js";
import { registerSimulationTools } from "./mcp/simulation-tools.js";
import { HarnessSessionState } from "./mcp/harness-session-state.js";
import { registerHarnessTools } from "./mcp/harness-tools.js";

// ---------------------------------------------------------------------------
// Registry + facade (initialized once)
// ---------------------------------------------------------------------------

const registry = createDefaultRegistry();
const facade = new DefaultSimulatorFacade(registry);
const session = new SessionState();
const harnessState = new HarnessSessionState();

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "circuit-simulator", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use this server to load, inspect, build, patch, compile, and test digital, analog, and mixed-signal circuits. " +
      "Always start with circuit_load or circuit_build to get a handle, then use circuit_netlist to inspect topology. " +
      "Addresses use the format 'componentLabel:pinLabel'. Read netlist output to get exact addresses for patches. " +
      "To compare our engine against ngspice: use harness_start to create a session, " +
      "harness_run to execute analysis, then harness_query or harness_compare_matrix " +
      "to inspect results. harness_describe shows circuit topology. " +
      "harness_dispose releases resources when done.",
  },
);

registerCircuitTools(server, facade, registry, session);
registerTutorialTools(server, facade, registry, session);
registerSimulationTools(server, facade, registry, session);
registerHarnessTools(server, harnessState);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is running — it reads from stdin and writes to stdout
  // Process will stay alive until the transport closes
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
