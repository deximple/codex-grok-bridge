import assert from "node:assert/strict";
import test from "node:test";

import { createSlots } from "../src/slots.mjs";

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("hands out up to the limit immediately", async () => {
  const slots = createSlots({ limit: 2 });
  await slots.acquire();
  await slots.acquire();
  assert.equal(slots.inFlight, 2);
  assert.equal(slots.queued, 0);
});

test("the overflow waits and is served in order as slots free", async () => {
  const slots = createSlots({ limit: 1, queueLimit: 4 });
  await slots.acquire();

  const order = [];
  const second = slots.acquire().then(() => order.push("second"));
  const third = slots.acquire().then(() => order.push("third"));
  await settled();
  assert.deepEqual(order, [], "nothing may run while the only slot is held");
  assert.equal(slots.queued, 2);

  slots.release();
  await second;
  assert.deepEqual(order, ["second"]);
  assert.equal(slots.inFlight, 1, "the slot transfers rather than being freed");

  slots.release();
  await third;
  assert.deepEqual(order, ["second", "third"]);

  slots.release();
  assert.equal(slots.inFlight, 0);
  assert.equal(slots.queued, 0);
});

test("isFull is true only when the queue is also full", async () => {
  const slots = createSlots({ limit: 1, queueLimit: 1 });
  await slots.acquire();
  assert.equal(slots.isFull(), false, "a free queue slot means we can still wait");
  const queued = slots.acquire();
  await settled();
  assert.equal(slots.isFull(), true);
  slots.release();
  await queued;
  assert.equal(slots.isFull(), false);
});

test("a queued caller that goes away releases its place", async () => {
  const slots = createSlots({ limit: 1, queueLimit: 4 });
  await slots.acquire();
  const controller = new AbortController();
  const queued = slots.acquire(controller.signal);
  await settled();
  assert.equal(slots.queued, 1);

  controller.abort();
  await assert.rejects(queued, (error) => error.name === "AbortError");
  assert.equal(slots.queued, 0, "an abandoned waiter must not hold the queue");

  // The still-held slot is unaffected and can be released normally.
  slots.release();
  assert.equal(slots.inFlight, 0);
});

test("an already-aborted caller never takes a slot", async () => {
  const slots = createSlots({ limit: 2 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => slots.acquire(controller.signal), (error) => error.name === "AbortError");
  assert.equal(slots.inFlight, 0);
});

test("releasing more than was acquired cannot drive the count negative", () => {
  const slots = createSlots({ limit: 1 });
  slots.release();
  slots.release();
  assert.equal(slots.inFlight, 0);
});
