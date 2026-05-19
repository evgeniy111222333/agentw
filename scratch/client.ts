import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
    console.log("Starting client...");
    const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/mcp/index.js"]
    });

    const client = new Client({
        name: "test-client",
        version: "1.0.0"
    }, {
        capabilities: {}
    });

    try {
        console.log("Connecting to MCP server...");
        await client.connect(transport);
        console.log("Connected!");

        console.log("Requesting tools list...");
        const listRes = await client.listTools();
        console.log("Tools available:", listRes.tools.map((t: any) => t.name).join(", "));

        console.log("Testing browser_navigate...");
        const navRes = await client.callTool({
            name: "browser_navigate",
            arguments: { url: "https://example.com" }
        });
        console.log("Navigate Result:", JSON.stringify(navRes, null, 2));

        console.log("Testing browser_snapshot...");
        const snapRes = await client.callTool({
            name: "browser_snapshot",
            arguments: { max_elements: 10, snapshot_mode: "compact" }
        });
        
        // Truncate snapshot output to keep it clean
        const snapData = JSON.parse((snapRes as any).content[0].text);
        console.log(`Snapshot received! Elements count: ${snapData.elements?.length || 0}`);
        console.log("Snapshot metadata:", JSON.stringify(snapData.meta, null, 2));

    } catch (e) {
        console.error("Error:", e);
    } finally {
        console.log("Closing transport...");
        await transport.close();
        process.exit(0);
    }
}

main();