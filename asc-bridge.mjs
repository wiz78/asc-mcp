#!/usr/bin/env node
import { request } from "node:http";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { bridgeUploadTools, bridgeUpload, mediaUploadTools, bridgeMediaUpload } from "./asc-bridge-upload.mjs";
import { tools } from "./asc-operations.mjs";

const socketPath = process.argv[3] || "/Library/Application Support/ASCScoped/run/asc.sock";
const app = process.argv[2] === "--team" ? "@team" : process.argv[2];
if (app !== "@team" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(app || "")) {
  console.error("Pass a configured app alias or --team as the first argument.");
  process.exit(1);
}

function call(operation, input) {
  const body = JSON.stringify({ app, operation, input });
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, agent: false, method: "POST", path: "/call",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      signal: AbortSignal.timeout(operation === "_media_commit" ? 300_000 : 45_000)
    }, async res => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of res) {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw new Error("Oversized daemon response");
          chunks.push(chunk);
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch { reject(new Error("Invalid daemon response")); }
    });
    req.on("error", reject);
    req.end(body);
  });
}

const localUploadTools = { ...bridgeUploadTools, ...mediaUploadTools };

let inventory;
async function discover() {
  if (inventory) return inventory;
  const response = await call("_catalog", {});
  if (response.error === "Unknown operation." && app !== "@team") {
    inventory = Object.entries({ ...tools, ...bridgeUploadTools }).map(([name, [description, schema]]) => {
      const inputSchema = z.toJSONSchema(schema, { unrepresentable: "any" });
      delete inputSchema.$schema;
      return { name, description, inputSchema };
    });
  } else if (response.error) throw new Error("Daemon discovery failed");
  else inventory = response.result.tools;
  return inventory;
}

const server = new Server({ name: "asc-scoped", version: "0.1.0-preview" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (await discover()).map(tool => ({ ...tool, description: "[" + app + "] " + tool.description }))
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  let response;
  try {
    if (!(await discover()).some(tool => tool.name === params.name)) {
      response = { error: "Operation is not exposed by the daemon." };
    } else if (Object.hasOwn(localUploadTools, params.name)) {
      const parsed = localUploadTools[params.name][1].safeParse(params.arguments || {});
      const upload = Object.hasOwn(mediaUploadTools, params.name) ? bridgeMediaUpload : bridgeUpload;
      response = parsed.success ? await upload(call, params.name, parsed.data) : { error: "Invalid upload arguments." };
    } else response = await call(params.name, params.arguments || {});
  } catch { response = { error: "Local ASC daemon unavailable." }; }
  return response.error
    ? { isError: true, content: [{ type: "text", text: response.error + (response.appleErrors ? "\n" + JSON.stringify(response.appleErrors, null, 2) : "") }] }
    : { content: [{ type: "text", text: JSON.stringify(response.result) }] };
});
await server.connect(new StdioServerTransport());
