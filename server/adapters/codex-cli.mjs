import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_MODEL = "gpt-6-sol";
export const CODEX_EFFORT = "high";
export function codexFailure(message) {
  return Object.assign(Error(message), {
    code: /^Selected model is at capacity(?:[.!]|$)/i.test(message.trim())
      ? "codex_capacity"
      : "codex_failed",
  });
}
const bridge = fileURLToPath(new URL("./team-mcp.mjs", import.meta.url));
export function cliArgs(directory, endpoint) {
  const config = {
    model_reasoning_effort: CODEX_EFFORT,
    approval_policy: "never",
    project_doc_max_bytes: 0,
    "features.shell_tool": false,
    "features.multi_agent": false,
    "mcp_servers.lemma.command": process.execPath,
    "mcp_servers.lemma.args": [bridge],
    "mcp_servers.lemma.env_vars": ["LEMMA_TEAM_TOKEN", "LEMMA_TEAM_ENDPOINT"],
    "mcp_servers.lemma.tool_timeout_sec": 7200,
    "mcp_servers.lemma.startup_timeout_sec": 30,
    "mcp_servers.lemma.required": true,
    "mcp_servers.lemma.default_tools_approval_mode": "approve",
    "mcp_servers.lemma.tools.read_source.output_token_limit": 80000,
    "mcp_servers.lemma.tools.read_evidence.output_token_limit": 32000,
    "mcp_servers.lemma.tools.workspace_read.output_token_limit": 64000,
    "mcp_servers.lemma.tools.read_board.output_token_limit": 48000,
    "mcp_servers.lemma.tools.discover_tools.output_token_limit": 24000,
    web_search: "live",
  };
  return [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    directory,
    "-s",
    "read-only",
    "-m",
    CODEX_MODEL,
    "--json",
    ...Object.entries(config).flatMap(([k, v]) => [
      "-c",
      `${k}=${JSON.stringify(v)}`,
    ]),
    "-",
  ];
}

// Never serialize raw CLI events: reasoning items are deliberately discarded.
export function publicCliEvent(event) {
  if (event.type === "turn.completed")
    return { type: event.type, usage: event.usage };
  if (event.type === "turn.failed" || event.type === "error")
    return {
      type: event.type,
      error: String(
        event.error?.message || event.message || "Codex execution failed",
      ).slice(0, 2000),
    };
  if (event.type === "item.completed" && event.item?.type === "agent_message")
    return { type: "message", text: event.item.text };
  return null;
}

export class CodexCliAdapter {
  constructor({ binary = process.env.LEMMA_CODEX_BINARY || "codex" } = {}) {
    this.binary = binary;
  }
  async run({ prompt, endpoint, token, signal, onEvent }) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lemma-agent-"));
    try {
      return await new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const env = Object.fromEntries(
          ["PATH", "HOME", "TMPDIR", "LANG", "CODEX_HOME"]
            .filter((k) => process.env[k])
            .map((k) => [k, process.env[k]]),
        );
        const child = spawn(this.binary, cliArgs(directory, endpoint), {
          cwd: directory,
          detached: true,
          env: {
            ...env,
            LEMMA_TEAM_TOKEN: token,
            LEMMA_TEAM_ENDPOINT: endpoint,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let buffer = "",
          failed = null,
          usage = null,
          text = "",
          pending = Promise.resolve();
        let killTimer;
        const stop = () => {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {}
          killTimer = setTimeout(() => {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }, 3000);
          killTimer.unref();
        };
        signal?.addEventListener("abort", stop, { once: true });
        child.stdout.on("data", (bytes) => {
          buffer += bytes.toString();
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const e = publicCliEvent(JSON.parse(line));
              if (!e) continue;
              if (e.type === "message") text = e.text;
              if (e.error) failed = e.error;
              if (e.type === "turn.completed") failed = null;
              if (e.usage) usage = e.usage;
              pending = pending.then(() => onEvent?.(e));
            } catch {
              /* Non-JSON output is not evidence. */
            }
          }
        });
        child.stderr.on("data", () => {}); // CLI diagnostics may contain host metadata.
        child.on("error", reject);
        child.on("close", async (code) => {
          clearTimeout(killTimer);
          signal?.removeEventListener("abort", stop);
          try {
            await pending;
          } catch (e) {
            reject(e);
            return;
          }
          if (signal?.aborted)
            reject(Object.assign(Error("Cancelled"), { code: "cancelled" }));
          else if (code !== 0 || failed)
            reject(codexFailure(failed || `Codex exited ${code}`));
          else
            resolve({
              model: CODEX_MODEL,
              reasoningEffort: CODEX_EFFORT,
              usage,
              text,
            });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(prompt);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
