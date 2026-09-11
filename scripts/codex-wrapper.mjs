#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { startRuntime } from "../src/runtime.mjs";
import { Router } from "../src/router.mjs";
import { resolveCodexBinary } from "../src/paths.mjs";

const binary = resolveCodexBinary();
const args = process.argv.slice(2);
if (!args.includes("app-server")) {
  const child = spawn(binary, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const runtime = await startRuntime();
  const router = new Router(runtime.catalogPath);
  const child = spawn(binary, [...args, ...runtime.args], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, CODEX_GROK_BRIDGE_TOKEN: runtime.token },
  });
  const send = (message) =>
    process.stdout.write(JSON.stringify(message) + "\n");
  const pending = new Map();
  const timedOut = new Set();
  const queues = new Map();
  const write = (message) => child.stdin.write(JSON.stringify(router.outgoing(message)) + "\n");
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `grok-bridge-${randomUUID()}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      router.pending.delete(id);
      timedOut.add(id);
      reject(new Error(`Provider transition timed out: ${method}`));
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    });
    write({ id, method, params });
  });
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("Grok wrapper: invalid client message\n");
      return;
    }
    const threadId = message.method && message.params?.threadId;
    if (!threadId) {
      try {
        write(message);
      } catch {
        process.stderr.write("Grok wrapper: app-server is not writable\n");
        if (message.id !== undefined)
          send({ id: message.id, error: { code: -32603, message: "app-server is not writable" } });
      }
      return;
    }
    const next = (queues.get(threadId) ?? Promise.resolve())
      .then(async () => {
        await router.prepare(message, rpc);
        write(message);
      })
      .catch((error) => {
        if (message.id !== undefined)
          send({ id: message.id, error: { code: -32600, message: error.message } });
      })
      .finally(() => {
        if (queues.get(threadId) === next) queues.delete(threadId);
      });
    queues.set(threadId, next);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = router.incoming(JSON.parse(line));
      if (!message.method && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (!message.method && timedOut.delete(message.id)) {
        process.stderr.write("Grok wrapper: dropped late internal reply\n");
      } else send(message);
    } catch {
      process.stderr.write("Grok wrapper: invalid app-server message\n");
    }
  });
  input.on("close", () => child.stdin.end());
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => child.kill(signal));
  child.on("error", () =>
    process.stderr.write("Could not start bundled Codex\n"),
  );
  child.on("close", async (code) => {
    input.close();
    await runtime.close();
    process.exit(code ?? 1);
  });
}
