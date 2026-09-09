// A bounded concurrency gate for upstream inference.
//
// The bridge used to allow exactly one inference at a time. That is stricter
// than the upstream needs — six concurrent requests on one login session all
// complete in about two seconds — and it breaks Codex subagents: a child
// agent's inference arrives while the parent turn still holds the slot, and the
// child dies on the 429 instead of waiting its turn.
//
// So: allow a few in flight, make the rest wait, and refuse only when even the
// queue is full. Waiting costs a client nothing — the bridge has already sent
// its response headers and keeps the stream alive with comments — while a 429
// costs it the whole turn.

export const DEFAULT_LIMIT = 4;
export const DEFAULT_QUEUE_LIMIT = 8;

function abortError() {
  return Object.assign(new Error("The request was aborted while queued"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

export function createSlots(options = {}) {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const queueLimit = Math.max(0, options.queueLimit ?? DEFAULT_QUEUE_LIMIT);
  let inFlight = 0;
  const waiting = [];

  return {
    get limit() {
      return limit;
    },
    get inFlight() {
      return inFlight;
    },
    get queued() {
      return waiting.length;
    },
    /** True only when a caller would have to wait behind a full queue. */
    isFull() {
      return inFlight >= limit && waiting.length >= queueLimit;
    },
    async acquire(signal) {
      if (signal?.aborted) throw abortError();
      if (inFlight < limit) {
        inFlight += 1;
        return;
      }
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        waiting.push(entry);
        signal?.addEventListener(
          "abort",
          () => {
            const index = waiting.indexOf(entry);
            if (index === -1) return; // already handed a slot
            waiting.splice(index, 1);
            reject(abortError());
          },
          { once: true },
        );
      });
      // release() hands the slot over directly, so inFlight already counts it.
    },
    release() {
      const next = waiting.shift();
      if (next) next.resolve();
      else inFlight = Math.max(0, inFlight - 1);
    },
  };
}
