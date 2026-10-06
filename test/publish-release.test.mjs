import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { changelogSection, planPublish } from "../scripts/publish-release.mjs";

const head = "a".repeat(40);
const other = "b".repeat(40);

test("an existing npm release and GitHub Release needs nothing", () => {
  assert.deepEqual(planPublish({
    version: "1.8.2",
    headSha: head,
    npmPublished: true,
    releaseExists: true,
    tagSha: other,
    tokenPresent: true,
  }), { ok: true, actions: [] });
});

test("npm publish is skipped when the version is already on npm", () => {
  const plan = planPublish({
    version: "1.8.2",
    headSha: head,
    npmPublished: true,
    releaseExists: false,
    tagSha: "",
    tokenPresent: true,
  });
  assert.deepEqual(plan.actions, ["tag", "release"]);
  assert.equal(plan.actions.includes("npm"), false);
});

test("a release on the current commit is created without a new tag", () => {
  assert.deepEqual(planPublish({
    version: "1.8.2",
    headSha: head,
    npmPublished: false,
    releaseExists: false,
    tagSha: head,
    tokenPresent: true,
  }).actions, ["release", "npm"]);
});

test("an existing tag on another commit is not moved", () => {
  const plan = planPublish({
    version: "1.8.1",
    headSha: head,
    npmPublished: false,
    releaseExists: false,
    tagSha: other,
    tokenPresent: true,
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.actions, []);
  assert.match(plan.error, /Refusing to move existing tag v1\.8\.1/);
});

test("a missing npm token still plans the GitHub Release and then fails npm", () => {
  const plan = planPublish({
    version: "1.8.2",
    headSha: head,
    npmPublished: false,
    releaseExists: false,
    tagSha: "",
    tokenPresent: false,
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.actions, ["tag", "release"]);
  assert.match(plan.error, /NPM_TOKEN secret is not set/);
});

test("release notes are only the changelog section for that version", () => {
  const notes = changelogSection([
    "# Changelog",
    "",
    "## 1.8.2 — 2026-10-06",
    "",
    "- Tracked Codex CLI is 0.160.1. No protocol change.",
    "",
    "## 1.8.1 — 2026-10-03",
    "",
    "- Older note.",
    "",
  ].join("\n"), "1.8.2");
  assert.match(notes, /Tracked Codex CLI is 0\.160\.1/);
  assert.equal(notes.includes("Older note"), false);
});

test("publish workflow uses the npm secret and does not print it", () => {
  const text = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const script = readFileSync(new URL("../scripts/publish-release.mjs", import.meta.url), "utf8");
  assert.match(text, /branches: \[main\]/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(text, /NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(text, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(text, /node scripts\/publish-release\.mjs/);
  assert.equal(/echo\s+.*NPM_TOKEN/.test(text), false);
  assert.equal(/echo\s+.*NODE_AUTH_TOKEN/.test(text), false);
  assert.equal(text.includes("--force"), false);
  assert.equal(script.includes("--force"), false);
  assert.equal(script.includes("console.log(process.env.NPM_TOKEN)"), false);
  assert.equal(script.includes("console.log(process.env.NODE_AUTH_TOKEN)"), false);
});
