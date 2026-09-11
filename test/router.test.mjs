import test from "node:test";
import assert from "node:assert/strict";
import { Router, MODEL_ENTRY } from "../src/router.mjs";
test("adds Grok exactly once and preserves existing models", () => {
  const router = new Router("/catalog.json");
  router.outgoing({ id: 1, method: "model/list" });
  const result = router.incoming({
    id: 1,
    result: { data: [{ id: "gpt" }], nextCursor: null },
  });
  assert.deepEqual(result.result.data, [{ id: "gpt" }, MODEL_ENTRY]);
});
test("routes grok-4.7 and injects extra catalog ids from GROK_BRIDGE_MODELS", () => {
  const previous = process.env.GROK_BRIDGE_MODELS;
  process.env.GROK_BRIDGE_MODELS = "grok-4.7";
  try {
    const router = new Router("/catalog.json");
    const started = router.outgoing({
      id: 2,
      method: "thread/start",
      params: { model: "grok-4.7" },
    });
    assert.equal(started.params.modelProvider, "grok_build_cli");
    router.outgoing({ id: 1, method: "model/list" });
    const listed = router.incoming({
      id: 1,
      result: { data: [{ id: "gpt" }], nextCursor: null },
    });
    assert.equal(listed.result.data[1].id, "grok-4.6");
    assert.equal(listed.result.data[2].id, "grok-4.7");
  } finally {
    if (previous === undefined) delete process.env.GROK_BRIDGE_MODELS;
    else process.env.GROK_BRIDGE_MODELS = previous;
  }
});
test("routes Grok thread start and preserves approvals", () => {
  const router = new Router("/catalog.json");
  const request = router.outgoing({
    id: 2,
    method: "thread/start",
    params: {
      model: "grok-4.6",
      approvalPolicy: "on-request",
      config: { other: true },
    },
  });
  assert.equal(request.params.modelProvider, "grok_build_cli");
  assert.equal(request.params.approvalPolicy, "on-request");
  assert.equal(request.params.config.other, true);
  assert.equal(request.params.config.model_catalog_json, "/catalog.json");
});
test("passes GPT and outgoing turn/start through unchanged", () => {
  const router = new Router("/catalog.json");
  const original = {
    id: 3,
    method: "thread/start",
    params: { model: "gpt-6-astra" },
  };
  assert.deepEqual(router.outgoing(original), original);
  router.incoming({
    id: 3,
    result: {
      thread: { id: "t1" },
      model: "gpt-6-astra",
      modelProvider: "openai",
    },
  });
  const turn = {
    id: 4,
    method: "turn/start",
    params: { threadId: "t1", model: "grok-4.6" },
  };
  assert.deepEqual(router.outgoing(turn), turn);
});

test("new threads can send their first turn without a persisted rollout", async () => {
  const router = new Router("/catalog.json");
  router.outgoing({ id: 1, method: "thread/start", params: { model: "grok-4.6" } });
  router.incoming({ id: 1, result: { thread: { id: "new" }, model: "grok-4.6", modelProvider: "grok_build_cli" } });
  const input = { id: 2, method: "turn/start", params: { threadId: "new", model: "grok-4.6" } };
  await router.prepare(input, async () => assert.fail("new thread has no rollout yet"));
  router.incoming({ method: "turn/completed", params: { threadId: "new" } });
  let checked = false;
  await router.prepare(input, async () => {
    checked = true;
    return { model: "grok-4.6", modelProvider: "grok_build_cli" };
  });
  assert.equal(checked, true);
});

test("new unsaved threads cannot be unloaded for a provider switch", async () => {
  const router = new Router("/catalog.json");
  router.outgoing({ id: 1, method: "thread/start", params: { model: "gpt-6-astra" } });
  router.incoming({ id: 1, result: { thread: { id: "new" }, model: "gpt-6-astra", modelProvider: "openai" } });
  await assert.rejects(router.prepare({ method: "turn/start", params: { threadId: "new", model: "grok-4.6" } },
    async () => assert.fail("must not reload an unsaved thread")), /first turn/);
});

const GROK = "grok-4.6", GPT = "gpt-6-astra", PROVIDER = "grok_build_cli";
const lookup = { threadId: "t1", excludeTurns: true };
function snapshot(overrides = {}) {
  return {
    thread: { id: "t1", status: { type: "idle" }, ephemeral: false, parentThreadId: null },
    model: GPT, modelProvider: "openai", cwd: "/workspace",
    approvalPolicy: "on-request", approvalsReviewer: "user", serviceTier: "fast",
    reasoningEffort: "high",
    sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false },
    ...overrides,
  };
}
function message(params = {}, method = "turn/start") {
  return { id: 9, method, params: { threadId: "t1", model: GROK, ...params } };
}
function switchedParams(before, model, modelProvider) {
  return {
    ...lookup, model, modelProvider, cwd: before.cwd,
    approvalPolicy: before.approvalPolicy, approvalsReviewer: before.approvalsReviewer,
    serviceTier: before.serviceTier,
    ...(before.path != null ? { path: before.path } : {}),
    config: {
      ...(modelProvider === PROVIDER ? { model_catalog_json: "/catalog.json" } : {}),
      ...(before.reasoningEffort != null ? { model_reasoning_effort: before.reasoningEffort } : {}),
    },
  };
}
function orderedRpc(steps) {
  let index = 0;
  const original = structuredClone(steps);
  const rpc = async (method, params) => {
    assert.ok(index < steps.length, `unexpected RPC ${method}`);
    const [expectedMethod, expectedParams, response] = steps[index++];
    assert.equal(method, expectedMethod);
    assert.deepEqual(params, expectedParams);
    if (response instanceof Error) throw response;
    return response;
  };
  return { rpc, done() {
    assert.equal(index, steps.length, "all ordered RPCs must finish before prepare resolves");
    assert.deepEqual(steps, original, "RPC snapshots and arguments must not be mutated");
  } };
}
function switchSteps(before, model = GROK, provider = PROVIDER, after = {}) {
  return [
    ["thread/resume", lookup, before],
    ["thread/unsubscribe", { threadId: "t1" }, {}],
    ["thread/resume", switchedParams(before, model, provider),
      { ...before, model, modelProvider: provider, ...after }],
  ];
}

for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
  test(`outgoing ${method} may inject Grok provider without mutating input`, () => {
    const input = message({}, method), original = structuredClone(input);
    const result = new Router("/catalog.json").outgoing(input);
    assert.equal(result.params.modelProvider, PROVIDER);
    assert.equal(result.params.config.model_catalog_json, "/catalog.json");
    assert.deepEqual(input, original);
  });
}

test("prepare omits sandbox on switch resume so persisted extras are not rebuilt from a mode string", async () => {
  const before = snapshot({
    sandbox: { type: "workspaceWrite", writableRoots: ["/extra"], networkAccess: true },
  });
  const fake = orderedRpc(switchSteps(before));
  await new Router("/catalog.json").prepare(message(), fake.rpc);
  fake.done();
  assert.equal(Object.hasOwn(switchedParams(before, GROK, PROVIDER), "sandbox"), false);
});

for (const [name, before, input, model, provider] of [
  ["GPT to Grok", snapshot(), message(), GROK, PROVIDER],
  ["Grok to GPT", snapshot({ model: GROK, modelProvider: PROVIDER }), message({ model: GPT }), GPT, "openai"],
  ["collaboration model takes precedence", snapshot(), message({ model: GPT, collaborationMode: { mode: "default", settings: { model: GROK } } }), GROK, PROVIDER],
  ["omitted turn model uses live UI selection", snapshot({ model: GROK }), { id: 9, method: "turn/start", params: { threadId: "t1" } }, GROK, PROVIDER],
  ["null reasoning effort is omitted", snapshot({ reasoningEffort: null }), message(), GROK, PROVIDER],
]) {
  test(`prepare switches ${name} in place and leaves the message unchanged`, async () => {
    const router = new Router("/catalog.json"), original = structuredClone(input);
    const fake = orderedRpc(switchSteps(before, model, provider));
    assert.equal(await router.prepare(input, fake.rpc), undefined);
    fake.done();
    assert.deepEqual(input, original);
    assert.deepEqual(router.outgoing(input), original);
  });
}

for (const [name, before, input] of [
  ["Grok already selected", snapshot({ model: GROK, modelProvider: PROVIDER }), message()],
  ["GPT already selected", snapshot(), message({ model: GPT })],
  ["custom GPT provider is preserved", snapshot({ modelProvider: "custom" }), message({ model: GPT })],
  ["active thread already on target", snapshot({ model: GROK, modelProvider: PROVIDER, thread: { ...snapshot().thread, status: { type: "active" } } }), message()],
]) {
  test(`prepare looks up live state but does not unsubscribe: ${name}`, async () => {
    const fake = orderedRpc([["thread/resume", lookup, before]]);
    assert.equal(await new Router("/catalog.json").prepare(input, fake.rpc), undefined);
    fake.done();
  });
}

test("prepare ignores cached provider and reads fresh state on every turn", async () => {
  const router = new Router("/catalog.json");
  router.outgoing(message({}, "thread/resume"));
  router.incoming({ id: 9, result: snapshot({ model: GROK, modelProvider: PROVIDER }) });
  const input = { id: 10, method: "turn/start", params: { threadId: "t1" } };
  const fake = orderedRpc([
    ...switchSteps(snapshot({ model: GROK })),
    ["thread/resume", lookup, snapshot({ model: GROK, modelProvider: PROVIDER })],
  ]);
  assert.equal(await router.prepare(input, fake.rpc), undefined);
  assert.equal(await router.prepare(input, fake.rpc), undefined);
  fake.done();
});

for (const method of ["thread/settings/update", "turn/settings/update"]) {
  for (const params of [{ model: GROK }, { model: undefined, collaborationMode: { settings: { model: GROK } } }]) {
    test(`prepare switches ${method} with an explicit model`, async () => {
      const fake = orderedRpc(switchSteps(snapshot()));
      const input = message(params, method), original = structuredClone(input);
      assert.equal(await new Router("/catalog.json").prepare(input, fake.rpc), undefined);
      fake.done();
      assert.deepEqual(input, original);
      assert.deepEqual(new Router("/catalog.json").outgoing(input), original);
    });
  }
  test(`prepare bypasses ${method} without an explicit model`, async () => {
    const fake = orderedRpc([]);
    assert.equal(await new Router("/catalog.json").prepare(message({ model: undefined }, method), fake.rpc), undefined);
    fake.done();
  });
}

for (const [name, threadPatch] of [
  ["active", { status: { type: "active" } }],
  ["ephemeral", { ephemeral: true }],
  ["child", { parentThreadId: "parent" }],
]) {
  test(`prepare refuses ${name} thread before unsubscribing`, async () => {
    const before = snapshot({ thread: { ...snapshot().thread, ...threadPatch } });
    const fake = orderedRpc([["thread/resume", lookup, before]]);
    await assert.rejects(async () => new Router("/catalog.json").prepare(message(), fake.rpc), (error) => {
      assert.notEqual(error.code, "ERR_ASSERTION", "RPC contract assertions must not count as a refusal");
      assert.notEqual(error.name, "TypeError");
      return true;
    });
    fake.done();
  });
}

for (const [name, patch] of [
  ["provider (another subscriber prevented reload)", { modelProvider: "openai" }],
  ["thread id", { thread: { ...snapshot().thread, id: "other" } }],
  ["model", { model: GPT }],
  ["approval policy", { approvalPolicy: "never" }],
  ["approvals reviewer", { approvalsReviewer: "guardian_subagent" }],
  ["sandbox", { sandbox: { type: "dangerFullAccess" } }],
]) {
  test(`prepare rejects changed ${name} after resume`, async () => {
    const fake = orderedRpc(switchSteps(snapshot(), GROK, PROVIDER, patch));
    await assert.rejects(async () => new Router("/catalog.json").prepare(message(), fake.rpc), (error) => {
      assert.notEqual(error.code, "ERR_ASSERTION", "RPC contract assertions must not count as a refusal");
      assert.notEqual(error.name, "TypeError");
      return true;
    });
    fake.done();
  });
}

for (const failAt of [0, 1, 2]) {
  test(`prepare propagates RPC failure at step ${failAt + 1}`, async () => {
    const failure = new Error("RPC unavailable");
    const steps = switchSteps(snapshot()).slice(0, failAt + 1)
      .map((step, index) => index === failAt ? [step[0], step[1], failure] : step);
    const fake = orderedRpc(steps);
    await assert.rejects(async () => new Router("/catalog.json").prepare(message(), fake.rpc), failure);
    fake.done();
  });
}

for (const method of ["model/list", "thread/read", "thread/start", "thread/resume", "thread/fork", "turn/interrupt"]) {
  test(`prepare bypasses unrelated ${method}`, async () => {
    const fake = orderedRpc([]), input = message({}, method), original = structuredClone(input);
    assert.equal(await new Router("/catalog.json").prepare(input, fake.rpc), undefined);
    fake.done();
    assert.deepEqual(input, original);
  });
}
