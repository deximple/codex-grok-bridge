import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  chooseLatest,
  compareSemver,
  loadLatest,
  parseStableVersion,
  planUpdate,
  pullRequestBody,
  readPin,
  releaseNotesExcerpt,
  writePin,
} from "../scripts/track-codex-cli.mjs";

const release = (tag, extra = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/openai/codex/releases/tag/${tag}`,
  body: `Notes for ${tag}`,
  ...extra,
});

test("stable tags exclude prereleases", () => {
  assert.equal(parseStableVersion("rust-v0.160.1"), "0.160.1");
  assert.equal(parseStableVersion("rust-v0.162.0-alpha.16"), null);
  assert.equal(parseStableVersion("v0.160.1"), null);
});

test("latest stable ignores drafts, prereleases, and older releases", () => {
  const latest = chooseLatest({
    npmLatest: "0.162.0-alpha.16",
    npmRelease: release("rust-v0.162.0-alpha.16", { prerelease: true }),
    releases: [
      release("rust-v0.162.0-alpha.16", { prerelease: true }),
      release("rust-v0.160.0"),
      release("rust-v0.160.1"),
      release("rust-v0.159.3", { draft: true }),
    ],
  });
  assert.equal(latest.version, "0.160.1");
  assert.equal(latest.releaseUrl, "https://github.com/openai/codex/releases/tag/rust-v0.160.1");
});

test("a newer stable npm release is used when GitHub pages lag", () => {
  const latest = chooseLatest({
    npmLatest: "0.160.1",
    npmRelease: release("rust-v0.160.1", { body: "patch" }),
    releases: [release("rust-v0.160.0")],
  });
  assert.equal(latest.version, "0.160.1");
  assert.equal(compareSemver("0.160.1", "0.160.0") > 0, true);
});

test("an equal pin does not update", () => {
  const latest = chooseLatest({
    npmLatest: "0.160.1",
    npmRelease: release("rust-v0.160.1"),
    releases: [release("rust-v0.160.1")],
  });
  assert.deepEqual(planUpdate("0.160.1", latest), { update: false });
  const plan = planUpdate("0.153.4", latest);
  assert.equal(plan.update, true);
  assert.equal(plan.pin.version, "0.160.1");
});

test("pin file round-trips the version and release URL", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-cli-pin-"));
  const file = path.join(dir, "codex-cli.json");
  try {
    writePin(file, {
      version: "0.160.1",
      releaseUrl: "https://github.com/openai/codex/releases/tag/rust-v0.160.1",
      extra: "dropped",
    });
    assert.deepEqual(readPin(file), {
      version: "0.160.1",
      releaseUrl: "https://github.com/openai/codex/releases/tag/rust-v0.160.1",
    });
    assert.equal((await readFile(file, "utf8")).endsWith("\n"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pull request body links the upstream release and stops before assets", () => {
  const body = pullRequestBody({
    tracked: "0.153.4",
    npmLatest: "0.160.1",
    latest: {
      version: "0.160.1",
      releaseUrl: "https://github.com/openai/codex/releases/tag/rust-v0.160.1",
      body: "## Bug Fixes\n\n- Keep the Windows env.\n\n## Assets\n\n| huge |",
    },
  });
  assert.match(body, /https:\/\/github.com\/openai\/codex\/releases\/tag\/rust-v0\.160\.1/);
  assert.match(body, /0\.153\.4/);
  assert.match(body, /does not publish to npm/);
  assert.equal(body.includes("| huge |"), false);
  assert.equal(releaseNotesExcerpt(`${"x".repeat(4100)}\n## Assets\nbinary`).includes("binary"), false);
});

test("loadLatest reads npm latest and GitHub stable releases", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/dist-tags")) {
      return { ok: true, json: async () => ({ latest: "0.160.1", alpha: "0.162.0-alpha.16" }) };
    }
    if (url.includes("/releases?")) {
      return { ok: true, json: async () => [release("rust-v0.160.1"), release("rust-v0.162.0-alpha.16", { prerelease: true })] };
    }
    if (url.endsWith("/releases/tags/rust-v0.160.1")) {
      return { ok: true, json: async () => release("rust-v0.160.1") };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { npmLatest, latest } = await loadLatest({ fetchImpl });
  assert.equal(npmLatest, "0.160.1");
  assert.equal(latest.version, "0.160.1");
  assert.equal(calls.some((url) => url.includes("registry.npmjs.org")), true);
  assert.equal(calls.some((url) => url.includes("/repos/openai/codex/releases?")), true);
});

test("workflow compares the pin and does not publish, tag, or merge", () => {
  const text = readFileSync(new URL("../.github/workflows/track-codex-cli.yml", import.meta.url), "utf8");
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /cron: "0 15 \* \* 1"/);
  assert.match(text, /\.github\/codex-cli\.json/);
  assert.match(text, /scripts\/track-codex-cli\.mjs --write-if-newer/);
  assert.equal(text.includes("npm publish"), false);
  assert.equal(text.includes("gh pr merge"), false);
  assert.equal(text.includes("git tag"), false);
});
