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

function usableParameters(parameters) {
  if (!parameters || typeof parameters !== "object") return OBJECT_SCHEMA;
  if (
    parameters.type === "object" ||
    Array.isArray(parameters.oneOf) ||
    Array.isArray(parameters.anyOf)
  )
    return parameters;
  return OBJECT_SCHEMA;
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
      key === "internal_chat_message_metadata_passthrough"
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
    return { type: "reasoning", summary };
  }

  if (next.type === "agent_message") {
    const content = Array.isArray(next.content)
      ? next.content
      : typeof next.text === "string" && next.text
        ? [{ type: "input_text", text: next.text }]
        : [];
    if (!content.length) return DROP;
    return { type: "message", role: "assistant", content };
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
    return next;
  }

  if (
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
    return next;
  }

  if (
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
    return next;
  }

  return next;
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
  if (tools.length) {
    request.tool_choice = proxyToolChoice(body.tool_choice, map);
    request.parallel_tool_calls = body.parallel_tool_calls !== false;
  }
  request.instructions =
    typeof body.instructions === "string" && body.instructions
      ? `${body.instructions}\n\n${TRANSPORT_PROVENANCE}`
      : TRANSPORT_PROVENANCE;
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

function rewriteResponseEvent(value, map, state) {
  if (!value || typeof value !== "object") return value;
  if (
    typeof value.item === "object" &&
    value.item &&
    (value.type === "response.output_item.added" ||
      value.type === "response.output_item.done")
  ) {
    rewriteResponseItem(value.item, map, state);
  }
  return value;
}

export function rewriteSseBlock(block, map, state = { callIds: new Map(), itemIds: new Map() }) {
  const lines = block.split("\n");
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

export function createSseRewriter(map) {
  const state = { callIds: new Map(), itemIds: new Map() };
  return (block) => rewriteSseBlock(block, map, state);
}
