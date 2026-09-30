import http from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { GrokAuthError, readGrokBearerToken } from "./auth.mjs";
import { sanitizeImages, toImageBlocks } from "./images.mjs";
import {
  buildGrokInvocation,
  decodeOutput,
  parseGrokResult,
  runGrok,
} from "./cli-inference.mjs";
import { relayProxySse } from "./proxy.mjs";
import {
  applyCacheUsage,
  createPrefixMemory,
  readCacheUsage,
  stableConvId,
} from "./prefix.mjs";
import { toProxyRequest } from "./tools.mjs";
import { classifyBridgeError, errorSignature, bridgeErrorMessage } from "./errors.mjs";
import { createDiagnostics } from "./diagnostics.mjs";
import { createSlots } from "./slots.mjs";
import { catalogModelInfos, isGrokModel, MODEL_INFO } from "./models.mjs";

export { MODEL_INFO };

export function publicBridgeError(error, context = {}) {
  if (error instanceof GrokAuthError) return error.message;
  const message = String(error?.message ?? "");
  // Upstream status errors and CLI exit codes already carry an accurate,
  // redacted message; passing them through keeps their status code visible.
  if (/^Grok Build CLI exited with code \d+$/.test(message)) return message;
  if (/^Grok (login|Responses proxy)/.test(message)) return message;
  const kind = classifyBridgeError(error, context);
  return bridgeErrorMessage(kind, context.detail);
}

export function createBridgeServer(options = {}) {
  if (!options.token) throw new Error("A bridge token is required");
  const diagnostics = options.diagnostics ?? createDiagnostics(options.diagnosticsOptions);
  const token = Buffer.from(`Bearer ${options.token}`);
  const slots = createSlots({
    limit: options.maxConcurrentInference,
    queueLimit: options.maxQueuedInference,
  });
  const prefixes = createPrefixMemory();
  return http.createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const route = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method === "GET" && route === "/v1/models")
      return json(200, { models: catalogModelInfos() });
    if (req.method !== "POST" || route !== "/v1/responses")
      return json(404, { error: "Not found" });
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== token.length || !timingSafeEqual(auth, token))
      return json(401, { error: "Unauthorized" });
    if (req.headers.origin)
      return json(403, { error: "Browser requests are not accepted" });
    let body;
    let requestBytes = 0;
    try {
      // Collect buffers and decode once. Concatenating into a string as chunks
      // arrive doubles the payload in memory as UTF-16 and reallocates on every
      // chunk, which matters now that a request can carry 20 MiB of images.
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (options.maxBodyBytes ?? 40 * 1024 * 1024)) {
          json(413, { error: "Request too large" });
          return;
        }
        chunks.push(chunk);
      }
      requestBytes = size;
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isGrokModel(body?.model) || !Array.isArray(body.input))
        throw new Error();
    } catch {
      return json(400, { error: "Invalid request" });
    }
    // Refuse only when even the queue is full; anything else waits for a slot.
    // The check must sit after the body read, not before it: an `await` between
    // the check and the claim lets concurrent requests all past it.
    if (slots.isFull())
      return json(429, { error: "Grok is busy; retry after this turn" });
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    // writeHead() alone leaves the status line buffered until the first body
    // write, so a slow upstream leaves the client on a wholly silent socket.
    res.flushHeaders();
    const event = (type, data) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    const id = "resp_" + randomUUID();
    const startedAt = Date.now();
    // A keepalive comment is an SSE byte. Writing one before the reply finishes
    // would make a later upstream reset unsafe to retry, so the proxy path
    // stays quiet until the first real event is handed to Codex. The CLI path
    // writes its own events and may keep the socket warm while it runs.
    let responseStarted = false;
    const keepalive = setInterval(() => {
      if (!responseStarted || res.destroyed || res.writableEnded) return;
      res.write(": keepalive\n\n");
    }, 10000);
    const useCli =
      Boolean(options.runGrok) ||
      options.inferenceMode === "cli" ||
      process.env.GROK_BRIDGE_INFERENCE === "cli";
    // Shape of the turn, for the diagnostic record. Structural counts only:
    // never prompt text, tool output, or anything that could carry a secret.
    const shape = {
      mode: useCli ? "cli" : "proxy",
      requestBytes,
      items: Array.isArray(body.input) ? body.input.length : 0,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
    };
    const queuedAt = Date.now();
    let acquired = false;
    let queuedMs = 0;
    let cacheUsage = null;
    try {
      await slots.acquire(controller.signal);
      acquired = true;
      queuedMs = Date.now() - queuedAt;
      if (useCli) {
        responseStarted = true;
        event("response.created", { response: { id } });
        const invocation = buildGrokInvocation(body, options);
        invocation.threadId = req.headers["thread-id"];
        const result = await (options.runGrok ?? runGrok)(
          invocation,
          controller.signal,
        );
        if (result.exitCode !== 0)
          throw new Error(
            `Grok Build CLI exited with code ${Number(result.exitCode) || 1}`,
          );
        const parsed = parseGrokResult(result.stdout);
        const items = decodeOutput(parsed, body.tools, body.tool_choice);
        for (const item of items) event("response.output_item.done", { item });
        const inputTokens =
            parsed.usage?.input_tokens ?? parsed.usage?.inputTokens ?? 0,
          outputTokens =
            parsed.usage?.output_tokens ?? parsed.usage?.outputTokens ?? 0;
        const usage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        };
        cacheUsage = readCacheUsage(parsed.usage);
        if (cacheUsage) Object.assign(usage, cacheUsage);
        applyCacheUsage(usage);
        event("response.completed", {
          response: {
            id,
            usage,
          },
        });
      } else {
        const session = readGrokBearerToken(options.grokHome);
        // Grok takes input_image blocks natively; only unusable attachments
        // are swapped for an explanation, so one bad image cannot make the
        // upstream reject the whole conversation.
        const threadId = req.headers["thread-id"];
        const convId = stableConvId(
          Array.isArray(threadId) ? threadId[0] : threadId,
          body.prompt_cache_key,
        );
        const { request, map, projected } = toProxyRequest(sanitizeImages(body));
        if (convId) request.prompt_cache_key = convId;
        request.input = prefixes.reuse(convId, projected);
        const usageBox = {};
        try {
          await relayProxySse(
            {
              token: session.token,
              userId: session.userId,
              body: request,
              signal: controller.signal,
              fetchImpl: options.proxyFetch,
              baseUrl: options.proxyBaseUrl,
              convId,
              sessionId: Array.isArray(threadId) ? threadId[0] : threadId,
              onClientByte: () => {
                responseStarted = true;
              },
              onRetry: ({ attempt, kind }) =>
                diagnostics.record({
                  event: "turn_retried",
                  kind,
                  attempt,
                  elapsedMs: Date.now() - startedAt,
                }),
            },
            res,
            map,
            usageBox,
          );
        } finally {
          cacheUsage = usageBox.cacheUsage ?? null;
        }
      }
      diagnostics.record({
        event: "turn_ok",
        ...shape,
        ...(cacheUsage ?? {}),
        queuedMs,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      const kind = classifyBridgeError(error);
      diagnostics.record({
        event: "turn_failed",
        kind,
        signature: errorSignature(error),
        ...shape,
        ...(cacheUsage ?? {}),
        queuedMs,
        elapsedMs: Date.now() - startedAt,
        detail: error?.message,
      });
      if (!res.writableEnded && !res.destroyed) {
        try {
          event("response.failed", {
            response: {
              id,
              error: {
                code: `bridge_${kind}`,
                message: publicBridgeError(error),
              },
            },
          });
        } catch {
          // SSE already closed; Codex will see the disconnect without this event.
        }
      }
    } finally {
      clearInterval(keepalive);
      if (acquired) slots.release();
      res.end();
    }
  });
}
