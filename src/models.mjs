export const DEFAULT_GROK_MODEL = "grok-4.6";
export const GROK_PROVIDER = "grok_build_cli";

export function isGrokModel(model) {
  return typeof model === "string" && model.startsWith("grok-");
}

export function resolveGrokModel(model) {
  return isGrokModel(model) ? model : DEFAULT_GROK_MODEL;
}

export function grokDisplayName(id) {
  return `Grok ${String(id).slice("grok-".length)}`;
}

export function extraGrokModels(env = process.env) {
  const raw = env.GROK_BRIDGE_MODELS ?? "";
  const seen = new Set();
  const ids = [];
  for (const part of raw.split(/[,\s]+/)) {
    const id = part.trim();
    if (!isGrokModel(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function catalogModelIds(env = process.env) {
  const ids = [DEFAULT_GROK_MODEL];
  const seen = new Set(ids);
  for (const id of extraGrokModels(env)) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function parseGrokCliModels(text) {
  const ids = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*[*+-]\s+(grok-[^\s(]+)/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    ids.push(match[1]);
  }
  return ids;
}

export function modelEntry(id = DEFAULT_GROK_MODEL) {
  const label = grokDisplayName(id);
  return {
    id,
    model: id,
    displayName: `${label} / xAI`,
    description: `${label} · Codex tools`,
    hidden: false,
    isDefault: false,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map(
      (reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }),
    ),
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
  };
}

export function modelInfo(id = DEFAULT_GROK_MODEL) {
  const label = grokDisplayName(id);
  return {
    slug: id,
    display_name: `${label} / xAI`,
    description: `${label} via grok login; Codex executes tools`,
    default_reasoning_level: "high",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(
      (effort) => ({ effort, description: effort }),
    ),
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 50,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    context_window: 500000,
    input_modalities: ["text", "image"],
    tool_mode: "direct",
    node_repl_disabled: true,
    model_messages: {
      instructions_template:
        `You are ${label} by xAI, running as the Codex model. Use the tools provided by Codex and respect its permissions. Complete the user request accurately.`,
    },
  };
}

export const MODEL_ENTRY = modelEntry();
export const MODEL_INFO = modelInfo();

export function catalogModelEntries(env = process.env) {
  return catalogModelIds(env).map((id) =>
    id === DEFAULT_GROK_MODEL ? MODEL_ENTRY : modelEntry(id),
  );
}

export function catalogModelInfos(env = process.env) {
  return catalogModelIds(env).map((id) =>
    id === DEFAULT_GROK_MODEL ? MODEL_INFO : modelInfo(id),
  );
}
