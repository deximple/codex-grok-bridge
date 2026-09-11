import {
  GROK_IMAGE_TOOL,
  describeGeneratedImage,
  isImageGenerationItem,
  saveGeneratedImage,
} from "./imagegen.mjs";

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

const WEB_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query" },
  },
  required: ["query"],
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
// opaque - that field is stripped by the key filter below.
const PROVIDER_OPAQUE_TYPES = new Set([
  "compaction",
  "compaction_summary",
  "context_compaction",
  "encrypted_content",
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
    if (Array.isArray(fragment.required)) {
      required =
        required === undefined
          ? fragment.required.slice()
          : required.filter((key) => fragment.required.includes(key));
    }
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
  let required = merged.required;
  if (Array.isArray(parameters.required)) {
    required =
      required === undefined
        ? parameters.required.slice()
        : required.filter((key) => parameters.required.includes(key));
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

function addFunction(flattened, map, spec) {
  const proxyName = `codex_${flattened.length}_${sanitize(spec.name)}`;
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
    parameters:
      spec.kind === "custom"
        ? structuredClone(CUSTOM_INPUT_SCHEMA)
        : usableParameters(spec.parameters),
  });
}

export function flattenCodexTools(tools = []) {
  const flattened = [];
  const map = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
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
    if (tool.type === "web_search") {
      addFunction(flattened, map, {
        kind: "web_search",
        namespace: null,
        name: "web_search",
        description: tool.description || "Search the web",
        parameters: tool.parameters || WEB_SEARCH_SCHEMA,
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
    flattened.push(structuredClone(tool));
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

function toProxyInputNode(node, map, state) {
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

  if (next.type === "reasoning") {
    // Forward the summary and nothing else. Codex's own item id and null
    // content fields mean nothing to the upstream and only widen the surface
    // for a schema rejection.
    const summary = (Array.isArray(next.summary) ? next.summary : []).filter(
      (part) => part && typeof part.text === "string" && part.text.trim(),
    );
    if (!summary.length) return DROP;
    return whitelistInputNode({ type: "reasoning", summary });
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

  return whitelistInputNode(next);
}

function toProxyInput(input, map) {
  const items = toProxyInputNode(input, map, { callIds: new Map() });
  if (!Array.isArray(items)) return items;
  return items.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      (item.type == null || GROK_INPUT_ITEM_TYPES.has(item.type)),
  );
}

// Only the bridge knows a request is being served by the bridge. Codex does not
// put the provider or model into the prompt, so without this line the model has
// no way to answer "is Grok actually attached?" and either hedges or goes
// hunting through config files. Stated once, in the instructions, it costs a
// few tokens and removes the whole class of question.
export const TRANSPORT_PROVENANCE =
  "Transport: this request is served by the local Codex-Grok bridge — model " +
  "grok-4.6 via the grok_build_cli provider, with Codex owning tools, history " +
  "and permissions. If asked whether Grok is attached to the Codex harness, " +
  "this line is the authoritative answer and no tool call is needed to confirm it.";

// Codex still injects its imagegen skill. That skill's fallback is OpenAI
// (`image_gen` or a Python CLI). The model will read the skill and send the
// picture to another vendor unless this line says not to. Grok already has
// image_generation on the request; no Codex tool call is required to pick it.
export const IMAGE_GENERATION_PROVENANCE =
  "Images: pictures on this transport are generated by Grok's image_generation " +
  "tool, which is already on the request. Do not read Codex's imagegen skill " +
  "and do not use OpenAI, image_gen, or a Python image CLI — those send the " +
  "picture to another vendor.";

export function toProxyRequest(body) {
  const { tools, map } = flattenCodexTools(body.tools ?? []);
  const effort = EFFORT[body.reasoning?.effort] ?? "high";
  const request = {
    model: "grok-4.6",
    input: toProxyInput(body.input, map),
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
  if (tools.length) {
    request.tool_choice = proxyToolChoice(body.tool_choice, map);
    request.parallel_tool_calls = body.parallel_tool_calls !== false;
  }
  const provenance = imageGenOn
    ? `${TRANSPORT_PROVENANCE}\n\n${IMAGE_GENERATION_PROVENANCE}`
    : TRANSPORT_PROVENANCE;
  request.instructions =
    typeof body.instructions === "string" && body.instructions
      ? `${body.instructions}\n\n${provenance}`
      : provenance;
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key)
    request.prompt_cache_key = body.prompt_cache_key;
  return { request, map };
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

function rewriteResponseItem(node, map, state) {
  if (!node || typeof node !== "object") return;
  if (typeof node.name === "string" && map.has(node.name)) {
    const origin = map.get(node.name);
    rememberProxyItem(node, origin, state);
    restoreOriginName(node, origin);
    if (origin.kind === "custom") {
      if (node.type === "function_call") node.type = "custom_tool_call";
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
  const saved = saveGeneratedImage(item, state.imageOptions);
  return {
    type: "message",
    id: typeof item.id === "string" ? item.id : undefined,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: describeGeneratedImage(item, saved) }],
  };
}

function rewriteResponseEvent(value, map, state) {
  if (!value || typeof value !== "object") return value;
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
    imageOptions: options.imageOptions,
  };
  return (block) => rewriteSseBlock(block, map, state);
}
