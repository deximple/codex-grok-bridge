import {
  GROK_IMAGE_TOOL,
  describeGeneratedImage,
  isImageGenerationItem,
  saveGeneratedImage,
} from "./imagegen.mjs";
import { GROK_VIDEO_TOOL, GROK_VIDEO_TOOL_NAME } from "./videogen.mjs";
import { DEFAULT_GROK_MODEL, resolveGrokModel } from "./models.mjs";
import {
  applyCacheUsage,
  logicalFingerprint,
  readCacheUsage,
  stableJsonValue,
  stableProxyName,
} from "./prefix.mjs";

const OBJECT_SCHEMA = { type: "object", properties: {} };

const CUSTOM_INPUT_SCHEMA = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description: "Raw freeform input for the Codex custom tool.",
    },
  },
  required: ["input"],
  additionalProperties: false,
};

const EFFORT = {
  ultra: "xhigh",
  max: "xhigh",
  xhigh: "xhigh",
  high: "high",
  medium: "medium",
  low: "low",
  minimal: "low",
  none: "low",
};

const DROP = Symbol("drop");
// Items whose payload only the originating provider can read. "reasoning" is
// deliberately absent: Codex reasoning items carry a plain-text summary that is
// useful to Grok across a multi-call turn, and only their encrypted_content is
// opaque - that field is stripped by the key filter below. Compaction items are
// likewise absent: a stored summary is rewritten into a user message, and an
// item with no readable text is dropped.
const PROVIDER_OPAQUE_TYPES = new Set(["encrypted_content"]);
const COMPACTION_ITEM_TYPES = new Set([
  "compaction",
  "compaction_summary",
  "context_compaction",
]);
const GROK_INPUT_ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "shell_call",
]);
// Codex item ids, status, and new client metadata have 422'd the upstream.
// Keep only the fields Grok's Responses input is known to accept.
const INPUT_ITEM_FIELDS = {
  message: ["type", "role", "content"],
  reasoning: ["type", "summary"],
  function_call: ["type", "name", "call_id", "arguments"],
  function_call_output: ["type", "name", "call_id", "output"],
  shell_call: ["type", "name", "call_id", "action"],
};
const CONTENT_PART_FIELDS = {
  input_text: ["type", "text"],
  output_text: ["type", "text"],
  summary_text: ["type", "text"],
  input_image: ["type", "image_url", "detail"],
};

function pickKeys(node, keys) {
  const next = {};
  for (const key of keys) {
    if (node[key] !== undefined) next[key] = node[key];
  }
  return next;
}

function whitelistContentPart(part) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return part;
  // Chat audio is not a Responses content part Grok accepts. Leaving the bytes
  // in history makes the upstream reject the turn, and every later turn with it.
  if (part.type === "input_audio") {
    return {
      type: "input_text",
      text: "[An audio attachment was not sent to the model. Say so if the user asks about it.]",
    };
  }
  const keys = CONTENT_PART_FIELDS[part.type];
  if (!keys) return part;
  const next = pickKeys(part, keys);
  if (next.image_url && typeof next.image_url === "object")
    next.image_url = pickKeys(next.image_url, ["url", "detail"]);
  return next;
}

function whitelistInputNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const itemKeys = INPUT_ITEM_FIELDS[node.type];
  if (itemKeys) {
    const next = pickKeys(node, itemKeys);
    if (Array.isArray(next.content))
      next.content = next.content.map(whitelistContentPart);
    return next;
  }
  if (node.type == null && node.role != null && node.content !== undefined) {
    const next = pickKeys(node, ["role", "content"]);
    if (Array.isArray(next.content))
      next.content = next.content.map(whitelistContentPart);
    return next;
  }
  return whitelistContentPart(node);
}

function isObjectFragment(schema) {
  return (
    schema &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    (schema.type === "object" || schema.type == null)
  );
}

function mergeObjectFragments(fragments) {
  const properties = {};
  let required;
  for (const fragment of fragments) {
    if (fragment.properties && typeof fragment.properties === "object")
      Object.assign(properties, fragment.properties);
    const keys = Array.isArray(fragment.required) ? fragment.required : [];
    required =
      required === undefined
        ? keys.slice()
        : required.filter((key) => keys.includes(key));
  }
  return { properties, required };
}

function emitObjectParameters(source, overrides = {}) {
  const properties =
    overrides.properties ??
    (source.properties && typeof source.properties === "object"
      ? source.properties
      : {});
  const required =
    overrides.required !== undefined
      ? overrides.required
      : Array.isArray(source.required)
        ? source.required
        : undefined;
  const next = { type: "object", properties: { ...properties } };
  if (required?.length) next.required = required.slice();
  if (source.additionalProperties !== undefined)
    next.additionalProperties = source.additionalProperties;
  if (source.description !== undefined) next.description = source.description;
  return next;
}

function usableParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
    return OBJECT_SCHEMA;
  const variants = Array.isArray(parameters.oneOf)
    ? parameters.oneOf
    : Array.isArray(parameters.anyOf)
      ? parameters.anyOf
      : null;
  if (!variants) {
    return parameters.type === "object"
      ? emitObjectParameters(parameters)
      : OBJECT_SCHEMA;
  }
  const fragments = variants.filter(isObjectFragment);
  if (fragments.length === 0) {
    return parameters.type === "object"
      ? emitObjectParameters(parameters)
      : OBJECT_SCHEMA;
  }
  const merged = mergeObjectFragments(fragments);
  const properties = {
    ...(parameters.properties && typeof parameters.properties === "object"
      ? parameters.properties
      : {}),
    ...merged.properties,
  };
  const intersection = merged.required ?? [];
  const root = Array.isArray(parameters.required) ? parameters.required : [];
  const required = [];
  const seen = new Set();
  for (const key of [...root, ...intersection]) {
    if (seen.has(key)) continue;
    seen.add(key);
    required.push(key);
  }
  const first = fragments[0];
  return emitObjectParameters(
    {
      additionalProperties:
        parameters.additionalProperties ?? first.additionalProperties,
      description: parameters.description ?? first.description,
    },
    { properties, required },
  );
}

function sanitize(name) {
  return String(name || "tool")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 40);
}

function findProxyName(map, name, namespace = null) {
  for (const [proxyName, origin] of map) {
    if (origin.name === name && origin.namespace === namespace) return proxyName;
  }
  return null;
}

function customInputArguments(input) {
  return JSON.stringify({ input: typeof input === "string" ? input : "" });
}

function decodeCustomInput(argumentsValue) {
  if (typeof argumentsValue !== "string") return "";
  try {
    const parsed = JSON.parse(argumentsValue);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string")
      return parsed.input;
  } catch {}
  return argumentsValue;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// xAI runs `{type:"web_search"}` on the server. A hashed function is never
// called, so Codex's hosted tool stays one server tool. Keep filters and
// allowed_domains; every other field on that tool is dropped.
function keptWebSearchFields(tool) {
  const next = {};
  if (plainObject(tool.filters)) next.filters = tool.filters;
  if (Array.isArray(tool.allowed_domains))
    next.allowed_domains = tool.allowed_domains;
  return next;
}

function addFunction(flattened, map, spec) {
  // Index names change when Codex reorders tools, which rewrites every
  // earlier function_call and breaks the prompt-cache prefix.
  let proxyName = stableProxyName(spec, sanitize(spec.name));
  if (map.has(proxyName)) {
    let n = 2;
    while (map.has(`${proxyName}_${n}`)) n += 1;
    proxyName = `${proxyName}_${n}`;
  }
  map.set(proxyName, {
    kind: spec.kind,
    namespace: spec.namespace,
    name: spec.name,
  });
  flattened.push({
    type: "function",
    name: proxyName,
    description: spec.namespace
      ? `[${spec.namespace}] ${spec.description || spec.name}`
      : spec.description || spec.name,
    parameters: stableJsonValue(
      spec.kind === "custom"
        ? structuredClone(CUSTOM_INPUT_SCHEMA)
        : usableParameters(spec.parameters),
    ),
  });
}

export function flattenCodexTools(tools = []) {
  const flattened = [];
  const map = new Map();
  let webSearch = null;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "web_search") {
      const kept = keptWebSearchFields(tool);
      if (!webSearch) {
        webSearch = { type: "web_search", ...kept };
        flattened.push(webSearch);
      } else {
        if (webSearch.filters === undefined && kept.filters !== undefined)
          webSearch.filters = kept.filters;
        if (
          webSearch.allowed_domains === undefined &&
          kept.allowed_domains !== undefined
        )
          webSearch.allowed_domains = kept.allowed_domains;
      }
      continue;
    }
    if (tool.type === "function" || tool.type === "custom") {
      addFunction(flattened, map, {
        kind: tool.type === "custom" ? "custom" : "function",
        namespace: null,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
      continue;
    }
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        if (!nested || typeof nested !== "object") continue;
        addFunction(flattened, map, {
          kind: nested.type === "custom" ? "custom" : "function",
          namespace: tool.name,
          name: nested.name,
          description: nested.description,
          parameters: nested.parameters,
        });
      }
      continue;
    }
    flattened.push(stableJsonValue(structuredClone(tool)));
  }
  if (webSearch) {
    const index = flattened.indexOf(webSearch);
    flattened[index] = stableJsonValue(structuredClone(webSearch));
  }
  return { tools: flattened, map };
}

export function proxyToolChoice(choice, map) {
  if (choice === "auto" || choice === "none" || choice === "required")
    return choice;
  if (!choice || typeof choice !== "object" || !choice.name) return "auto";
  const namespace = choice.namespace ?? null;
  for (const [proxyName, origin] of map) {
    if (origin.name === choice.name && origin.namespace === namespace)
      return { type: "function", name: proxyName };
  }
  return "auto";
}

function readableString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function textsFromValue(value) {
  const direct = readableString(value);
  if (direct) return [direct];
  if (!Array.isArray(value)) return [];
  const texts = [];
  for (const part of value) {
    if (!part || typeof part !== "object" || part.type === "encrypted_content")
      continue;
    const text = readableString(part.text);
    if (text) texts.push(text);
  }
  return texts;
}

// Codex replaces older history with a compaction item. The encrypted blob is
// provider-private, but the item may already carry the summary as plain text.
// That text is what Grok can read; everything else on the item is dropped.
function compactionInputTexts(node) {
  for (const key of ["summary", "content", "text", "message"]) {
    const texts = textsFromValue(node[key]);
    if (texts.length) return texts;
  }
  return [];
}

function rememberText(texts, seen, value) {
  const text = readableString(value);
  if (!text || seen.has(text)) return;
  seen.add(text);
  texts.push(text);
}

// Content parts, stdout/stderr rows, and bare string lists. Encrypted parts
// are skipped. This does not walk arbitrary keys, so ids, status, env, and
// image bytes are not treated as text.
function rememberTextValue(texts, seen, value) {
  if (typeof value === "string") {
    rememberText(texts, seen, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      if (typeof part === "string") {
        rememberText(texts, seen, part);
        continue;
      }
      if (!part || typeof part !== "object" || part.type === "encrypted_content")
        continue;
      rememberText(texts, seen, part.text);
      rememberText(texts, seen, part.stdout);
      rememberText(texts, seen, part.stderr);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  rememberText(texts, seen, value.text);
  rememberText(texts, seen, value.stdout);
  rememberText(texts, seen, value.stderr);
  if (typeof value.content === "string" || Array.isArray(value.content))
    rememberTextValue(texts, seen, value.content);
}

function commandLines(action) {
  const lines = [];
  for (const list of [action.command, action.commands]) {
    if (Array.isArray(list)) {
      const line = list.filter((part) => typeof part === "string").join(" ").trim();
      if (line) lines.push(line);
    } else if (typeof list === "string" && list.trim()) {
      lines.push(list.trim());
    }
  }
  return lines;
}

function rememberArguments(texts, seen, value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        value = parsed;
      else {
        rememberText(texts, seen, value);
        return;
      }
    } catch {
      rememberText(texts, seen, value);
      return;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  rememberText(texts, seen, value.query);
  rememberTextValue(texts, seen, value.queries);
}

function stripOpaqueFields(value) {
  if (Array.isArray(value)) return value.map(stripOpaqueFields);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "encrypted_content" ||
      key === "encrypted_function_args" ||
      key.startsWith("internal_")
    )
      continue;
    next[key] = stripOpaqueFields(child);
  }
  return next;
}

function containsReadableText(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(containsReadableText);
  if (value && typeof value === "object")
    return Object.values(value).some(containsReadableText);
  return false;
}

function rememberTools(texts, seen, tools) {
  if (!Array.isArray(tools) || !tools.length) return;
  const stripped = stripOpaqueFields(tools);
  if (!containsReadableText(stripped)) return;
  rememberText(texts, seen, JSON.stringify(stripped));
}

// Text Grok can read off an item type it will not accept. The caller turns
// these strings into a user message. Fields that 422 when forwarded
// (encrypted blobs, internal metadata, image bytes) are not read.
function droppedItemInputTexts(node) {
  const texts = [];
  const seen = new Set();
  for (const key of [
    "summary",
    "content",
    "text",
    "message",
    "input",
    "output",
    "query",
    "revised_prompt",
  ]) {
    rememberTextValue(texts, seen, node[key]);
  }
  const action = node.action;
  if (action && typeof action === "object" && !Array.isArray(action)) {
    const lines = commandLines(action);
    for (const line of lines) rememberText(texts, seen, line);
    if (lines.length) rememberText(texts, seen, action.working_directory);
    rememberText(texts, seen, action.query);
    rememberTextValue(texts, seen, action.queries);
    rememberText(texts, seen, action.url);
    rememberText(texts, seen, action.pattern);
  }
  rememberArguments(texts, seen, node.arguments);
  rememberTools(texts, seen, node.tools);
  const aggregated = readableString(node.aggregated_output) ?? readableString(node.formatted_output);
  if (aggregated) rememberText(texts, seen, aggregated);
  else {
    rememberText(texts, seen, node.stdout);
    rememberText(texts, seen, node.stderr);
  }
  const rememberExit = (value) => {
    if (Number.isInteger(value) && value !== 0) rememberText(texts, seen, `exit ${value}`);
  };
  rememberExit(node.exit_code);
  const output = node.output;
  if (Array.isArray(output)) {
    for (const row of output) {
      if (!row || typeof row !== "object") continue;
      rememberExit(row.exit_code);
      rememberExit(row.outcome?.exit_code);
    }
  } else if (output && typeof output === "object") {
    rememberExit(output.exit_code);
    rememberExit(output.outcome?.exit_code);
  }
  return texts;
}

function functionOutputText(output) {
  if (typeof output === "string") return output;
  const parts = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  };
  const visit = (value) => {
    if (typeof value === "string") {
      push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const part of value) visit(part);
      return;
    }
    if (!value || typeof value !== "object") return;
    push(value.text);
    push(value.stdout);
    push(value.stderr);
    const image = value.image_url;
    if (typeof image === "string") push(image);
    else if (image && typeof image === "object") push(image.url);
    if (Array.isArray(value.content)) visit(value.content);
  };
  visit(output);
  return parts.join("\n");
}

function userInputTextMessage(texts) {
  return whitelistInputNode({
    type: "message",
    role: "user",
    content: texts.map((text) => ({ type: "input_text", text })),
  });
}

function toProxyInputNode(node, map, state, salvage = false) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    const items = [];
    for (const item of node) {
      const next = toProxyInputNode(item, map, state);
      if (next !== DROP) items.push(next);
    }
    return items;
  }

  if (PROVIDER_OPAQUE_TYPES.has(node.type))
    return DROP;

  const next = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "encrypted_content" ||
      key === "encrypted_function_args" ||
      key.startsWith("internal_")
    )
      continue;
    const converted = toProxyInputNode(value, map, state);
    if (converted !== DROP) next[key] = converted;
  }

  if (COMPACTION_ITEM_TYPES.has(next.type)) {
    const texts = compactionInputTexts(next);
    if (!texts.length) return DROP;
    return whitelistInputNode({
      type: "message",
      role: "user",
      content: texts.map((text) => ({ type: "input_text", text })),
    });
  }

  if (next.type === "reasoning") {
    // Forward the summary and nothing else. Codex's own item id and null
    // content fields mean nothing to the upstream and only widen the surface
    // for a schema rejection. When the summary is empty, the plain text in
    // content is the only readable reasoning left.
    const readable = (parts) =>
      (Array.isArray(parts) ? parts : []).filter(
        (part) => part && typeof part.text === "string" && part.text.trim() && part.type !== "encrypted_content",
      );
    const summary = readable(next.summary);
    const chosen = summary.length ? summary : readable(next.content);
    if (!chosen.length) return DROP;
    return whitelistInputNode({
      type: "reasoning",
      summary: chosen.map((part) => ({ type: "summary_text", text: part.text.trim() })),
    });
  }

  if (next.type === "agent_message") {
    const content = Array.isArray(next.content)
      ? next.content
      : typeof next.text === "string" && next.text
        ? [{ type: "input_text", text: next.text }]
        : [];
    if (!content.length) return DROP;
    return whitelistInputNode({ type: "message", role: "assistant", content });
  }

  if (
    next.type === "function_call" &&
    typeof next.name === "string"
  ) {
    const proxyName = findProxyName(map, next.name, next.namespace ?? null);
    if (proxyName) {
      next.name = proxyName;
      delete next.namespace;
      if (typeof next.call_id === "string") state.callIds.set(next.call_id, proxyName);
    }
  } else if (
    next.type === "custom_tool_call" &&
    typeof next.name === "string"
  ) {
    const proxyName = findProxyName(map, next.name, next.namespace ?? null);
    const origin = proxyName ? map.get(proxyName) : null;
    if (origin?.kind === "custom") {
      next.type = "function_call";
      next.name = proxyName;
      next.arguments = customInputArguments(next.input);
      delete next.namespace;
      delete next.input;
      if (typeof next.call_id === "string") state.callIds.set(next.call_id, proxyName);
    }
  } else if (
    next.type === "function_call_output" ||
    next.type === "custom_tool_call_output"
  ) {
    const proxyName =
      typeof next.name === "string"
        ? findProxyName(map, next.name, next.namespace ?? null)
        : typeof next.call_id === "string"
          ? state.callIds.get(next.call_id)
          : null;
    if (proxyName) {
      next.type = "function_call_output";
      next.name = proxyName;
      delete next.namespace;
    }
  }

  // Codex sends a string or a list of content parts. Grok accepts the string.
  if (next.type === "function_call_output" && typeof next.output !== "string")
    next.output = functionOutputText(next.output);

  const whitelisted = whitelistInputNode(next);
  if (!salvage || isForwardedItem(whitelisted)) return whitelisted;
  // Grok rejects these Codex item types. Keep the readable text as a user
  // message, the same shape as a compaction summary. An item with nothing
  // left but an encrypted blob, image bytes, or ids is dropped.
  const texts = droppedItemInputTexts(next);
  if (!texts.length) return DROP;
  return userInputTextMessage(texts);
}

function isForwardedItem(item) {
  return (
    item &&
    item !== DROP &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    (item.type == null || GROK_INPUT_ITEM_TYPES.has(item.type))
  );
}

function projectInput(input, map) {
  if (!Array.isArray(input)) {
    const items = toProxyInputNode(input, map, { callIds: new Map() }, true);
    return { items, pairs: [] };
  }
  const state = { callIds: new Map() };
  const pairs = [];
  for (const item of input) {
    const fingerprint = logicalFingerprint(item);
    const next = toProxyInputNode(item, map, state, true);
    if (!isForwardedItem(next)) continue;
    pairs.push({ fingerprint, item: next });
  }
  return { items: pairs.map((pair) => pair.item), pairs };
}

function toProxyInput(input, map) {
  return projectInput(input, map).items;
}

// Only the bridge knows a request is being served by the bridge. Codex does not
// put the provider or model into the prompt, so without this line the model has
// no way to answer "is Grok actually attached?" and either hedges or goes
// hunting through config files. Stated once, in the instructions, it costs a
// few tokens and removes the whole class of question.
export function transportProvenance(model = DEFAULT_GROK_MODEL) {
  return (
    "Transport: this request is served by the local Codex-Grok bridge — model " +
    `${model} via the grok_build_cli provider, with Codex owning tools, history ` +
    "and permissions. If asked whether Grok is attached to the Codex harness, " +
    "this line is the authoritative answer and no tool call is needed to confirm it."
  );
}

export const TRANSPORT_PROVENANCE = transportProvenance();

// Codex still injects its imagegen skill. That skill's fallback is OpenAI
// (`image_gen` or a Python CLI). The model will read the skill and send the
// picture to another vendor unless this line says not to. Grok already has
// image_generation on the request; no Codex tool call is required to pick it.
export const IMAGE_GENERATION_PROVENANCE =
  "Images: pictures on this transport are generated by Grok's image_generation " +
  "tool, which is already on the request. Do not read Codex's imagegen skill " +
  "and do not use OpenAI, image_gen, or a Python image CLI — those send the " +
  "picture to another vendor.";

// Codex does not offer a video tool to this provider, and cli-chat-proxy has
// no video_generation tool type. The function below is the bridge's own.
export const VIDEO_GENERATION_PROVENANCE =
  "Videos: clips on this transport are generated by the grok_bridge_generate_video " +
  "function, which is already on the request. The bridge calls Grok's videos API " +
  "with the grok login, saves the temporary file locally, and returns that path. " +
  "Do not ask for an API key and do not send the clip to another vendor.";

export function toProxyRequest(body) {
  const { tools, map } = flattenCodexTools(body.tools ?? []);
  const effort = EFFORT[body.reasoning?.effort] ?? "high";
  const projected = projectInput(body.input, map);
  const request = {
    model: resolveGrokModel(body.model),
    input: projected.items,
    tools,
    reasoning: { effort },
    stream: true,
    store: false,
  };
  // Grok generates images server-side when this tool is present. Codex never
  // offers one to this provider, so without it the only path is a different
  // vendor's API. GROK_BRIDGE_IMAGE_GEN=off restores that older behaviour.
  const declaresImageTool = request.tools.some(
    (tool) => tool?.type === GROK_IMAGE_TOOL.type,
  );
  const imageGenOn = process.env.GROK_BRIDGE_IMAGE_GEN !== "off";
  if (imageGenOn && !declaresImageTool)
    request.tools = [...request.tools, GROK_IMAGE_TOOL];
  // Codex tool names are rewritten to codex_<hash>_…, so this literal name
  // cannot collide with one. A second copy is not added if it is already there.
  const videoGenOn = process.env.GROK_BRIDGE_VIDEO_GEN !== "off";
  const declaresVideoTool = request.tools.some(
    (tool) => tool?.name === GROK_VIDEO_TOOL_NAME,
  );
  if (videoGenOn && !declaresVideoTool)
    request.tools = [...request.tools, GROK_VIDEO_TOOL];
  if (tools.length) {
    request.tool_choice = proxyToolChoice(body.tool_choice, map);
    request.parallel_tool_calls = body.parallel_tool_calls !== false;
  }
  const provenanceLine = transportProvenance(request.model);
  const notes = [
    imageGenOn ? IMAGE_GENERATION_PROVENANCE : "",
    videoGenOn ? VIDEO_GENERATION_PROVENANCE : "",
  ].filter(Boolean);
  const provenance = notes.length
    ? `${provenanceLine}\n\n${notes.join("\n\n")}`
    : provenanceLine;
  request.instructions =
    typeof body.instructions === "string" && body.instructions
      ? `${body.instructions}\n\n${provenance}`
      : provenance;
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key)
    request.prompt_cache_key = body.prompt_cache_key;
  return { request, map, projected: projected.pairs };
}

function rememberProxyItem(item, origin, state) {
  if (typeof item.call_id === "string") state.callIds.set(item.call_id, origin);
  if (typeof item.id === "string") state.itemIds.set(item.id, origin);
}

function restoreOriginName(node, origin) {
  node.name = origin.name;
  if (origin.namespace) node.namespace = origin.namespace;
  else delete node.namespace;
}

function originForResponseName(map, name) {
  if (typeof name !== "string") return null;
  if (map.has(name)) return map.get(name);
  let found = null;
  for (const origin of map.values()) {
    if (origin.name !== name) continue;
    if (found) return null;
    found = origin;
  }
  return found;
}

function rewriteResponseItem(node, map, state) {
  if (!node || typeof node !== "object") return;
  const origin =
    originForResponseName(map, node.name) ??
    (typeof node.call_id === "string" ? state.callIds.get(node.call_id) : null);
  if (origin) {
    rememberProxyItem(node, origin, state);
    restoreOriginName(node, origin);
    if (origin.kind === "custom") {
      if (node.type === "function_call") node.type = "custom_tool_call";
      if (node.type === "function_call_output") node.type = "custom_tool_call_output";
      if (node.type === "custom_tool_call") {
        if (node.input == null) node.input = decodeCustomInput(node.arguments);
        delete node.arguments;
        delete node.encrypted_function_args;
      }
    }
  }
}

// A generated image arrives as bytes on the stream. Codex has no tool for this
// and no place to put them, so the bridge writes the file and hands back an
// ordinary assistant message naming it.
function absorbGeneratedImage(item, state) {
  const key = typeof item.id === "string" ? item.id : "";
  if (key && state.savedImages?.has(key)) return state.savedImages.get(key);
  const saved = saveGeneratedImage(item, state.imageOptions);
  const described = describeGeneratedImage(
    typeof item.prompt === "string" && item.prompt.trim()
      ? item
      : { ...item, prompt: item.revised_prompt },
    saved,
  );
  const message = {
    type: "message",
    id: key || undefined,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: described }],
  };
  if (key) {
    if (!state.savedImages) state.savedImages = new Map();
    state.savedImages.set(key, message);
  }
  return message;
}

const USAGE_EVENTS = new Set(["response.completed", "response.incomplete"]);

function rewriteResponseEvent(value, map, state) {
  if (!value || typeof value !== "object") return value;
  if (
    USAGE_EVENTS.has(value.type) &&
    value.response &&
    typeof value.response.usage === "object"
  ) {
    applyCacheUsage(value.response.usage);
    const cache = readCacheUsage(value.response.usage);
    if (cache) state.cacheUsage = cache;
  }
  if (Array.isArray(value.response?.output)) {
    for (let i = 0; i < value.response.output.length; i += 1) {
      const item = value.response.output[i];
      if (isImageGenerationItem(item))
        value.response.output[i] = absorbGeneratedImage(item, state);
      else rewriteResponseItem(item, map, state);
    }
  }
  if (
    value.type === "response.function_call_arguments.delta" ||
    value.type === "response.function_call_arguments.done"
  ) {
    const origin = originForResponseName(map, value.name);
    if (origin) {
      rememberProxyItem(value, origin, state);
      value.name = origin.name;
    }
  }
  if (
    typeof value.item === "object" &&
    value.item &&
    (value.type === "response.output_item.added" ||
      value.type === "response.output_item.done")
  ) {
    if (isImageGenerationItem(value.item))
      value.item = absorbGeneratedImage(value.item, state);
    else rewriteResponseItem(value.item, map, state);
  }
  return value;
}

// Progress events for a tool Codex does not know about carry nothing it can
// use, and an unfamiliar event type is a risk to its parser. The item that
// actually holds the image is kept and rewritten; the chatter around it is not.
const OPAQUE_EVENT_PREFIXES = ["response.image_generation_call."];

function isOpaqueEvent(lines) {
  return lines.some(
    (line) =>
      line.startsWith("event:") &&
      OPAQUE_EVENT_PREFIXES.some((prefix) =>
        line.slice(6).trim().startsWith(prefix),
      ),
  );
}

export function rewriteSseBlock(block, map, state = { callIds: new Map(), itemIds: new Map() }) {
  const lines = block.split("\n");
  if (isOpaqueEvent(lines)) return null;
  // An image_generation_call announced before its bytes exist has nothing to
  // save yet; the matching .done block carries the result.
  if (
    lines.some((line) => line.startsWith("event: response.output_item.added")) &&
    lines.some((line) => line.includes('"type":"image_generation_call"'))
  )
    return null;
  return lines
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return line;
      try {
        const value = JSON.parse(payload);
        rewriteResponseEvent(value, map, state);
        return `data: ${JSON.stringify(value)}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

export function createSseRewriter(map, options = {}) {
  const state = {
    callIds: new Map(),
    itemIds: new Map(),
    savedImages: new Map(),
    imageOptions: options.imageOptions,
    cacheUsage: null,
  };
  const rewrite = (block) => rewriteSseBlock(block, map, state);
  Object.defineProperty(rewrite, "cacheUsage", {
    get() {
      return state.cacheUsage;
    },
  });
  return rewrite;
}
