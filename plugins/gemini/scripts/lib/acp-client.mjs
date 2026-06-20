/**
 * JSON-RPC 2.0 client for the Gemini CLI Agent Client Protocol (ACP) runtime.
 *
 * ACP is bidirectional: besides the usual client -> agent requests
 * (`session/new`, `session/prompt`, ...) the agent issues server -> client
 * requests back to us, most importantly `session/request_permission`. This
 * client therefore dispatches incoming server requests to a handler (defaulting
 * to auto-approval) and replies with a JSON-RPC response, unlike a one-way
 * notification stream.
 *
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {(message: object) => void} AcpNotificationHandler
 * @typedef {(message: object) => Promise<unknown> | unknown} AcpServerRequestHandler
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "GEMINI_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
export const ACP_PROTOCOL_VERSION = 1;

const DEFAULT_CLIENT_INFO = {
  name: "Gemini Plugin",
  title: "Gemini Plugin for Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/**
 * Client capabilities advertised at `initialize`. We deliberately do NOT
 * advertise the `fs`/`terminal` capabilities, so Gemini performs file and
 * shell operations itself; we observe them through `session/update`
 * notifications instead of proxying them.
 */
const DEFAULT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

/**
 * Pick the option that grants the request when auto-approving a
 * `session/request_permission`. Prefer a one-shot allow, then a persistent
 * allow, then any non-reject option, then the first option.
 */
export function pickAllowPermissionOption(options = []) {
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }
  const byKind = (kind) => options.find((option) => option?.kind === kind);
  const allowOnce = byKind("allow_once");
  if (allowOnce) {
    return allowOnce.optionId;
  }
  const allowAlways = byKind("allow_always");
  if (allowAlways) {
    return allowAlways.optionId;
  }
  const nonReject = options.find((option) => !String(option?.kind ?? "").startsWith("reject"));
  return (nonReject ?? options[0])?.optionId ?? null;
}

/**
 * Default handler for agent -> client requests. Auto-approves permission
 * prompts (mirroring Codex's `approvalPolicy: "never"`) and rejects anything
 * else with method-not-found, since we advertise no client-side capabilities.
 */
function defaultServerRequestHandler(message) {
  if (message.method === "session/request_permission") {
    const optionId = pickAllowPermissionOption(message.params?.options);
    if (optionId) {
      return { outcome: { type: "selected", optionId } };
    }
    return { outcome: { type: "cancelled" } };
  }
  throw createProtocolError(`Unsupported agent request: ${message.method}`, { code: -32601 });
}

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AcpNotificationHandler | null} */
    this.notificationHandler = null;
    /** @type {AcpServerRequestHandler} */
    this.serverRequestHandler = options.serverRequestHandler ?? defaultServerRequestHandler;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler ?? defaultServerRequestHandler;
  }

  request(method, params) {
    if (this.closed) {
      throw new Error("Gemini ACP client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  respond(id, result, error) {
    if (error) {
      this.sendMessage({ jsonrpc: "2.0", id, error });
    } else {
      this.sendMessage({ jsonrpc: "2.0", id, result: result ?? {} });
    }
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse Gemini ACP JSONL: ${error.message}`, { line }));
      return;
    }

    // Agent -> client request (has id AND method).
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    // Response to one of our requests.
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `Gemini ACP ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    // Notification.
    if (message.method && this.notificationHandler) {
      this.notificationHandler(message);
    }
  }

  async handleServerRequest(message) {
    try {
      const result = await this.serverRequestHandler(message);
      this.respond(message.id, result);
    } catch (error) {
      const rpcError =
        error && typeof error === "object" && "data" in error && error.data?.code !== undefined
          ? error.data
          : buildJsonRpcError(-32603, error instanceof Error ? error.message : String(error));
      this.respond(message.id, undefined, rpcError);
    }
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("Gemini ACP connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("gemini", ["--acp"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(`gemini --acp exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES,
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO
    });
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("gemini --acp stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES,
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO
    });
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("Gemini ACP broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class AcpClient {
  static async connect(cwd, options = {}) {
    const disableBroker = options.disableBroker || process.env.GEMINI_COMPANION_DISABLE_BROKER === "1";
    let brokerEndpoint = null;
    if (!disableBroker) {
      brokerEndpoint =
        options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerAcpClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedAcpClient(cwd, options);
    await client.initialize();
    return client;
  }
}
