/**
 * Gemini CLI runtime layer for the plugin.
 *
 * Wraps the Gemini CLI Agent Client Protocol (`gemini --acp`). The agent speaks
 * JSON-RPC 2.0 over stdio: we open a session (`session/new` or `session/load`),
 * set the approval mode and model, then send a single blocking `session/prompt`
 * request. `session/prompt` resolves only when the turn ends (with a
 * `stopReason`), while `session/update` notifications stream tool calls,
 * thoughts, and the agent's message in between. That makes turn capture much
 * simpler than a fire-and-forget protocol: the request promise *is* the
 * completion signal.
 *
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */
import { readJsonFile } from "./fs.mjs";
import { AcpClient, BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV } from "./acp-client.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";

const TASK_THREAD_PREFIX = "Gemini Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

/** Approval modes exposed by Gemini ACP `session/new` -> modes.availableModes. */
const READ_ONLY_MODE = "plan";
const WRITE_MODE = "yolo";

/** Friendly aliases mapped onto concrete Gemini model ids. */
const MODEL_ALIASES = new Map([
  ["pro", "gemini-2.5-pro"],
  ["flash", "gemini-3.5-flash"],
  ["flash-lite", "gemini-3.1-flash-lite"],
  ["lite", "gemini-3.1-flash-lite"],
  ["spark", "gemini-3.1-flash-lite"]
]);

export function resolveModelAlias(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function cleanGeminiStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    String(command ?? "")
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

/** Extract plain text from an ACP ContentBlock or array of them. */
function contentToText(content) {
  if (!content) {
    return "";
  }
  if (Array.isArray(content)) {
    return content.map((entry) => contentToText(entry)).join("");
  }
  if (typeof content === "string") {
    return content;
  }
  if (typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

const EDIT_KINDS = new Set(["edit", "delete", "move", "create"]);

function phaseForToolKind(kind, title) {
  switch (kind) {
    case "edit":
    case "delete":
    case "move":
    case "create":
      return "editing";
    case "execute":
      return looksLikeVerificationCommand(title) ? "verifying" : "running";
    case "read":
    case "search":
    case "fetch":
      return "investigating";
    case "think":
      return "thinking";
    default:
      return "running";
  }
}

function describeToolCall(update, lifecycle) {
  const kind = update.kind ?? "other";
  const title = shorten(update.title ?? update.toolCallId ?? kind, 96);
  const phase = phaseForToolKind(kind, update.title);
  if (lifecycle === "started") {
    return { message: `Tool ${kind}: ${title}`, phase };
  }
  const status = update.status ?? "completed";
  return { message: `Tool ${kind} ${status}: ${title}`, phase };
}

function createTurnState(onProgress) {
  return {
    onProgress: onProgress ?? null,
    messageParts: [],
    reasoning: [],
    touchedFiles: new Set(),
    commandExecutions: [],
    toolKinds: new Map(),
    error: null
  };
}

function recordToolLocations(state, update) {
  const kind = update.kind ?? state.toolKinds.get(update.toolCallId) ?? "other";
  if (update.toolCallId && update.kind) {
    state.toolKinds.set(update.toolCallId, update.kind);
  }
  if (EDIT_KINDS.has(kind)) {
    for (const location of update.locations ?? []) {
      if (location?.path) {
        state.touchedFiles.add(location.path);
      }
    }
  }
  if (kind === "execute" && update.status === "completed") {
    state.commandExecutions.push({
      command: update.title ?? "",
      status: update.status ?? "completed"
    });
  }
}

function applyTurnNotification(state, sessionId, message) {
  if (message.method !== "session/update") {
    return;
  }
  const params = message.params ?? {};
  if (params.sessionId && sessionId && params.sessionId !== sessionId) {
    return;
  }
  const update = params.update;
  if (!update || typeof update !== "object") {
    return;
  }

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = contentToText(update.content);
      if (text) {
        state.messageParts.push(text);
      }
      break;
    }
    case "agent_thought_chunk": {
      const text = contentToText(update.content).trim();
      if (text) {
        state.reasoning.push(text);
        emitProgress(state.onProgress, `Thinking: ${shorten(text, 96)}`, "thinking");
      }
      break;
    }
    case "tool_call": {
      recordToolLocations(state, update);
      const described = describeToolCall(update, "started");
      emitProgress(state.onProgress, described.message, described.phase);
      break;
    }
    case "tool_call_update": {
      recordToolLocations(state, update);
      const described = describeToolCall(update, "completed");
      emitProgress(state.onProgress, described.message, described.phase);
      if (update.status === "failed") {
        emitLogEvent(state.onProgress, {
          message: `Tool failed: ${shorten(update.title ?? update.toolCallId, 96)}`,
          phase: null,
          logTitle: "Tool failure",
          logBody: contentToText(update.content) || update.title || ""
        });
      }
      break;
    }
    default:
      break;
  }
}

async function withAcp(cwd, fn) {
  let client = null;
  try {
    client = await AcpClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await AcpClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

function modeAvailable(modes, modeId) {
  const available = modes?.availableModes;
  if (!Array.isArray(available)) {
    return true; // Best-effort: attempt the mode if we cannot enumerate.
  }
  return available.some((mode) => mode?.id === modeId);
}

async function applySessionMode(client, sessionId, modeId, modes) {
  if (!modeId || !modeAvailable(modes, modeId)) {
    return;
  }
  try {
    await client.request("session/set_mode", { sessionId, modeId });
  } catch (error) {
    const msg = String(error?.message ?? error ?? "");
    if (!/unknown|unsupported|invalid/i.test(msg)) {
      throw error;
    }
  }
}

async function applySessionModel(client, sessionId, model) {
  if (!model) {
    return;
  }
  const modelId = resolveModelAlias(model);
  try {
    await client.request("session/set_model", { sessionId, modelId });
  } catch (error) {
    throw new Error(`Could not select Gemini model "${modelId}": ${error?.message ?? error}`);
  }
}

async function startOrResumeSession(client, cwd, options = {}) {
  if (options.resumeThreadId) {
    const response = await client.request("session/load", {
      sessionId: options.resumeThreadId,
      cwd,
      mcpServers: []
    });
    return { sessionId: options.resumeThreadId, modes: response.modes, models: response.models };
  }
  const response = await client.request("session/new", { cwd, mcpServers: [] });
  return { sessionId: response.sessionId, modes: response.modes, models: response.models };
}

export function getGeminiAvailability(cwd) {
  const versionStatus = binaryAvailable("gemini", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }
  return {
    available: true,
    detail: `${versionStatus.detail}; ACP runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Gemini runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Gemini runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "acp",
    authMethod: null,
    verified: null,
    requiresAuth: null,
    ...fields
  };
}

function classifyAuthError(message) {
  const text = String(message ?? "");
  if (/no longer supported|antigravity|migrate/i.test(text)) {
    return {
      detail:
        "Your Google login is no longer supported by Gemini CLI for this account type. Authenticate with a Gemini API key (set GEMINI_API_KEY) or Vertex AI, then rerun `/gemini:setup`.",
      requiresAuth: true
    };
  }
  if (/api key|unauthor|forbidden|permission|credential|login|sign in|auth/i.test(text)) {
    return { detail: text, requiresAuth: true };
  }
  return { detail: text, requiresAuth: null };
}

export async function getGeminiAuthStatus(cwd, options = {}) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresAuth: null
    };
  }

  let client = null;
  try {
    client = await AcpClient.connect(cwd, { env: options.env, reuseExistingBroker: true });
    // A successful session/new proves the configured credentials work; it does
    // not consume model tokens. Close the probe session immediately.
    const response = await client.request("session/new", { cwd, mcpServers: [] });
    if (response?.sessionId) {
      await client.request("session/close", { sessionId: response.sessionId }).catch(() => {});
    }
    const currentModel = response?.models?.currentModelId ?? null;
    return buildAuthStatus({
      loggedIn: true,
      detail: currentModel ? `Authenticated (model: ${currentModel})` : "Authenticated",
      verified: true,
      requiresAuth: false,
      model: currentModel
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyAuthError(message);
    return buildAuthStatus({
      loggedIn: false,
      detail: classified.detail,
      requiresAuth: classified.requiresAuth
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId } = {}) {
  if (!threadId) {
    return { attempted: false, interrupted: false, transport: null, detail: "missing sessionId" };
  }

  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    return { attempted: false, interrupted: false, transport: null, detail: availability.detail };
  }

  // Only a still-running shared broker can route a cancel to the live turn; in
  // direct mode the worker process owns its own gemini child, which the caller
  // terminates separately.
  const endpoint = process.env[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (!endpoint) {
    return { attempted: false, interrupted: false, transport: null, detail: "no shared runtime to cancel" };
  }

  let client = null;
  try {
    client = await AcpClient.connect(cwd, { reuseExistingBroker: true });
    client.notify("session/cancel", { sessionId: threadId });
    return { attempted: true, interrupted: true, transport: client.transport, detail: `Sent cancel for ${threadId}.` };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Gemini CLI is not installed or is missing ACP runtime support. Install it with `npm install -g @google/gemini-cli`, then rerun `/gemini:setup`."
    );
  }

  return withAcp(cwd, async (client) => {
    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming session ${options.resumeThreadId}.`, "starting");
    } else {
      emitProgress(options.onProgress, "Starting Gemini session.", "starting");
    }

    const { sessionId, modes, models } = await startOrResumeSession(client, cwd, {
      resumeThreadId: options.resumeThreadId
    });

    emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { threadId: sessionId });

    const writeMode = options.write || options.sandbox === "workspace-write";
    await applySessionMode(client, sessionId, writeMode ? WRITE_MODE : READ_ONLY_MODE, modes);
    await applySessionModel(client, sessionId, options.model, models);

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Gemini run.");
    }

    const state = createTurnState(options.onProgress);
    const previousHandler = client.notificationHandler;
    client.setNotificationHandler((message) => applyTurnNotification(state, sessionId, message));

    let stopReason = "error";
    try {
      const response = await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }]
      });
      stopReason = response?.stopReason ?? "end_turn";
    } catch (error) {
      state.error = { message: error instanceof Error ? error.message : String(error) };
      emitProgress(options.onProgress, `Gemini error: ${state.error.message}`, "failed");
    } finally {
      client.setNotificationHandler(previousHandler ?? null);
    }

    const status = stopReason === "end_turn" && !state.error ? 0 : 1;
    if (status === 0) {
      emitProgress(options.onProgress, "Turn completed.", "finalizing");
    }

    return {
      status,
      threadId: sessionId,
      turnId: null,
      finalMessage: state.messageParts.join(""),
      reasoningSummary: state.reasoning,
      turn: { id: sessionId, status: stopReason },
      error: state.error,
      stderr: cleanGeminiStderr(client.stderr),
      stopReason,
      touchedFiles: [...state.touchedFiles],
      commandExecutions: state.commandExecutions
    };
  });
}

/**
 * Gemini ACP exposes `session/list`, but sessions have no plugin-assigned names
 * we can match a task prefix against, so cross-session resume relies on the
 * plugin's own persisted job records instead. Returns null by design.
 */
export async function findLatestTaskThread() {
  return null;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

function stripJsonFences(rawOutput) {
  const trimmed = String(rawOutput ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Gemini did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(stripJsonFences(rawOutput)),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
