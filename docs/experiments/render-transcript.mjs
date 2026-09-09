// Render a Claude Code session transcript (.jsonl) into readable, redacted
// markdown. The raw transcript contains every tool result verbatim, including
// anything a `cat` happened to print — this session's own transcript carries a
// real MCP token that way — so nothing goes into the repo unredacted.
//
//   node docs/experiments/render-transcript.mjs <session.jsonl> <out.md>
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const [, , source, destination] = process.argv;
if (!source || !destination) {
  console.error("usage: render-transcript.mjs <session.jsonl> <out.md>");
  process.exit(2);
}

const HOME = homedir();
const MAX_TOOL_INPUT = 700;
const MAX_TOOL_RESULT = 900;
const MAX_TEXT = 6000;

// Structural, not name-based: a secret is recognised by its shape, because the
// field it arrives in is not stable.
const SECRETS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[jwt]"],
  [/Bearer\s+[A-Za-z0-9._~+/-]{20,}/g, "Bearer [redacted]"],
  [/\b(?:sk|xai)-[A-Za-z0-9_-]{16,}/g, "[key]"],
  // TOKEN/SECRET/PASSWORD assignments in any of toml, json, env or shell shape.
  [
    /((?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY)[A-Za-z_]*"?\s*[:=]\s*")[^"]{12,}(")/gi,
    "$1[redacted]$2",
  ],
  [/("key"\s*:\s*")[A-Za-z0-9._~+/-]{20,}(")/g, "$1[redacted]$2"],
];

function redact(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRETS) text = text.replace(pattern, replacement);
  return text.split(HOME).join("~");
}

const clip = (value, limit) => {
  const text = redact(value).replace(/\r/g, "");
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more chars)` : text;
};

const rows = readFileSync(source, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const toolNames = new Map();
const out = [];
let turn = 0;
const counts = { user: 0, assistant: 0, tools: 0, thinking: 0 };

const blocks = (message) =>
  Array.isArray(message?.content)
    ? message.content
    : typeof message?.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];

for (const row of rows) {
  if (row.type === "user" && !row.isMeta) {
    const parts = blocks(row.message);
    const results = parts.filter((part) => part.type === "tool_result");
    for (const result of results) {
      const name = toolNames.get(result.tool_use_id) ?? "tool";
      const body = Array.isArray(result.content)
        ? result.content.map((c) => c.text ?? `[${c.type}]`).join("\n")
        : (result.content ?? "");
      out.push(`<details><summary>result · ${name}${result.is_error ? " · ERROR" : ""}</summary>\n`);
      out.push("```\n" + clip(body, MAX_TOOL_RESULT) + "\n```\n</details>\n");
    }
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) {
      turn += 1;
      counts.user += 1;
      out.push(`\n---\n\n## Turn ${turn} · user\n\n${clip(text, MAX_TEXT)}\n`);
    }
    continue;
  }

  if (row.type !== "assistant") continue;
  for (const part of blocks(row.message)) {
    if (part.type === "thinking") {
      counts.thinking += 1;
      continue; // reasoning is not part of the record being handed off
    }
    if (part.type === "text" && part.text.trim()) {
      counts.assistant += 1;
      out.push(`\n### assistant\n\n${clip(part.text, MAX_TEXT)}\n`);
    }
    if (part.type === "tool_use") {
      counts.tools += 1;
      toolNames.set(part.id, part.name);
      const input =
        part.name === "Bash"
          ? (part.input.command ?? "")
          : JSON.stringify(part.input ?? {}, null, 1);
      out.push(`\n**tool · ${part.name}**${part.input?.description ? ` — ${redact(part.input.description)}` : ""}\n`);
      out.push("```\n" + clip(input, MAX_TOOL_INPUT) + "\n```\n");
    }
  }
}

const header = [
  "# Session transcript — Codex–Grok bridge",
  "",
  `Source: \`${source.split("/").pop()}\` (raw, unredacted, stays in \`~/.claude/projects/\`)`,
  `Rendered: ${rows.at(-1)?.timestamp ?? "unknown"} · ${rows.length} records`,
  `Content: ${counts.user} user turns, ${counts.assistant} assistant messages, ${counts.tools} tool calls`,
  `(${counts.thinking} reasoning blocks omitted)`,
  "",
  "Secrets are redacted by shape (JWT, Bearer, sk-/xai-, TOKEN/SECRET assignments,",
  "`\"key\"` fields) and the home directory is rewritten to `~`. Regenerate with:",
  "",
  "```sh",
  "node docs/experiments/render-transcript.mjs \\",
  "  ~/.claude/projects/<project>/<session>.jsonl docs/session-transcript.md",
  "```",
  "",
].join("\n");

const rendered = header + out.join("\n");

// Refuse to write a file that still looks like it carries a credential. Clipping
// long tool results hides most of them by accident; this makes it deliberate.
const LEAKS = [
  ["JWT", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g],
  ["bearer token", /Bearer\s+[A-Za-z0-9._~+/-]{20,}/g],
  ["api key", /\b(?:sk|xai)-[A-Za-z0-9_-]{16,}/g],
  ["token assignment", /(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY)[A-Za-z_]*"?\s*[:=]\s*"[^"]{12,}"/gi],
  ["home path", new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")],
];
const leaks = LEAKS.flatMap(([label, pattern]) => {
  const hits = rendered.match(pattern) ?? [];
  // The RFC example JWT is a test fixture in this repo, not a credential.
  const real = hits.filter((hit) => !hit.startsWith("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"));
  return real.length ? [`${label}: ${real.length}`] : [];
});
if (leaks.length) {
  console.error("refusing to write, redaction missed: " + leaks.join(", "));
  process.exit(1);
}

writeFileSync(destination, rendered, { mode: 0o600 });
console.log(
  `wrote ${destination}: ${counts.user} user turns, ${counts.assistant} assistant messages, ${counts.tools} tool calls`,
);
