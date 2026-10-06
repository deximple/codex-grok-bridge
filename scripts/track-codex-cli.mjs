#!/usr/bin/env node
// Compare .github/codex-cli.json and .github/grok-cli.json with the latest
// stable Codex CLI and Grok CLI. A newer release updates that pin and bumps
// this package's patch version, changelog, and README once. This script does
// not publish, tag, or merge.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_REPO = "openai/codex";
export const NPM_PACKAGE = "@openai/codex";
export const GROK_STABLE_URLS = [
  "https://x.ai/cli/stable",
  "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
];
export const GROK_CHANGELOG_URL = "https://x.ai/build/changelog";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PIN = path.join(root, ".github", "codex-cli.json");
export const DEFAULT_GROK_PIN = path.join(root, ".github", "grok-cli.json");

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
    throw new Error(`Tracked CLI version is not a stable semver: ${trackedVersion}`);
  }
  if (!latest || compareSemver(latest.version, trackedVersion) <= 0) return { update: false };
  return {
    update: true,
    pin: { version: latest.version, releaseUrl: latest.releaseUrl },
  };
}

export function planCliUpdates({ codexTracked, codexLatest, grokTracked, grokLatest }) {
  const codex = planUpdate(codexTracked, codexLatest);
  const grok = planUpdate(grokTracked, grokLatest);
  return { update: Boolean(codex.update || grok.update), codex, grok };
}

export function parseChannelVersion(body) {
  const line = String(body ?? "").replaceAll("\r", "").split("\n")[0]?.trim() ?? "";
  return isStableSemver(line) ? line : null;
}

export function readPin(file) {
  const pin = JSON.parse(readFileSync(file, "utf8"));
  if (!isStableSemver(pin.version) || typeof pin.releaseUrl !== "string") {
    throw new Error(`Invalid CLI pin: ${file}`);
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

export function releaseNotes({ version, date, codexVersion, releaseUrl, grokVersion, grokReleaseUrl }) {
  const english = [];
  const korean = [];
  if (codexVersion) {
    english.push(`- Tracked Codex CLI is ${codexVersion} (${releaseUrl}). No protocol change.`);
    korean.push(`- 추적하는 Codex CLI는 ${codexVersion}입니다 (${releaseUrl}). 프로토콜 변경은 없습니다.`);
  }
  if (grokVersion) {
    english.push(`- Tracked Grok CLI is ${grokVersion} (${grokReleaseUrl}). No bridge change.`);
    korean.push(`- 추적하는 Grok CLI는 ${grokVersion}입니다 (${grokReleaseUrl}). 브리지 변경은 없습니다.`);
  }
  if (english.length === 0) throw new Error("Release notes need a Codex or Grok CLI version");
  const en = `${english.join("\n")}\n\n`;
  const ko = `${korean.join("\n")}\n\n`;
  return {
    changelog: `## ${version} — ${date}\n\n${en}`,
    readmeEn: `### ${version} — ${date}\n\n${en}`,
    readmeKo: `### ${version} — ${date}\n\n${ko}`,
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

export function applyTrackBump({
  packageJson,
  packageLock,
  changelog,
  readme,
  codexVersion,
  releaseUrl,
  grokVersion,
  grokReleaseUrl,
  date,
}) {
  const from = JSON.parse(packageJson).version;
  const to = bumpPatch(from);
  const notes = releaseNotes({ version: to, date, codexVersion, releaseUrl, grokVersion, grokReleaseUrl });
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

export function trackTitle({ packageVersion, codexUpdate, grokUpdate, codexLatest, grokLatest }) {
  if (codexUpdate && grokUpdate) {
    return `Track Codex CLI ${codexLatest} and Grok CLI ${grokLatest} as ${packageVersion}`;
  }
  if (grokUpdate) return `Track Grok CLI ${grokLatest} as ${packageVersion}`;
  return `Track Codex CLI ${codexLatest} as ${packageVersion}`;
}

export function pullRequestBody({ tracked, latest, npmLatest, packageVersion, codex, grok }) {
  const lines = [];
  const codexChange = codex?.update
    ? codex
    : latest && tracked
      ? { update: true, tracked, latest, npmLatest }
      : null;
  if (codexChange?.update) {
    lines.push(
      `Tracked Codex CLI moves from \`${codexChange.tracked}\` to \`${codexChange.latest.version}\`.`,
      "",
      `Upstream release notes: ${codexChange.latest.releaseUrl}`,
      "",
      `npm \`${NPM_PACKAGE}\` dist-tag \`latest\`: \`${codexChange.npmLatest ?? npmLatest ?? "unknown"}\`.`,
      "",
    );
  }
  if (grok?.update) {
    lines.push(
      `Tracked Grok CLI moves from \`${grok.tracked}\` to \`${grok.latest.version}\`.`,
      "",
      `Stable channel: ${grok.latest.channelUrl ?? GROK_STABLE_URLS[0]}`,
      "",
      `Upstream release notes: ${grok.latest.releaseUrl}`,
      "",
    );
  }
  lines.push(
    `This pull request bumps codex-grok-bridge to \`${packageVersion}\` and records that CLI in the changelog and README. It does not publish to npm, create a git tag, or merge. Publishing runs from the main workflow after merge.`,
    "",
  );
  if (codexChange?.update) {
    lines.push(
      "## Upstream notes",
      "",
      releaseNotesExcerpt(codexChange.latest.body) || "_The release body was empty._",
      "",
    );
  }
  return lines.join("\n");
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

export async function loadGrokLatest({ fetchImpl = globalThis.fetch } = {}) {
  let lastError = new Error("No stable Grok CLI release found");
  for (const url of GROK_STABLE_URLS) {
    try {
      const version = parseChannelVersion(await getText(fetchImpl, url));
      if (!version) {
        lastError = new Error(`Invalid Grok CLI channel version from ${url}`);
        continue;
      }
      return { version, releaseUrl: GROK_CHANGELOG_URL, channelUrl: url };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function getText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { Accept: "text/plain", "User-Agent": "codex-grok-bridge" },
  });
  if (!response.ok) {
    const error = new Error(`${response.status} for ${url}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
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
  const grokPinPath = argValue(args, "--grok-pin") || DEFAULT_GROK_PIN;
  const notesOut = argValue(args, "--notes-out");
  const write = args.includes("--write-if-newer");
  const pin = readPin(pinPath);
  const grokPin = readPin(grokPinPath);
  const { npmLatest, latest } = await loadLatest({
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  });
  if (!latest) throw new Error("No stable Codex CLI release found");
  const grokLatest = await loadGrokLatest();
  const plan = planCliUpdates({
    codexTracked: pin.version,
    codexLatest: latest,
    grokTracked: grokPin.version,
    grokLatest,
  });
  const packagePath = path.join(root, "package.json");
  const currentPackage = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const packageVersion = plan.update ? bumpPatch(currentPackage) : currentPackage;
  const title = trackTitle({
    packageVersion,
    codexUpdate: plan.codex.update,
    grokUpdate: plan.grok.update,
    codexLatest: latest.version,
    grokLatest: grokLatest.version,
  });
  if (plan.update && write) {
    const bumped = applyTrackBump({
      packageJson: readFileSync(packagePath, "utf8"),
      packageLock: readFileSync(path.join(root, "package-lock.json"), "utf8"),
      changelog: readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
      readme: readFileSync(path.join(root, "README.md"), "utf8"),
      ...(plan.codex.update ? { codexVersion: latest.version, releaseUrl: latest.releaseUrl } : {}),
      ...(plan.grok.update ? { grokVersion: grokLatest.version, grokReleaseUrl: grokLatest.releaseUrl } : {}),
      date: new Date().toISOString().slice(0, 10),
    });
    if (plan.codex.update) writePin(pinPath, plan.codex.pin);
    if (plan.grok.update) writePin(grokPinPath, plan.grok.pin);
    writeFileSync(packagePath, bumped.packageJson);
    writeFileSync(path.join(root, "package-lock.json"), bumped.packageLock);
    writeFileSync(path.join(root, "CHANGELOG.md"), bumped.changelog);
    writeFileSync(path.join(root, "README.md"), bumped.readme);
  }
  if (plan.update && notesOut) {
    writeFileSync(notesOut, pullRequestBody({
      packageVersion,
      codex: plan.codex.update ? { update: true, tracked: pin.version, latest, npmLatest } : { update: false },
      grok: plan.grok.update ? { update: true, tracked: grokPin.version, latest: grokLatest } : { update: false },
    }));
  }
  console.log(JSON.stringify({
    update: plan.update,
    tracked: pin.version,
    latest: latest.version,
    releaseUrl: latest.releaseUrl,
    npmLatest,
    grokTracked: grokPin.version,
    grokLatest: grokLatest.version,
    grokReleaseUrl: grokLatest.releaseUrl,
    packageVersion,
    title,
  }));
  setOutput("update", String(plan.update));
  setOutput("tracked", pin.version);
  setOutput("latest", latest.version);
  setOutput("release_url", latest.releaseUrl);
  setOutput("npm_latest", npmLatest);
  setOutput("grok_tracked", grokPin.version);
  setOutput("grok_latest", grokLatest.version);
  setOutput("grok_release_url", grokLatest.releaseUrl);
  setOutput("package_version", packageVersion);
  setOutput("title", title);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
