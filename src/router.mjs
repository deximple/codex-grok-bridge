import { isDeepStrictEqual } from "node:util";
import { catalogModelEntries, isGrokModel, MODEL_ENTRY } from "./models.mjs";

export { MODEL_ENTRY };

export class Router {
  constructor(catalogPath) {
    this.catalogPath = catalogPath;
    this.pending = new Map();
    this.threads = new Map();
    this.unstarted = new Map();
  }
  applyGrokProvider(params) {
    params.modelProvider = "grok_build_cli";
    params.config = {
      ...params.config,
      model_catalog_json: this.catalogPath,
      model_provider: "grok_build_cli",
    };
    return params;
  }
  async prepare(message, rpc) {
    const p = message.params ?? {};
    const selected = p.collaborationMode?.settings?.model ?? p.model;
    const settings = ["thread/settings/update", "turn/settings/update"].includes(message.method);
    if (!p.threadId || (message.method !== "turn/start" && !(settings && selected))) return;
    const fresh = this.unstarted.get(p.threadId);
    const snapshot = fresh ?? await rpc("thread/resume", { threadId: p.threadId, excludeTurns: true });
    const model = selected ?? snapshot.model;
    const provider = isGrokModel(model)
      ? "grok_build_cli"
      : model?.startsWith("gpt-") && snapshot.modelProvider === "grok_build_cli"
        ? "openai" : snapshot.modelProvider;
    if (provider === snapshot.modelProvider) return;
    if (fresh) throw new Error("Save the first turn before switching providers, or start a new thread with the desired model.");
    if (snapshot.thread.status?.type !== "idle" || snapshot.thread.ephemeral || snapshot.thread.parentThreadId)
      throw new Error("Model provider switching requires an idle, saved root thread. Finish the active turn before switching.");
    await rpc("thread/unsubscribe", { threadId: p.threadId });
    const resumed = await rpc("thread/resume", {
      threadId: p.threadId, model, modelProvider: provider, excludeTurns: true,
      cwd: snapshot.cwd, approvalPolicy: snapshot.approvalPolicy,
      approvalsReviewer: snapshot.approvalsReviewer, serviceTier: snapshot.serviceTier,
      ...(snapshot.path != null ? { path: snapshot.path } : {}),
      config: {
        ...(provider === "grok_build_cli" ? { model_catalog_json: this.catalogPath } : {}),
        ...(snapshot.reasoningEffort != null ? { model_reasoning_effort: snapshot.reasoningEffort } : {}),
      },
    });
    if (resumed.thread.id !== p.threadId || resumed.modelProvider !== provider || resumed.model !== model)
      throw new Error("Model provider did not switch. Close other views of this thread and retry; no inference was sent.");
    if (!["approvalPolicy", "approvalsReviewer", "sandbox"].every((key) => isDeepStrictEqual(resumed[key], snapshot[key])))
      throw new Error("Thread permissions changed during provider switching; no inference was sent.");
  }
  outgoing(message) {
    const msg = structuredClone(message),
      p = msg.params ?? {};
    const model = p.collaborationMode?.settings?.model ?? p.model;
    const grok = isGrokModel(model);
    if (
      ["thread/start", "thread/resume", "thread/fork"].includes(
        msg.method,
      ) &&
      grok
    ) {
      msg.params = this.applyGrokProvider(p);
      if (p.threadId) this.threads.set(p.threadId, "grok_build_cli");
    }
    if (msg.id !== undefined && msg.method)
      this.pending.set(msg.id, { method: msg.method, params: msg.params ?? p });
    return msg;
  }
  incoming(message) {
    const msg = structuredClone(message),
      request = this.pending.get(msg.id);
    if (["turn/completed", "thread/closed"].includes(msg.method)) this.unstarted.delete(msg.params?.threadId);
    if (!request) return msg;
    this.pending.delete(msg.id);
    if (request.method === "thread/start" && msg.result?.thread?.id)
      this.unstarted.set(msg.result.thread.id, structuredClone(msg.result));
    if (request.method === "model/list" && Array.isArray(msg.result?.data)) {
      for (const entry of catalogModelEntries()) {
        if (!msg.result.data.some((m) => m.id === entry.id))
          msg.result.data.push(entry);
      }
    }
    if (
      ["thread/start", "thread/resume", "thread/fork"].includes(
        request.method,
      ) &&
      msg.result?.thread?.id
    ) {
      this.threads.set(
        msg.result.thread.id,
        msg.result.modelProvider ??
          msg.result.thread.modelProvider ??
          request.params.modelProvider ??
          "openai",
      );
    }
    return msg;
  }
}
