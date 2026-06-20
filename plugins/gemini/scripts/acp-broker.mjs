#!/usr/bin/env node
/**
 * Shared Gemini ACP runtime broker.
 *
 * Spawns ONE `gemini --acp` process and lets multiple short-lived plugin
 * commands reuse it over a Unix socket, so they share a warm process and the
 * same authenticated state. The broker is single-tenant: the first command to
 * forward a request owns the runtime until its socket closes; concurrent
 * commands get a BUSY error and transparently fall back to a direct
 * `gemini --acp` spawn (see `withAcp` in lib/gemini.mjs).
 *
 * ACP is bidirectional, so besides forwarding client -> agent requests and
 * routing `session/update` notifications back, the broker also relays agent ->
 * client requests (e.g. `session/request_permission`) to the active socket and
 * pipes that socket's response back to the agent.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { AcpClient, ACP_PROTOCOL_VERSION, BROKER_BUSY_RPC_CODE } from "./lib/acp-client.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (!socket || socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/acp-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await AcpClient.connect(cwd, { disableBroker: true });

  /** The socket that currently owns the shared runtime. */
  let activeSocket = null;
  /** Pending agent -> client requests, keyed by the agent-assigned id. */
  const pendingServerRequests = new Map();
  let nextServerRequestKey = 1;
  const sockets = new Set();

  function releaseSocket(socket) {
    if (activeSocket === socket) {
      activeSocket = null;
    }
    for (const [key, pending] of pendingServerRequests) {
      if (pending.socket === socket) {
        pending.reject(new Error("Client socket closed before responding."));
        pendingServerRequests.delete(key);
      }
    }
  }

  // Route agent -> client notifications (session/update, etc.) to the owner.
  appClient.setNotificationHandler((message) => {
    if (activeSocket) {
      send(activeSocket, message);
    }
  });

  // Relay agent -> client requests to the owner and await its reply.
  appClient.setServerRequestHandler((message) => {
    if (!activeSocket) {
      // Nobody to ask: deny so the agent does not hang.
      throw Object.assign(new Error("No active client for permission request."), {
        data: buildJsonRpcError(-32601, "No active client.")
      });
    }
    const owner = activeSocket;
    return new Promise((resolve, reject) => {
      const key = nextServerRequestKey++;
      pendingServerRequests.set(key, { resolve, reject, socket: owner, id: message.id });
      send(owner, { jsonrpc: "2.0", id: message.id, method: message.method, params: message.params, _brokerKey: key });
    });
  });

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  function resolveServerRequestResponse(message) {
    // A response from a client carries an id but no method. Match it to the
    // agent -> client request we relayed (by broker key if present, else id).
    let entry = null;
    if (message._brokerKey !== undefined && pendingServerRequests.has(message._brokerKey)) {
      entry = { key: message._brokerKey, pending: pendingServerRequests.get(message._brokerKey) };
    } else {
      for (const [key, pending] of pendingServerRequests) {
        if (pending.id === message.id) {
          entry = { key, pending };
          break;
        }
      }
    }
    if (!entry) {
      return false;
    }
    pendingServerRequests.delete(entry.key);
    if (message.error) {
      entry.pending.reject(Object.assign(new Error(message.error.message ?? "client error"), { data: message.error }));
    } else {
      entry.pending.resolve(message.result ?? {});
    }
    return true;
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, { jsonrpc: "2.0", id: null, error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`) });
          continue;
        }

        // Handshake: answer locally; the agent was initialized once at startup.
        if (message.id !== undefined && message.method === "initialize") {
          send(socket, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: ACP_PROTOCOL_VERSION } });
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { jsonrpc: "2.0", id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        // Client response to an agent -> client request we relayed.
        if (message.id !== undefined && !message.method) {
          resolveServerRequestResponse(message);
          continue;
        }

        // Client notification (e.g. session/cancel): forward to the agent.
        if (message.id === undefined && message.method) {
          appClient.notify(message.method, message.params ?? {});
          continue;
        }

        if (message.id === undefined) {
          continue;
        }

        // Client -> agent request. Enforce single-tenant ownership.
        if (activeSocket && activeSocket !== socket) {
          send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Gemini broker is busy.") });
          continue;
        }
        activeSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { jsonrpc: "2.0", id: message.id, result });
        } catch (error) {
          send(socket, { jsonrpc: "2.0", id: message.id, error: buildJsonRpcError(error.rpcCode ?? -32000, error.message) });
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      releaseSocket(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      releaseSocket(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
