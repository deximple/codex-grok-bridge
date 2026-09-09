import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { Readable } from "node:stream";

// Node's global fetch gives no control over DNS or connection reuse: its
// dispatcher lives in undici, which is neither a built-in module here nor a
// dependency this package carries. node:http(s) gives both through an Agent.
//
// Why it matters: between two inference calls Codex runs tools for 5-20s. If
// the pooled socket is gone by then the next call needs a fresh connection and
// therefore a fresh DNS lookup, and a stalled macOS resolver fails that lookup
// on a fixed schedule rather than quickly.

export const DNS_TTL_MS = 300_000;
export const KEEP_ALIVE_MS = 30_000;
export const MAX_SOCKETS = 4;
export const SOCKET_TIMEOUT_MS = 120_000;

const dnsCache = new Map();

export function clearDnsCache() {
  dnsCache.clear();
}

/**
 * dns.lookup with a short-lived cache, in the shape http.Agent expects.
 * A failed lookup falls back to a still-known address rather than failing the
 * turn, because a resolver hiccup is not a reason to lose a conversation.
 */
export function cachedLookup(hostname, options, callback) {
  const resolve = typeof options === "function" ? options : callback;
  const settings = typeof options === "function" ? {} : (options ?? {});
  const key = `${hostname}:${settings.family ?? 0}`;
  const cached = dnsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    process.nextTick(() => resolve(null, cached.address, cached.family));
    return;
  }
  dns.lookup(hostname, settings, (error, address, family) => {
    if (!error) {
      dnsCache.set(key, { address, family, expiresAt: Date.now() + DNS_TTL_MS });
      resolve(null, address, family);
      return;
    }
    if (cached) {
      resolve(null, cached.address, cached.family);
      return;
    }
    resolve(error);
  });
}

const agents = new Map();

export function proxyAgent(protocol) {
  const secure = protocol !== "http:";
  const existing = agents.get(secure);
  if (existing) return existing;
  const Agent = secure ? https.Agent : http.Agent;
  const agent = new Agent({
    keepAlive: true,
    keepAliveMsecs: KEEP_ALIVE_MS,
    maxSockets: MAX_SOCKETS,
    timeout: SOCKET_TIMEOUT_MS,
    lookup: cachedLookup,
  });
  agents.set(secure, agent);
  return agent;
}

export function destroyAgents() {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}

/**
 * A fetch-shaped request over node:http(s). Returns a real Response so callers
 * keep `ok`, `status`, `text()` and a web ReadableStream body unchanged.
 */
export function requestStream(url, init = {}) {
  const target = new URL(url);
  const client = target.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        agent: proxyAgent(target.protocol),
        signal: init.signal,
      },
      (response) => {
        const headers = {};
        const contentType = response.headers["content-type"];
        if (contentType) headers["content-type"] = contentType;
        resolve(
          new Response(Readable.toWeb(response), {
            status: response.statusCode,
            headers,
          }),
        );
      },
    );
    request.once("error", reject);
    if (init.body === undefined || init.body === null) request.end();
    else request.end(init.body);
  });
}
