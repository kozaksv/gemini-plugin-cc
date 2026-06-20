import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Installs a fake `gemini` binary that speaks the Agent Client Protocol
 * (`gemini --acp`) over stdio, so the runtime can be exercised without the real
 * Gemini CLI, a network connection, or credentials.
 *
 * Behaviors:
 * - "ok"             : authenticated; prompts return a final message echoing the prompt.
 * - "unauthenticated": session/new fails with an auth error.
 * - "tool"           : prompts emit a tool_call touching a file before answering.
 * - "json"           : prompts return a small valid review JSON object.
 */
export function installFakeGemini(binDir, behavior = "ok") {
  const statePath = path.join(binDir, "fake-gemini-state.json");
  const scriptPath = path.join(binDir, "gemini");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { acpStarts: 0, sessions: 0, prompts: 0, lastCancel: null };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("0.47.0\\n");
  process.exit(0);
}
if (!argv.includes("--acp")) {
  process.stdout.write("Gemini CLI (fake)\\n");
  process.exit(0);
}

(() => { const s = loadState(); s.acpStarts = (s.acpStarts || 0) + 1; saveState(s); })();

let nextSession = 1;
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}
function notify(sessionId, update) {
  send({ method: "session/update", params: { sessionId, update } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Client response to an agent->client request: ignore (we never ask).
  if (msg.id !== undefined && !msg.method) return;

  if (msg.method === "session/cancel") {
    const s = loadState(); s.lastCancel = msg.params && msg.params.sessionId; saveState(s);
    return;
  }
  if (msg.id === undefined) return; // other notifications

  const reply = (result) => send({ id: msg.id, result });
  const fail = (code, message) => send({ id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        authMethods: [
          { id: "oauth-personal", name: "Log in with Google" },
          { id: "gemini-api-key", name: "Gemini API key" }
        ],
        agentInfo: { name: "gemini-cli", title: "Gemini CLI", version: "0.47.0" },
        agentCapabilities: { loadSession: true }
      });
      break;
    case "session/new": {
      if (BEHAVIOR === "unauthenticated") {
        fail(-32000, "This client is no longer supported for Gemini Code Assist for individuals. Migrate to Antigravity.");
        break;
      }
      const s = loadState(); s.sessions = (s.sessions || 0) + 1; saveState(s);
      const sessionId = "fake-session-" + (nextSession++);
      reply({
        sessionId,
        modes: {
          availableModes: [
            { id: "default", name: "Default" },
            { id: "autoEdit", name: "Auto Edit" },
            { id: "yolo", name: "YOLO" },
            { id: "plan", name: "Plan" }
          ],
          currentModeId: "default"
        },
        models: {
          availableModels: [
            { modelId: "auto", name: "Auto" },
            { modelId: "gemini-2.5-pro", name: "gemini-2.5-pro" },
            { modelId: "gemini-3.5-flash", name: "gemini-3.5-flash" },
            { modelId: "gemini-3.1-flash-lite", name: "gemini-3.1-flash-lite" }
          ],
          currentModelId: "auto"
        }
      });
      break;
    }
    case "session/load":
      reply({
        modes: { availableModes: [{ id: "plan", name: "Plan" }, { id: "yolo", name: "YOLO" }], currentModeId: "default" },
        models: { availableModels: [{ modelId: "auto", name: "Auto" }], currentModelId: "auto" }
      });
      break;
    case "session/set_mode":
    case "session/set_model":
    case "session/close":
      reply({});
      break;
    case "session/prompt": {
      const s = loadState(); s.prompts = (s.prompts || 0) + 1; saveState(s);
      const sessionId = msg.params && msg.params.sessionId;
      const promptText = (((msg.params || {}).prompt || []).map((p) => p.text || "").join(" ")).trim();
      notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Considering the request." } });
      if (BEHAVIOR === "tool") {
        notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress", title: "edit app.txt", kind: "edit", locations: [{ path: "/tmp/app.txt" }] });
        notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", title: "edit app.txt", kind: "edit", locations: [{ path: "/tmp/app.txt" }] });
      }
      let answer;
      if (BEHAVIOR === "json") {
        answer = JSON.stringify({ verdict: "approve", summary: "Looks fine.", findings: [], next_steps: [] });
      } else {
        answer = "FAKE_GEMINI_ANSWER for: " + (promptText.slice(0, 40) || "(empty)");
      }
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
      reply({ stopReason: "end_turn" });
      break;
    }
    default:
      fail(-32601, "Unknown method: " + msg.method);
  }
});
`;
  writeExecutable(scriptPath, source);
  return { scriptPath, statePath };
}

/**
 * Build an env where the fake `gemini` is first on PATH. Defaults to direct
 * (no shared broker) so each command spawns and tears down its own fake runtime;
 * pass `{ GEMINI_COMPANION_DISABLE_BROKER: undefined }` to exercise the broker.
 */
export function buildEnv(binDir, overrides = {}) {
  const nodeDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${nodeDir}${path.delimiter}${process.env.PATH ?? ""}`,
    GEMINI_COMPANION_DISABLE_BROKER: "1"
  };
  delete env.GEMINI_COMPANION_ACP_ENDPOINT;
  delete env.CLAUDE_PLUGIN_DATA;
  const merged = { ...env, ...overrides };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) {
      delete merged[key];
    }
  }
  return merged;
}

export function readFixtureState(binDir) {
  const statePath = path.join(binDir, "fake-gemini-state.json");
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { acpStarts: 0, sessions: 0, prompts: 0, lastCancel: null };
  }
}
