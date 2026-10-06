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
  releaseNotes,
  releaseNotesExcerpt,
  writePin,
  applyTrackBump,
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
    packageVersion: "1.8.2",
    latest: {
      version: "0.160.1",
      releaseUrl: "https://github.com/openai/codex/releases/tag/rust-v0.160.1",
      body: "## Bug Fixes\n\n- Keep the Windows env.\n\n## Assets\n\n| huge |",
    },
  });
  assert.match(body, /https:\/\/github.com\/openai\/codex\/releases\/tag\/rust-v0\.160\.1/);
  assert.match(body, /0\.153\.4/);
  assert.match(body, /bumps codex-grok-bridge to `1\.8\.2`/);
  assert.match(body, /does not publish to npm/);
  assert.match(body, /does not publish to npm, create a git tag, or merge/);
  assert.equal(body.includes("| huge |"), false);
  assert.equal(releaseNotesExcerpt(`${"x".repeat(4100)}\n## Assets\nbinary`).includes("binary"), false);
});

test("a Codex bump prepends notes and leaves the previous release untouched", () => {
  const bumped = applyTrackBump({
    packageJson: '{"name":"codex-grok-bridge","version": "1.8.2"}\n',
    packageLock: '{\n  "name": "codex-grok-bridge",\n  "version": "1.8.2",\n  "packages": {\n    "": {\n      "version": "1.8.2"\n    }\n  },\n  "deps": {\n    "@noble/curves": "^1.8.1"\n  }\n}\n',
    changelog: "# Changelog\n\n## 1.8.2 — 2026-10-06\n\n- Kept.\n",
    readme: [
      "What each recent version added. Older cuts are in `CHANGELOG.md`.",
      "",
      "### 1.8.2 — 2026-10-06",
      "",
      "- Kept.",
      "",
      "최근 버전이 더한 것입니다. 그 이전은 `CHANGELOG.md`에 있습니다.",
      "",
      "### 1.8.2 — 2026-10-06",
      "",
      "- 유지.",
      "",
    ].join("\n"),
    codexVersion: "0.161.0",
    releaseUrl: "https://github.com/openai/codex/releases/tag/rust-v0.161.0",
    date: "2026-10-13",
  });
  assert.equal(bumped.version, "1.8.3");
  assert.match(bumped.packageJson, /"version": "1.8.3"/);
  assert.match(bumped.packageLock, /"@noble\/curves": "\^1\.8\.1"/);
  assert.equal(bumped.packageLock.split('"version": "1.8.3"').length - 1, 2);
  assert.match(bumped.changelog, /^# Changelog\n\n## 1\.8\.3 — 2026-10-13\n\n- Tracked Codex CLI is 0\.161\.0/);
  assert.match(bumped.changelog, /## 1\.8\.2 — 2026-10-06\n\n- Kept\./);
  assert.match(bumped.readme, /### 1\.8\.3 — 2026-10-13\n\n- Tracked Codex CLI is 0\.161\.0/);
  assert.match(bumped.readme, /### 1\.8\.3 — 2026-10-13\n\n- 추적하는 Codex CLI는 0\.161\.0입니다/);
  assert.match(bumped.readme, /### 1\.8\.2 — 2026-10-06\n\n- Kept\./);
  assert.match(bumped.readme, /- 유지\./);
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
  const tracker = readFileSync(new URL("../scripts/track-codex-cli.mjs", import.meta.url), "utf8");
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /cron: "0 15 \* \* 1"/);
  assert.match(text, /\.github\/codex-cli\.json/);
  assert.match(text, /package\.json/);
  assert.match(text, /CHANGELOG\.md/);
  assert.match(text, /README\.md/);
  assert.match(text, /scripts\/track-codex-cli\.mjs --write-if-newer/);
  assert.equal(text.includes("npm publish"), false);
  assert.equal(text.includes("gh pr merge"), false);
  assert.equal(text.includes("git tag"), false);
  assert.equal(tracker.includes("npm publish"), false);
});

test("1.8.2 notes match the tracker text and keep 1.8.1", () => {
  const notes = releaseNotes({
    version: "1.8.2",
    date: "2026-10-06",
    codexVersion: "0.160.1",
    releaseUrl: "https://github.com/openai/codex/releases/tag/rust-v0.160.1",
  });
  const lf = (text) => text.replaceAll("\r\n", "\n");
  const changelog = lf(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
  const readme = lf(readFileSync(new URL("../README.md", import.meta.url), "utf8"));
  assert.ok(changelog.startsWith(`# Changelog\n\n${notes.changelog}`));
  assert.match(changelog, /## 1\.8\.1 — 2026-10-03\n\n- Grok reasoning ciphertext is removed/);
  assert.ok(readme.includes(notes.readmeEn));
  assert.ok(readme.includes(notes.readmeKo));
  assert.match(readme, /### 1\.8\.1 — 2026-10-03\n\n- Grok reasoning ciphertext is removed/);
  assert.match(readme, /### 1\.8\.1 — 2026-10-03\n\n- Grok reasoning 암호문/);
});
