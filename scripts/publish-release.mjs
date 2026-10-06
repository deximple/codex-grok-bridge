#!/usr/bin/env node
// Publish the package.json version once it is on main.
// Creates the missing GitHub Release (tag vX.Y.Z plus the npm tarball)
// and/or runs npm publish. Does not move an existing tag, does not
// republish a version already on npm, and does not print NPM_TOKEN.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readPackageVersion(packageJson) {
  const version = JSON.parse(packageJson).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Refusing to publish ${version}`);
  return version;
}

export function changelogSection(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^## ${escaped} — .*$`, "m").exec(text);
  if (!match) throw new Error(`CHANGELOG has no section for ${version}`);
  const rest = text.slice(match.index + match[0].length + 1);
  const next = rest.search(/^## /m);
  const end = next === -1 ? text.length : match.index + match[0].length + 1 + next;
  return `${text.slice(match.index, end).trim()}\n`;
}

export function planPublish({ version, headSha, npmPublished, releaseExists, tagSha, tokenPresent }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Refusing to publish ${version}`);
  if (npmPublished && releaseExists) return { ok: true, actions: [] };
  if (!releaseExists && tagSha && tagSha !== headSha) {
    return {
      ok: false,
      actions: [],
      error: `Refusing to move existing tag v${version} (${tagSha}) onto ${headSha}.`,
    };
  }
  const actions = [];
  if (!releaseExists) {
    if (!tagSha) actions.push("tag");
    actions.push("release");
  }
  if (!npmPublished) {
    if (!tokenPresent) {
      return {
        ok: false,
        actions,
        error: "NPM_TOKEN secret is not set. npm publish was not run.",
      };
    }
    actions.push("npm");
  }
  return { ok: true, actions };
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: root, ...options });
}

function npmPublished(name, version) {
  try {
    const out = run("npm", ["view", `${name}@${version}`, "version"], { stdio: ["ignore", "pipe", "pipe"] }).trim();
    return out === version;
  } catch (error) {
    const stderr = error.stderr?.toString?.() ?? "";
    if (stderr.includes("E404")) return false;
    throw error;
  }
}

function releaseExists(tag) {
  try {
    run("gh", ["release", "view", tag, "--json", "tagName"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    const stderr = error.stderr?.toString?.() ?? "";
    if (/not found/i.test(stderr) || error.status === 1) return false;
    throw error;
  }
}

function tagSha(tag) {
  try {
    return run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{}`], { stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (error.status === 1) return "";
    throw error;
  }
}

function perform(plan, { version, notes }) {
  const tag = `v${version}`;
  if (plan.actions.includes("tag")) {
    run("git", ["tag", tag, "HEAD"], { stdio: "inherit" });
    run("git", ["push", "origin", `refs/tags/${tag}`], { stdio: "inherit" });
  }
  if (plan.actions.includes("release")) {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-grok-notes-"));
    const notesPath = path.join(dir, "notes.md");
    writeFileSync(notesPath, notes);
    const packed = run("npm", ["pack", "--ignore-scripts", "--pack-destination", dir], {
      stdio: ["ignore", "pipe", "inherit"],
    }).trim().split("\n").pop();
    const tarball = path.resolve(dir, packed);
    run("gh", [
      "release", "create", tag, tarball,
      "--title", tag,
      "--notes-file", notesPath,
      "--verify-tag",
    ], { stdio: "inherit" });
  }
  if (plan.actions.includes("npm")) {
    run("npm", ["publish", "--access", "public"], { stdio: "inherit" });
  }
}

function main() {
  run("git", ["fetch", "--tags", "origin"], { stdio: "inherit" });
  const packageJson = readFileSync(path.join(root, "package.json"), "utf8");
  const version = readPackageVersion(packageJson);
  const name = JSON.parse(packageJson).name;
  const headSha = run("git", ["rev-parse", "HEAD"]).trim();
  const tag = `v${version}`;
  const tokenPresent = Boolean(process.env.NPM_TOKEN);
  const plan = planPublish({
    version,
    headSha,
    npmPublished: npmPublished(name, version),
    releaseExists: releaseExists(tag),
    tagSha: tagSha(tag),
    tokenPresent,
  });
  console.log(JSON.stringify({
    version,
    actions: plan.actions,
    npmToken: tokenPresent ? "present" : "missing",
  }));
  if (plan.actions.length === 0 && plan.ok) {
    console.log(`v${version} is already an npm release and a GitHub Release.`);
    return;
  }
  const notes = changelogSection(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);
  if (plan.actions.includes("tag") || plan.actions.includes("release") || plan.actions.includes("npm")) {
    perform(plan, { version, notes });
  }
  if (!plan.ok) {
    console.error(plan.error);
    process.exit(1);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
