#!/usr/bin/env node
/**
 * MCP Server entry point — run this to expose Prism as an MCP tool server.
 *
 * Usage:
 *   npx ts-node src/mcp/index.ts
 *   # or after build:
 *   node dist/mcp/index.js
 *
 * Configure in Claude Desktop's claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "prism": {
 *       "command": "node",
 *       "args": ["/path/to/agentw/dist/mcp/index.js"]
 *     }
 *   }
 * }
 */

import { McpServer } from './McpServer';

const mcpServer = new McpServer();

mcpServer.start().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await mcpServer.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await mcpServer.stop();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
