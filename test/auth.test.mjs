import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readGrokBearerToken } from "../src/auth.mjs";

test("reads grok login token without exposing it in errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-home-"));
  await mkdir(join(home, ".grok"));
  await writeFile(
    join(home, ".grok/auth.json"),
    JSON.stringify({
      "https://auth.x.ai::test": {
        key: "session-token-value",
        user_id: "user-1",
        expires_at: "2099-01-01T00:00:00Z",
      },
    }),
  );
  try {
    const session = readGrokBearerToken(home);
    assert.equal(session.token, "session-token-value");
    assert.equal(session.userId, "user-1");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
