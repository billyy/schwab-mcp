#!/usr/bin/env node

/**
 * Schwab MCP Bridge
 *
 * This script bridges STDIO (for Claude Desktop) to SSE (your remote Schwab MCP server)
 *
 * Usage in Claude Desktop config:
 * {
 *   "schwab": {
 *     "command": "node",
 *     "args": ["/Users/Billy/git/schwab-mcp/schwab-bridge.js"]
 *   }
 * }
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SSE_URL = 'https://schwab-mcp-personal.billyy.workers.dev/sse';

// Create a server that Claude Desktop will connect to via STDIO
const server = new Server(
  {
    name: 'schwab-bridge',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Create a client that will connect to your remote SSE server
const client = new Client(
  {
    name: 'schwab-bridge-client',
    version: '1.0.0',
  },
  {
    capabilities: {},
  }
);

let remoteTools = [];

// Forward tool list requests
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: remoteTools };
});

// Forward tool call requests
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await client.request(
    {
      method: 'tools/call',
      params: request.params,
    },
    CallToolRequestSchema
  );
  return result;
});

// Forward resource list requests
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const result = await client.request(
      {
        method: 'resources/list',
        params: {},
      },
      ListResourcesRequestSchema
    );
    return result;
  } catch (error) {
    return { resources: [] };
  }
});

// Forward prompt list requests
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  try {
    const result = await client.request(
      {
        method: 'prompts/list',
        params: {},
      },
      ListPromptsRequestSchema
    );
    return result;
  } catch (error) {
    return { prompts: [] };
  }
});

async function main() {
  try {
    console.error('[Bridge] Starting Schwab MCP Bridge...');
    console.error(`[Bridge] Connecting to remote server: ${SSE_URL}`);

    // Connect to remote SSE server
    const sseTransport = new SSEClientTransport(new URL(SSE_URL));
    await client.connect(sseTransport);

    console.error('[Bridge] Connected to remote server');

    // Fetch available tools from remote server
    const toolsList = await client.request(
      {
        method: 'tools/list',
        params: {},
      },
      ListToolsRequestSchema
    );
    remoteTools = toolsList.tools || [];
    console.error(`[Bridge] Loaded ${remoteTools.length} tools from remote server`);

    // Start STDIO server for Claude Desktop
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);

    console.error('[Bridge] STDIO server ready for Claude Desktop');
    console.error('[Bridge] Bridge is running. Press Ctrl+C to stop.');
  } catch (error) {
    console.error('[Bridge] Error:', error.message);
    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      console.error('[Bridge] Authentication required. Please run the OAuth flow first:');
      console.error('[Bridge] 1. Open MCP Inspector: npm run inspect');
      console.error('[Bridge] 2. Connect to:', SSE_URL);
      console.error('[Bridge] 3. Complete OAuth flow');
      console.error('[Bridge] 4. Then restart this bridge');
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[Bridge] Fatal error:', error);
  process.exit(1);
});
