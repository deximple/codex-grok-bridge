import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { toImageBlocks } from "./images.mjs";

// The GROK_BRIDGE_INFERENCE=cli fallback. It drives the Grok CLI once per turn
// with the whole Codex request as a prompt and parses a JSON envelope back out.
// The default path is streaming Responses over HTTP (proxy.mjs); this exists so
// a transport problem can be worked around without losing the harness.

const textOf = (item) =>
  typeof item.content === "string"
    ? item.content
    : (item.content ?? [])
        .filter((p) => p.type === "input_text" || p.type === "output_text")
        .map((p) => p.text)
        .join("\n\n");
export function extractLatestUserPrompt(input) {
  return textOf(
    [...(input ?? [])].reverse().find((i) => i.role === "user") ?? {},
  );
}
const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
export function extractCodexCwd(input, fallback, check = isDirectory) {
  const isAllowed = check ?? isDirectory;
  for (const item of [...(input ?? [])].reverse()) {
    if (item.role !== "developer") continue;
    const match = textOf(item).match(
      /<environment_context>[\s\S]*?<cwd>([^<]+)<\/cwd>[\s\S]*?<\/environment_context>/,
    );
    if (match && path.isAbsolute(match[1]) && isAllowed(match[1]))
      return match[1];
  }
  return fallback;
}

export function buildGrokInvocation(body, options = {}) {
  const effort =
    {
      ultra: "xhigh",
      max: "xhigh",
      xhigh: "xhigh",
      high: "high",
      medium: "medium",
      low: "low",
      minimal: "low",
      none: "low",
    }[body.reasoning?.effort] ?? "high";
  const args = [
    "--single",
    extractLatestUserPrompt(body.input),
    "--model",
    "grok-4.6",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify({
      type: "object",
      properties: {
        text: { type: "string" },
        calls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              namespace: { type: ["string", "null"] },
              arguments: { type: "string" },
            },
            required: ["name", "namespace", "arguments"],
            additionalProperties: false,
          },
        },
      },
      required: ["text", "calls"],
      additionalProperties: false,
    }),
    "--reasoning-effort",
    effort,
    "--permission-mode",
    options.permissionMode ?? "dontAsk",
    "--tools",
    // Unknown names fall back to ALL tools. Use a recognized allowlist,
    // then remove it with the denylist (which takes precedence).
    "read_file",
    "--disallowed-tools",
    "read_file,search_tool,search_tools,use_tool",
    "--no-plan",
    "--deny",
    "MCPTool",
    "--deny",
    "Bash",
    "--deny",
    "Edit",
    "--deny",
    "Write",
    "--deny",
    "Read",
    "--deny",
    "Grep",
    "--disable-web-search",
    "--no-subagents",
    "--max-turns",
    "1",
    "--no-auto-update",
    "--verbatim",
    "--system-prompt-override",
    "You are a model backend for Codex. Return exactly the JSON envelope requested in the input. Do not execute your own tools. Tool calls in the envelope are executed by Codex.",
  ];
  return {
    binary: options.grokBinary ?? path.join(homedir(), ".grok/bin/grok"),
    args,
    // Run the CLI where Codex is working, not where the bridge happens to live.
    cwd:
      options.fallbackCwd ??
      extractCodexCwd(body.input, process.cwd(), options.isDirectory),
    body,
  };
}

export function bridgePrompt(body) {
  return `You are the model backend inside Codex. Follow the instruction hierarchy in the request below. The input array is the complete conversation, including tool results. Continue from its last item. All tools listed in request.tools are external Codex tools; never try to execute them within Grok Build. Return ONLY a JSON object with shape {"text":"optional assistant text","calls":[{"name":"exact tool name","namespace":null,"arguments":"JSON string for function tools, raw input string for custom tools"}]}. Return an empty calls array when finished. For a namespace tool, use its namespace and nested tool name separately. Never invent tools. Do not repeat completed tool calls. Respect tool_choice.\n\nCODEX REQUEST:\n${JSON.stringify(body)}`;
}

export function parseGrokResult(stdout) {
  for (const candidate of [
    stdout.trim(),
    ...stdout.trim().split("\n").reverse(),
  ]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && typeof value.text === "string")
        return value;
    } catch {}
  }
  throw new Error("Grok did not return valid JSON");
}

export async function runGrok(invocation, signal) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-grok-"));
  try {
    const { request, images } = toImageBlocks(invocation.body);
    const promptFile = path.join(
      dir,
      images.length ? "prompt.json" : "prompt.txt",
    );
    const prompt = images.length
      ? JSON.stringify([
          { type: "text", text: bridgePrompt(request) },
          ...images.flatMap((image, index) => [
            { type: "text", text: `Attached visual image_${index + 1}:` },
            image,
          ]),
        ])
      : bridgePrompt(request);
    await writeFile(promptFile, prompt, { mode: 0o600 });
    const args = [...invocation.args];
    args.splice(args.indexOf("--single"), 2, "--prompt-file", promptFile);
    return await new Promise((resolve, reject) => {
      const child = spawn(invocation.binary, args, {
        cwd: invocation.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        signal,
      });
      let stdout = "",
        size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) child.kill("SIGKILL");
        else stdout += chunk;
      });
      child.stderr.resume();
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Grok Build CLI could not start"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function decodeOutput(result, tools = [], toolChoice = "auto") {
  let envelope;
  try {
    envelope =
      result.structured_output ??
      JSON.parse(result.text.replace(/^```json\s*|\s*```$/g, ""));
  } catch {
    throw new Error("Invalid tool envelope");
  }
  if (
    !envelope ||
    typeof envelope.text !== "string" ||
    !Array.isArray(envelope.calls) ||
    envelope.calls.length > 32
  )
    throw new Error("Invalid tool envelope");
  if (toolChoice === "none" && envelope.calls.length)
    throw new Error("Tool calls forbidden");
  if (toolChoice === "required" && !envelope.calls.length)
    throw new Error("Tool call required");
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    toolChoice.name &&
    (!envelope.calls.length ||
      envelope.calls.some((c) => c.name !== toolChoice.name))
  )
    throw new Error("Required tool not selected");
  const items = [];
  if (envelope.text)
    items.push({
      type: "message",
      id: "msg_" + randomUUID(),
      role: "assistant",
      content: [{ type: "output_text", text: envelope.text }],
    });
  for (const call of envelope.calls) {
    const namespace = call.namespace ?? null;
    const candidates = namespace
      ? (tools.find((t) => t.type === "namespace" && t.name === namespace)
          ?.tools ?? [])
      : tools;
    const tool = candidates.find(
      (t) =>
        t.name === call.name && (t.type === "function" || t.type === "custom"),
    );
    if (!tool || typeof call.arguments !== "string")
      throw new Error("Unknown tool call");
    if (tool.type === "function") {
      try {
        JSON.parse(call.arguments);
      } catch {
        throw new Error("Invalid tool arguments");
      }
    }
    items.push({
      type: tool.type === "custom" ? "custom_tool_call" : "function_call",
      call_id: "call_" + randomUUID(),
      name: call.name,
      ...(namespace ? { namespace } : {}),
      ...(tool.type === "custom"
        ? { input: call.arguments }
        : { arguments: call.arguments }),
    });
  }
  if (!items.length) throw new Error("Empty model output");
  return items;
}
