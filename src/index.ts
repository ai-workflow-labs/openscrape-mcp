#!/usr/bin/env node
/**
 * OpenScrape MCP — a local, free web-data server, over stdio.
 *
 * This is the entry point MCP clients spawn: Claude Desktop, Claude Code,
 * Cursor and anything else that speaks MCP. Everything runs on this machine —
 * no API key, no credits, no per-page billing, and nothing leaves the box
 * except the request to the site being scraped.
 *
 * stdio is the mode to prefer: it opens no port, so there is no network
 * surface at all. For a remote MCP URL see `src/mcp/http.ts`, which carries
 * the warnings that come with exposing this.
 *
 * The server definition itself lives in `mcp/server.ts`, shared with the HTTP
 * transport so the two cannot drift apart.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, runStartupTasks, installProcessHandlers } from './mcp/server.js';
import { log } from './core/util/log.js';

runStartupTasks();
installProcessHandlers();

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the JSON-RPC channel, so every log line goes to stderr.
log.info('openscrape mcp ready on stdio');
