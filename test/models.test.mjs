import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GROK_MODEL,
  MODEL_ENTRY,
  MODEL_INFO,
  catalogModelEntries,
  catalogModelIds,
  catalogModelInfos,
  extraGrokModels,
  isGrokModel,
  parseGrokCliModels,
  resolveGrokModel,
} from "../src/models.mjs";

function withEnv(value, fn) {
  const previous = process.env.GROK_BRIDGE_MODELS;
  if (value === undefined) delete process.env.GROK_BRIDGE_MODELS;
  else process.env.GROK_BRIDGE_MODELS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GROK_BRIDGE_MODELS;
    else process.env.GROK_BRIDGE_MODELS = previous;
  }
}

test("treats any grok-* id as a Grok model and defaults the rest", () => {
  assert.equal(isGrokModel("grok-4.6"), true);
  assert.equal(isGrokModel("grok-4.7"), true);
  assert.equal(isGrokModel("gpt-6-astra"), false);
  assert.equal(isGrokModel(""), false);
  assert.equal(resolveGrokModel("grok-4.7"), "grok-4.7");
  assert.equal(resolveGrokModel("gpt-6-astra"), DEFAULT_GROK_MODEL);
});

test("catalog stays grok-4.6 unless GROK_BRIDGE_MODELS adds extras", () => {
  withEnv(undefined, () => {
    assert.deepEqual(catalogModelIds(), [DEFAULT_GROK_MODEL]);
    assert.equal(catalogModelEntries()[0], MODEL_ENTRY);
    assert.equal(catalogModelInfos()[0], MODEL_INFO);
    assert.deepEqual(extraGrokModels(), []);
  });
  withEnv("grok-4.7, grok-4.6 grok-4.7 gpt-nope", () => {
    assert.deepEqual(catalogModelIds(), [DEFAULT_GROK_MODEL, "grok-4.7"]);
    assert.equal(catalogModelEntries()[1].id, "grok-4.7");
    assert.equal(catalogModelInfos()[1].slug, "grok-4.7");
  });
});

test("parses grok models CLI output including a 4.7 drop line", () => {
  const ids = parseGrokCliModels(`
You are logged in with grok.com.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
  - grok-4.7
`);
  assert.deepEqual(ids, ["grok-4.6", "grok-4.5", "grok-4.7"]);
});
