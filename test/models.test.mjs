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

test("catalog defaults to grok-4.7 and keeps grok-4.6", () => {
  withEnv(undefined, () => {
    assert.equal(DEFAULT_GROK_MODEL, "grok-4.7");
    assert.deepEqual(catalogModelIds(), ["grok-4.7", "grok-4.6"]);
    assert.equal(catalogModelEntries()[0], MODEL_ENTRY);
    assert.equal(catalogModelEntries()[0].displayName, "Grok 4.7 / xAI");
    assert.equal(catalogModelEntries()[1].id, "grok-4.6");
    assert.equal(catalogModelEntries()[1].displayName, "Grok 4.6 / xAI");
    assert.equal(catalogModelInfos()[0], MODEL_INFO);
    assert.equal(catalogModelInfos()[0].display_name, "Grok 4.7 / xAI");
    assert.equal(catalogModelInfos()[1].slug, "grok-4.6");
    assert.deepEqual(extraGrokModels(), []);
  });
  withEnv("grok-4.5, grok-4.7 grok-4.6 gpt-nope", () => {
    assert.deepEqual(catalogModelIds(), ["grok-4.7", "grok-4.6", "grok-4.5"]);
    assert.equal(catalogModelEntries()[2].id, "grok-4.5");
    assert.equal(catalogModelInfos()[2].slug, "grok-4.5");
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
