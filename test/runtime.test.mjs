import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { startRuntime } from "../src/runtime.mjs";
test("runtime binds loopback and removes its temporary catalog", async () => {
  const runtime = await startRuntime();
  assert.equal(runtime.server.address().address, "127.0.0.1");
  assert.equal(runtime.token.length, 64);
  await access(runtime.catalogPath);
  await runtime.close();
  await assert.rejects(access(runtime.catalogPath));
});
