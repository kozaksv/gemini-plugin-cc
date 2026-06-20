import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGemini, readFixtureState } from "./fake-gemini-acp-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession, sendBrokerShutdown, teardownBrokerSession } from "../plugins/gemini/scripts/lib/broker-lifecycle.mjs";

// Keep state-dir resolution consistent between this process and child commands.
delete process.env.CLAUDE_PLUGIN_DATA;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "gemini", "scripts", "gemini-companion.mjs");

function runCompanion(args, env, cwd = ROOT) {
  return run("node", [SCRIPT, ...args], { cwd, env });
}

async function killBroker(workspaceRoot) {
  const session = loadBrokerSession(workspaceRoot);
  if (!session) {
    return;
  }
  try {
    await sendBrokerShutdown(session.endpoint);
  } catch {
    // fall through to forced teardown
  }
  teardownBrokerSession({
    ...session,
    killProcess: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  });
}

test("setup reports ready when fake Gemini is authenticated", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "ok");

  const result = runCompanion(["setup", "--json"], buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.gemini.available, true);
  assert.match(payload.gemini.detail, /ACP runtime available/);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup reports auth needed when the Gemini login is unsupported", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "unauthenticated");

  const result = runCompanion(["setup", "--json"], buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.match(payload.auth.detail, /API key|Antigravity|GEMINI_API_KEY/i);
  assert.ok(payload.nextSteps.some((step) => /GEMINI_API_KEY|authenticate/i.test(step)));
});

test("task run captures the Gemini final message", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "ok");

  const result = runCompanion(["task", "hello gemini"], buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FAKE_GEMINI_ANSWER for: hello gemini/);
});

test("task --json returns a structured payload with the session id", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "ok");

  const result = runCompanion(["task", "--json", "do a thing"], buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.rawOutput, /FAKE_GEMINI_ANSWER/);
  assert.match(payload.threadId, /^fake-session-/);
});

test("write task captures touched files from tool calls", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "tool");

  const result = runCompanion(["task", "--write", "--json", "edit the file"], buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.touchedFiles, ["/tmp/app.txt"]);
});

test("review runs a free-form prompt-driven review on the working tree", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "ok");
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");

  const result = runCompanion(["review", "--scope", "working-tree"], buildEnv(binDir), repo);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Review/);
  assert.match(result.stdout, /FAKE_GEMINI_ANSWER/);
});

test("adversarial review parses structured JSON output", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "json");
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");

  const result = runCompanion(["adversarial-review", "--scope", "working-tree"], buildEnv(binDir), repo);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Adversarial Review/);
  assert.match(result.stdout, /Verdict: approve/);
});

test("background task lifecycle: queue, status, then result", async () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "ok");
  const repo = makeTempDir();
  const env = buildEnv(binDir);

  const launch = runCompanion(["task", "--background", "--json", "background work"], env, repo);
  assert.equal(launch.status, 0, launch.stderr);
  const queued = JSON.parse(launch.stdout);
  assert.equal(queued.status, "queued");

  const jobId = queued.jobId;
  let finished = null;
  for (let i = 0; i < 100; i += 1) {
    const status = runCompanion(["status", jobId, "--json"], env, repo);
    const snapshot = JSON.parse(status.stdout);
    if (snapshot.job.status === "completed" || snapshot.job.status === "failed") {
      finished = snapshot.job;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(finished, "background job never finished");
  assert.equal(finished.status, "completed");

  const result = runCompanion(["result", jobId], env, repo);
  assert.match(result.stdout, /FAKE_GEMINI_ANSWER/);
});

test("the shared broker is reused across commands", async () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "ok");
  const repo = makeTempDir();
  const env = buildEnv(binDir, { GEMINI_COMPANION_DISABLE_BROKER: undefined });

  try {
    const first = runCompanion(["task", "first job"], env, repo);
    assert.equal(first.status, 0, first.stderr);
    const second = runCompanion(["task", "second job"], env, repo);
    assert.equal(second.status, 0, second.stderr);

    const state = readFixtureState(binDir);
    // One shared broker process means `gemini --acp` was started exactly once.
    assert.equal(state.acpStarts, 1);
    assert.ok(state.prompts >= 2);
  } finally {
    await killBroker(repo);
  }
});
