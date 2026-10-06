#!/usr/bin/env node
// Compare .github/codex-cli.json with the latest stable Codex CLI.
// A newer release updates the pin and bumps this package's patch version,
// changelog, and README. This script does not publish, tag, or merge.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_REPO = "openai/codex";
export const NPM_PACKAGE = "@openai/codex";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PIN = path.join(root, ".github", "codex-cli.json");

export function parseStableVersion(tag) {
  const match = /^rust-v(\d+\.\d+\.\d+)$/.exec(String(tag ?? ""));
  return match ? match[1] : null;
}

export function isStableSemver(version) {
  return /^\d+\.\d+\.\d+$/.test(String(version ?? ""));
}

export function compareSemver(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function stableReleaseFrom(release) {
  if (!release || release.draft || release.prerelease) return null;
  const version = parseStableVersion(release.tag_name);
  if (!version || typeof release.html_url !== "string") return null;
  return {
    version,
    tag: release.tag_name,
    releaseUrl: release.html_url,
    body: typeof release.body === "string" ? release.body : "",
  };
}

export function selectLatestStable(releases) {
  let best = null;
  for (const release of releases ?? []) {
    const stable = stableReleaseFrom(release);
    if (!stable) continue;
    if (!best || compareSemver(stable.version, best.version) > 0) best = stable;
  }
  return best;
}

export function chooseLatest({ releases, npmLatest, npmRelease }) {
  const github = selectLatestStable(releases);
  const tagged = isStableSemver(npmLatest) ? stableReleaseFrom(npmRelease) : null;
  const npm = tagged && tagged.version === npmLatest ? tagged : null;
  if (github && npm) return compareSemver(github.version, npm.version) >= 0 ? github : npm;
  return github ?? npm ?? null;
}

export function planUpdate(trackedVersion, latest) {
  if (!isStableSemver(trackedVersion)) {
    throw new Error(`Tracked Codex CLI version is not a stable semver: ${trackedVersion}`);
  }
  if (!latest || compareSemver(latest.version, trackedVersion) <= 0) return { update: false };
  return {
    update: true,
    pin: { version: latest.version, releaseUrl: latest.releaseUrl },
  };
}

export function readPin(file) {
  const pin = JSON.parse(readFileSync(file, "utf8"));
  if (!isStableSemver(pin.version) || typeof pin.releaseUrl !== "string") {
    throw new Error(`Invalid Codex CLI pin: ${file}`);
  }
  return { version: pin.version, releaseUrl: pin.releaseUrl };
}

export function writePin(file, pin) {
  writeFileSync(
    file,
    `${JSON.stringify({ version: pin.version, releaseUrl: pin.releaseUrl }, null, 2)}\n`,
  );
}

export function bumpPatch(version) {
  if (!isStableSemver(version)) throw new Error(`Cannot bump ${version}`);
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

export const CHANGELOG_MARKER = "# Changelog\n\n";
export const README_EN_MARKER = "What each recent version added. Older cuts are in `CHANGELOG.md`.\n\n";
export const README_KO_MARKER = "최근 버전이 더한 것입니다. 그 이전은 `CHANGELOG.md`에 있습니다.\n\n";

export function releaseNotes({ version, date, codexVersion, releaseUrl }) {
  return {
    changelog: `## ${version} — ${date}\n\n- Tracked Codex CLI is ${codexVersion} (${releaseUrl}). No protocol change.\n\n`,
    readmeEn: `### ${version} — ${date}\n\n- Tracked Codex CLI is ${codexVersion} (${releaseUrl}). No protocol change.\n\n`,
    readmeKo: `### ${version} — ${date}\n\n- 추적하는 Codex CLI는 ${codexVersion}입니다 (${releaseUrl}). 프로토콜 변경은 없습니다.\n\n`,
  };
}

export function insertAfter(text, marker, block) {
  const at = text.indexOf(marker);
  if (at < 0 || at !== text.lastIndexOf(marker)) throw new Error(`Marker is missing or not unique: ${marker}`);
  const pos = at + marker.length;
  if (text.startsWith(block, pos)) return text;
  return text.slice(0, pos) + block + text.slice(pos);
}

export function bumpPackageJson(text, from, to) {
  const needle = `"version": "${from}"`;
  if (text.split(needle).length !== 2) throw new Error("package.json version field is not unique");
  return text.replace(needle, `"version": "${to}"`);
}

export function bumpLockVersion(text, from, to) {
  const lines = text.split("\n");
  const needle = `"version": "${from}"`;
  const next = `"version": "${to}"`;
  let replaced = 0;
  for (let i = 0; i < lines.length && replaced < 2; i += 1) {
    if (lines[i].includes(needle)) {
      lines[i] = lines[i].replace(needle, next);
      replaced += 1;
    }
  }
  if (replaced !== 2) throw new Error(`Expected 2 lockfile version fields, replaced ${replaced}`);
  return lines.join("\n");
}

export function applyTrackBump({ packageJson, packageLock, changelog, readme, codexVersion, releaseUrl, date }) {
  const from = JSON.parse(packageJson).version;
  const to = bumpPatch(from);
  const notes = releaseNotes({ version: to, date, codexVersion, releaseUrl });
  if (changelog.includes(`## ${to} —`) || readme.includes(`### ${to} —`)) {
    throw new Error(`Release notes already exist for ${to}`);
  }
  return {
    version: to,
    packageJson: bumpPackageJson(packageJson, from, to),
    packageLock: bumpLockVersion(packageLock, from, to),
    changelog: insertAfter(changelog, CHANGELOG_MARKER, notes.changelog),
    readme: insertAfter(insertAfter(readme, README_EN_MARKER, notes.readmeEn), README_KO_MARKER, notes.readmeKo),
  };
}

export function releaseNotesExcerpt(body) {
  const cut = String(body ?? "").split(/^## Assets\b/m)[0].trim();
  if (cut.length <= 4000) return cut;
  return `${cut.slice(0, 4000).trimEnd()}\n\n…`;
}

export function pullRequestBody({ tracked, latest, npmLatest, packageVersion }) {
  const notes = releaseNotesExcerpt(latest.body);
  return [
    `Tracked Codex CLI moves from \`${tracked}\` to \`${latest.version}\`.`,
    "",
    `Upstream release notes: ${latest.releaseUrl}`,
    "",
    `npm \`${NPM_PACKAGE}\` dist-tag \`latest\`: \`${npmLatest ?? "unknown"}\`.`,
    "",
    `This pull request bumps codex-grok-bridge to \`${packageVersion}\` and records that CLI in the changelog and README. It does not publish to npm, create a git tag, or merge. Publishing runs from the main workflow after merge.`,
    "",
    "## Upstream notes",
    "",
    notes || "_The release body was empty._",
    "",
  ].join("\n");
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "codex-grok-bridge",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function getJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const error = new Error(`${response.status} for ${url}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function loadLatest({ fetchImpl = globalThis.fetch, token = "" } = {}) {
  const tags = await getJson(
    fetchImpl,
    `https://registry.npmjs.org/-/package/${NPM_PACKAGE}/dist-tags`,
    { Accept: "application/json", "User-Agent": "codex-grok-bridge" },
  );
  const npmLatest = typeof tags.latest === "string" ? tags.latest : "";
  const pages = [];
  for (let page = 1; page <= 3; page += 1) {
    const releases = await getJson(
      fetchImpl,
      `https://api.github.com/repos/${CODEX_REPO}/releases?per_page=100&page=${page}`,
      githubHeaders(token),
    );
    if (!Array.isArray(releases) || releases.length === 0) break;
    pages.push(...releases);
    const best = selectLatestStable(pages);
    if (best && isStableSemver(npmLatest) && compareSemver(best.version, npmLatest) >= 0) break;
    if (releases.length < 100) break;
  }
  let npmRelease = null;
  if (isStableSemver(npmLatest)) {
    try {
      npmRelease = await getJson(
        fetchImpl,
        `https://api.github.com/repos/${CODEX_REPO}/releases/tags/rust-v${npmLatest}`,
        githubHeaders(token),
      );
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return { npmLatest, latest: chooseLatest({ releases: pages, npmLatest, npmRelease }) };
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return "";
  return args[index + 1] ?? "";
}

async function main() {
  const args = process.argv.slice(2);
  const pinPath = argValue(args, "--pin") || DEFAULT_PIN;
  const notesOut = argValue(args, "--notes-out");
  const write = args.includes("--write-if-newer");
  const pin = readPin(pinPath);
  const { npmLatest, latest } = await loadLatest({
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  });
  if (!latest) throw new Error("No stable Codex CLI release found");
  const plan = planUpdate(pin.version, latest);
  const packagePath = path.join(root, "package.json");
  const currentPackage = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const packageVersion = plan.update ? bumpPatch(currentPackage) : currentPackage;
  if (plan.update && write) {
    const bumped = applyTrackBump({
      packageJson: readFileSync(packagePath, "utf8"),
      packageLock: readFileSync(path.join(root, "package-lock.json"), "utf8"),
      changelog: readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
      readme: readFileSync(path.join(root, "README.md"), "utf8"),
      codexVersion: latest.version,
      releaseUrl: latest.releaseUrl,
      date: new Date().toISOString().slice(0, 10),
    });
    writePin(pinPath, plan.pin);
    writeFileSync(packagePath, bumped.packageJson);
    writeFileSync(path.join(root, "package-lock.json"), bumped.packageLock);
    writeFileSync(path.join(root, "CHANGELOG.md"), bumped.changelog);
    writeFileSync(path.join(root, "README.md"), bumped.readme);
  }
  if (plan.update && notesOut) {
    writeFileSync(notesOut, pullRequestBody({
      tracked: pin.version,
      latest,
      npmLatest,
      packageVersion,
    }));
  }
  console.log(JSON.stringify({
    update: plan.update,
    tracked: pin.version,
    latest: latest.version,
    releaseUrl: latest.releaseUrl,
    npmLatest,
    packageVersion,
  }));
  setOutput("update", String(plan.update));
  setOutput("tracked", pin.version);
  setOutput("latest", latest.version);
  setOutput("release_url", latest.releaseUrl);
  setOutput("npm_latest", npmLatest);
  setOutput("package_version", packageVersion);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
