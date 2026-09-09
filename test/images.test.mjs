import test from "node:test";
import assert from "node:assert/strict";
import { toImageBlocks, MAX_IMAGE_BYTES } from "../src/images.mjs";
import { createBridgeServer, MODEL_INFO } from "../src/bridge.mjs";
import { MODEL_ENTRY } from "../src/router.mjs";
import { once } from "node:events";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=";
const data = "data:image/png;base64," + png;
const body = (url) => ({
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: "Describe this" },
        { type: "input_image", image_url: url },
      ],
    },
  ],
});
test("converts images to ACP blocks without modifying history or duplicating bytes", () => {
  const original = body(data);
  const { request, images } = toImageBlocks(original);
  assert.equal(images[0].type, "image");
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(images[0].data, png);
  assert.equal(original.input[0].content[1].image_url, data);
  assert.ok(!JSON.stringify(request).includes(png));
  assert.match(JSON.stringify(request), /image_1/);
});
test("deduplicates repeated images and preserves their association with turns", () => {
  const original = { input: [...body(data).input, ...body(data).input] };
  const result = toImageBlocks(original);
  assert.equal(result.images.length, 1);
  assert.match(JSON.stringify(result.request.input[0]), /image_1/);
  assert.match(JSON.stringify(result.request.input[1]), /image_1/);
});
test("rejects URLs, invalid base64, MIME mismatch and excessive size", () => {
  for (const url of [
    "https://example.com/image.png",
    "file:///secret",
    "data:image/svg+xml;base64,AAAA",
    "data:image/png;base64,!!!",
    "data:image/jpeg;base64," + png,
    "data:image/png;base64," +
      Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64"),
  ])
    assert.throws(() => toImageBlocks(body(url)));
});
test("handles image tool results and leaves text-only requests unchanged", () => {
  const request = {
    input: [
      { type: "function_call_output", output: body(data).input[0].content },
    ],
  };
  assert.equal(toImageBlocks(request).images.length, 1);
  assert.deepEqual(toImageBlocks({ input: [] }), {
    request: { input: [] },
    images: [],
  });
});
test("HTTP accepts inline images and rejects remote URLs before inference", async () => {
  let called = 0;
  const server = createBridgeServer({
    token: "test",
    runGrok: async (invocation) => {
      called++;
      assert.equal(toImageBlocks(invocation.body).images.length, 1);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          text: "",
          structured_output: { text: "Seen", calls: [] },
        }),
      };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const send = (url) =>
      fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer test" },
        body: JSON.stringify({ model: "grok-4.6", ...body(url) }),
      });
    const good = await send(data);
    assert.equal(good.status, 200);
    assert.match(await good.text(), /response.completed/);
    const bad = await send("https://example.com/image.png");
    assert.equal(bad.status, 400);
    assert.equal(called, 1);
    assert.ok(MODEL_INFO.input_modalities.includes("image"));
    assert.ok(MODEL_ENTRY.inputModalities.includes("image"));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("enforces image count limit", () => {
  const input = [];
  for (let i = 0; i < 5; i++) {
    const b = Buffer.from(png, "base64");
    b[b.length - 1] = i;
    input.push(...body("data:image/png;base64," + b.toString("base64")).input);
  }
  assert.throws(() => toImageBlocks({ input }), /At most 4/);
});
