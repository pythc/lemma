// Small stdio MCP transport. Authorization and execution remain on the server.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
const endpoint = process.env.LEMMA_TEAM_ENDPOINT,
  token = process.env.LEMMA_TEAM_TOKEN;
const send = (id, result, error) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(error ? { error } : { result }),
    }) + "\n",
  );
async function request(route, body) {
  const r = await fetch(endpoint + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error || `HTTP ${r.status}`);
  return result;
}
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  try {
    if (msg.method === "initialize")
      return send(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "lemma-team", version: "1.0.0" },
      });
    if (msg.method === "ping") return send(msg.id, {});
    if (msg.method === "tools/list")
      return send(msg.id, { tools: await request("/tools", {}) });
    if (msg.method === "tools/call") {
      try {
        let operationId =
          msg.params.name === "get_operation"
            ? msg.params.arguments.operationId
            : randomUUID();
        let op;
        try {
          op =
            msg.params.name === "get_operation"
              ? await request("/operations/get", { operationId })
              : await request("/operations/start", {
                  ...msg.params,
                  operationId,
                });
          operationId = op.operationId || operationId;
          const delivery = {
            delivery: op.delivery,
            newNativeExecution: op.newNativeExecution,
            resultMeaning: op.resultMeaning,
          };
          // Short polls return before transport deadlines. The caller can release
          // its model slot with yield_work; long operations keep their identity.
          const until = Date.now() + 1000;
          while (op.status === "running" && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 100));
            op = {
              ...(await request("/operations/get", { operationId })),
              ...delivery,
            };
          }
        } catch (e) {
          return send(msg.id, {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  operationId,
                  status: "transport_unknown",
                  error: e.message,
                  code: e.code || null,
                  cause: e.cause?.message || null,
                  causeCode: e.cause?.code || null,
                  guidance:
                    "Use get_operation to query this original ID. No request has been replayed.",
                }),
              },
            ],
          });
        }
        if (["failed", "cancelled", "unknown", "not_found"].includes(op.status))
          return send(msg.id, {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(op) }],
          });
        const result =
          op.status === "completed"
            ? {
                ...op.result,
                operationId,
                operationArtifactId: op.artifactId,
                delivery: op.delivery,
                newNativeExecution: op.newNativeExecution,
                resultMeaning: op.resultMeaning,
              }
            : op;
        const image = result.pageImage;
        const content = [
          {
            type: "text",
            text: JSON.stringify({
              ...result,
              ...(image ? { pageImage: { ...image, base64: undefined } } : {}),
            }),
          },
        ];
        if (image?.base64)
          content.push({
            type: "image",
            mimeType: image.mimeType,
            data: image.base64,
          });
        return send(msg.id, { content });
      } catch (e) {
        return send(msg.id, {
          isError: true,
          content: [{ type: "text", text: e.message }],
        });
      }
    }
    send(msg.id, null, { code: -32601, message: "Method not found" });
  } catch (e) {
    send(msg.id, null, { code: -32603, message: e.message });
  }
});
