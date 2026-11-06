import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply } from "../lib/host-plugin.js";
import { PluginHost } from "../internal/plugin-sdk.mjs";
import { createClaudeExecutionPlugin, FallbackClaudeClient } from "../plugin.mjs";
import { ClaudeSdkClient } from "../sdk-client.mjs";
import { ClaudeCliClient } from "../cli-client.mjs";
import { createDshClaudePlugin } from "../dsh-plugin.js";

test("Claude plugin exposes operation capabilities and closes its backend", async () => {
  const client = new FakeClaudeClient();
  const host = new PluginHost();
  await host.activate([createClaudeExecutionPlugin({
    client,
    cwd: "/workspace",
    plugins: [{ type: "local", path: "/plugins/fixture" }],
  })]);
  const execution = host.capabilities.require("relay.execution.claude.v1", "^1.0.0");

  await execution.whenReady();
  assert.deepEqual(execution.listModels().map((model) => model.id), ["claude-test"]);
  assert.equal("runtime" in execution, false);
  assert.equal("client" in execution, false);
  await execution.createSession();
  assert.deepEqual(client.created.plugins, [{ type: "local", path: "/plugins/fixture" }]);
  const requests = [];
  const stop = execution.subscribeRequest((request) => requests.push(request.id));
  client.emit("request", { id: "request-1", method: "test", params: {} });
  assert.deepEqual(requests, ["request-1"]);
  stop();
  client.emit("request", { id: "request-2", method: "test", params: {} });
  assert.deepEqual(requests, ["request-1"]);

  await host.dispose();
  assert.equal(client.closed, true);
});

test("DSH Host claudePlugins configuration reaches business Session creation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-claude-local-plugin-config-"));
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, "dsh-home");
  context.after(async () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    await rm(directory, { recursive: true, force: true });
  });
  const client = new FakeClaudeClient();
  const cleanups = [];
  let adapter;
  const ctx = {
    attachments: {},
    logger: console,
    agents: { list: () => [], get: () => null },
    approval: {},
    sessions: {},
    sessionPersistence: {},
    tools: {},
    typert: {},
    userQuestions: {},
    workspaceRegistry: { async resolveByPath() { return null; } },
    sessionTitle: {},
    webServer: { register() { return () => {}; } },
    llm: {
      registerAdapter(_providers, candidate) {
        adapter = candidate;
        return () => {};
      },
    },
    effect(effect) {
      const cleanup = effect();
      cleanups.push(cleanup);
      return cleanup;
    },
    on() { return () => {}; },
  };

  await apply(ctx, {
    claude: { client },
    claudePlugins: [{ type: "local", path: "/plugins/from-dsh-host" }],
    claudeLinkPath: join(directory, "links.json"),
  });
  await adapter.ensureSession("dsh-session");

  assert.deepEqual(client.created.plugins, [{ type: "local", path: "/plugins/from-dsh-host" }]);
  for (const cleanup of cleanups.reverse()) await cleanup?.();
});

class FakeClaudeClient extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
  }

  async start() {}
  async listModels() { return [{ id: "claude-test", isDefault: true }]; }
  async createSession(config) {
    this.created = structuredClone(config);
    return { id: "claude-session", cwd: config.cwd, turns: [] };
  }
  async close() { this.closed = true; }
}


test("grant capability follows the active SDK or CLI fallback backend", async () => {
  const sdk = new ClaudeSdkClient({ sdk: { query() {} } });
  const cli = new ClaudeCliClient();
  assert.equal(sdk.supportsHostGrantEnforcement(), true);
  assert.equal(cli.supportsHostGrantEnforcement?.() === true, false);
  const rejected = new ClaudeSdkClient({ sdk: {} });
  const fallback = new FallbackClaudeClient({ primary: rejected, fallback: cli });
  await fallback.start();
  assert.equal(fallback.supportsHostGrantEnforcement(), false);
  await fallback.close();
  const laterCli = new ClaudeCliClient({ command: "/must-not-execute" });
  const successful = new FallbackClaudeClient({ primary: sdk, fallback: laterCli });
  await successful.start();
  assert.equal(successful.supportsHostGrantEnforcement(), true);
  const session = await successful.createSession({ cwd: "/tmp" });
  successful.active = laterCli;
  await assert.rejects(successful.sendMessage(session.id, { text: "hello", nativeToolAllowlist: [] }), /require the Claude Agent SDK/);
  assert.equal(laterCli.processes.size, 0);
  await successful.close();
});


test("registered Claude routing cannot bypass host stream middleware in either registration order", async context => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { LlmRuntime } = await import("@deepseek-ai/dsh-llm");
  const directory = await mkdtemp(join(tmpdir(), "relay-claude-middleware-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const first of ["host", "relay"]) {
    const root = new Context(); new LlmRuntime(root);
    const agent = { id: "home", session: { header: { agentPreset: "relay-claude", cwd: directory }, events: [] } };
    let adapter, called = 0, dispatched = 0, deny = false;
    const middleware = () => root.on("llm/stream", (options, next) => {
      called++; if (deny) throw new Error("WORKA_DENIED"); options.nativeToolAllowlist = []; return next();
    }, { global: true, prepend: true });
    const ctx = { llm: { registerAdapter(providers, value) {
      adapter = value; value.stream = async function* (options) {
        dispatched++; assert.deepEqual(options.nativeToolAllowlist, []);
        yield { type: "finish", reason: { kind: "stop" } };
      };
      return root.llm.registerAdapter(providers, value);
    } }, on: (...args) => root.on(...args), agents: { list: () => [agent], get: () => agent },
    workspaceRegistry: { resolveByPath() {} }, webServer: { register: () => () => {} }, logger: console };
    const runtime = { whenReady: () => Promise.resolve(), listModels: () => [{ id: "sonnet" }], listWorkspaceSessions: async () => [], subscribeRequest: () => () => {} };
    const cleanups = [];
    if (first === "host") middleware();
    await createDshClaudePlugin(ctx, { claudeLinkPath: join(directory, first + ".json") }).activate({
      capabilities: { require: () => runtime }, defer: fn => cleanups.push(fn),
    });
    if (first === "relay") middleware();
    assert.ok(adapter);
    const chunks = []; for await (const chunk of root.llm.stream({ provider: "relay-claude", model: "sonnet",
      sessionId: "home", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })) chunks.push(chunk);
    assert.equal(called, 1); assert.equal(dispatched, 1); assert.equal(chunks.at(-1).reason.kind, "stop");
    deny = true;
    await assert.rejects(async () => {
      for await (const ignored of root.llm.stream({ provider: "relay-claude", model: "sonnet", sessionId: "home", messages: [] })) void ignored;
    }, /WORKA_DENIED/);
    assert.equal(called, 2); assert.equal(dispatched, 1);
    deny = false;
    await assert.rejects(async () => {
      for await (const ignored of root.llm.stream({ provider: "other-provider", model: "model", sessionId: "home", messages: [] })) void ignored;
    }, /Claude preset requires a relay-claude model/);
    assert.equal(dispatched, 1);
    for (const cleanup of cleanups.reverse()) await cleanup();
    await root.fiber.dispose();
  }
});

test("registered Claude adapter receives the DSH-projected file path and image", async context => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { LlmRuntime, createUserMessage } = await import("@deepseek-ai/dsh-llm");
  const { ClaudeDshAdapter } = await import("../claude-adapter.js");
  const root = new Context(); new LlmRuntime(root);
  const agent = { id: "owned", ctx: {}, session: { header: { agentPreset: "relay-claude", cwd: "/tmp" }, events: [], append() {} } };
  const file = { attachmentId: `sha256:${"1".repeat(64)}`, name: "fixture.zip", bytes: 3 };
  const image = { attachmentId: `sha256:${"2".repeat(64)}`, mediaType: "image/png", bytes: 3, width: 1, height: 1 };
  const attachments = { fileHostPath: () => "/tmp/fixture.zip", readImage: async () => ({ ref: image, data: Buffer.from([1, 2, 3]) }) };
  root.provide("attachments", attachments);
  root.provide("fs", { processPathFromHostPath: path => path });
  class Runtime extends EventEmitter {
    models = [{ id: "sonnet", inputModalities: ["text", "image"] }]; sent = []; sessions = new Map();
    async createSession(config) { const session = { ...config, id: "claude-1", turns: [] }; this.sessions.set(session.id, session); return session; }
    async sendMessage(sessionId, message) { this.sent.push(message); queueMicrotask(() => this.emit("activity", {
      method: "turn/completed", params: { sessionId, turn: { id: "turn-1", status: "completed", items: [] } },
    })); return { id: "turn-1", status: "inProgress", items: [] }; }
  }
  const runtime = new Runtime();
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve(), attachments });
  adapter.attachAgent(agent); root.llm.registerAdapter(["relay-claude"], adapter);
  const user = createUserMessage({ source: { kind: "user" }, content: [
    { type: "text", text: "Inspect these" }, { type: "file", attachment: file }, { type: "image", attachment: image },
  ] });
  const chunks = []; for await (const chunk of root.llm.stream({ provider: "relay-claude", model: "sonnet", sessionId: agent.id, messages: [user] })) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.match(runtime.sent[0].text, /\/tmp\/fixture\.zip/);
  assert.deepEqual(runtime.sent[0].content.at(-1), { type: "image", mediaType: "image/png", data: "AQID" });
  await root.fiber.dispose();
});
