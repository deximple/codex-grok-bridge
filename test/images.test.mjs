import test from "node:test";
import assert from "node:assert/strict";
import { toImageBlocks, MAX_IMAGE_BYTES, MAX_IMAGES } from "../src/images.mjs";
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
test("an attachment the upstream cannot take is explained, not fatal", () => {
  const cases = [
    ["https://example.com/image.png", /remote URLs are never fetched/],
    ["file:///secret", /remote URLs are never fetched/],
    ["data:image/svg+xml;base64,AAAA", /only inline PNG, JPEG and WebP/],
    ["data:image/png;base64,!!!", /only inline PNG, JPEG and WebP/],
    ["data:image/jpeg;base64," + png, /do not match the declared image\/jpeg/],
    [
      "data:image/png;base64," + Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64"),
      /over the 10\.0 MiB limit for one image/,
    ],
  ];
  for (const [url, expected] of cases) {
    const { request, images } = toImageBlocks(body(url));
    assert.equal(images.length, 0, `${url.slice(0, 40)} must send no pixels`);
    const text = request.input[0].content[1].text;
    assert.match(text, /was not sent to the model/);
    assert.match(text, expected);
  }
});

test("one bad attachment does not poison the rest of the conversation", () => {
  // toImageBlocks walks the whole history, so an oversized image in an early
  // turn used to fail every later turn in that thread, forever.
  const oversized =
    "data:image/png;base64," +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(MAX_IMAGE_BYTES + 1),
    ]).toString("base64");
  const { request, images } = toImageBlocks({
    input: [
      ...body(oversized).input,
      { role: "assistant", content: [{ type: "output_text", text: "..." }] },
      ...body(data).input,
    ],
  });
  assert.equal(images.length, 1, "the usable image must still be sent");
  assert.match(request.input[0].content[1].text, /over the 10\.0 MiB limit/);
  assert.match(request.input[2].content[1].text, /Attached visual image_1/);
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
test("HTTP sends inline images and explains remote URLs instead of failing", async () => {
  let called = 0;
  const server = createBridgeServer({
    token: "test",
    runGrok: async (invocation) => {
      called++;
      assert.equal(toImageBlocks(invocation.body).images.length, called === 1 ? 1 : 0);
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
    // A remote URL is not fetched, but it must not fail the turn either.
    const bad = await send("https://example.com/image.png");
    assert.equal(bad.status, 200);
    assert.equal(called, 2);
    assert.ok(MODEL_INFO.input_modalities.includes("image"));
    assert.ok(MODEL_ENTRY.inputModalities.includes("image"));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("images past the per-request limit are explained, and the first four still go", () => {
  const input = [];
  for (let i = 0; i < 5; i++) {
    const bytes = Buffer.from(png, "base64");
    bytes[bytes.length - 1] = i;
    input.push(...body("data:image/png;base64," + bytes.toString("base64")).input);
  }
  const { request, images } = toImageBlocks({ input });
  assert.equal(images.length, MAX_IMAGES);
  assert.match(request.input[3].content[1].text, /Attached visual image_4/);
  assert.match(request.input[4].content[1].text, /at most 4 distinct images/);
});

test("accepts WebP and rejects bytes that only claim to be WebP", () => {
  const webp = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WEBP", "ascii"),
    Buffer.alloc(20),
  ]);
  const good = toImageBlocks(
    body("data:image/webp;base64," + webp.toString("base64")),
  );
  assert.equal(good.images.length, 1);
  assert.equal(good.images[0].mimeType, "image/webp");

  const liar = Buffer.concat([Buffer.from("RIFX", "ascii"), Buffer.alloc(24)]);
  const bad = toImageBlocks(
    body("data:image/webp;base64," + liar.toString("base64")),
  );
  assert.equal(bad.images.length, 0);
  assert.match(
    bad.request.input[0].content[1].text,
    /do not match the declared image\/webp/,
  );
});

test("a PNG larger than 32 megapixels is explained rather than forwarded", () => {
  const header = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(25),
  ]);
  header.writeUInt32BE(9000, 16);
  header.writeUInt32BE(9000, 20);
  const { request, images } = toImageBlocks(
    body("data:image/png;base64," + header.toString("base64")),
  );
  assert.equal(images.length, 0);
  assert.match(request.input[0].content[1].text, /9000×9000/);
  assert.match(request.input[0].content[1].text, /32 megapixel limit/);

  const zeroed = Buffer.from(header);
  zeroed.writeUInt32BE(0, 16);
  const noDimensions = toImageBlocks(
    body("data:image/png;base64," + zeroed.toString("base64")),
  );
  assert.match(
    noDimensions.request.input[0].content[1].text,
    /declares no dimensions/,
  );
});

test("images stop being forwarded once the request-wide budget is spent", () => {
  const big = (marker) => {
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(9 * 1024 * 1024),
    ]);
    bytes.writeUInt32BE(64, 16);
    bytes.writeUInt32BE(64, 20);
    bytes[bytes.length - 1] = marker;
    return "data:image/png;base64," + bytes.toString("base64");
  };
  const { request, images } = toImageBlocks({
    input: [...body(big(1)).input, ...body(big(2)).input, ...body(big(3)).input],
  });
  assert.equal(images.length, 2, "two 9 MiB images fit in the 20 MiB budget");
  assert.match(request.input[2].content[1].text, /already total 20\.0 MiB/);
});

test("the forwarding path keeps usable images native and only replaces the rest", async () => {
  const { sanitizeImages } = await import("../src/images.mjs");
  const sanitized = sanitizeImages({
    input: [
      ...body("https://example.com/generated.png").input,
      { role: "assistant", content: [{ type: "output_text", text: "..." }] },
      ...body(data).input,
    ],
  });
  // The bad one is explained…
  assert.equal(sanitized.input[0].content[1].type, "input_text");
  assert.match(sanitized.input[0].content[1].text, /remote URLs are never fetched/);
  // …and the good one is passed through untouched, because Grok reads
  // input_image blocks directly on this path.
  assert.deepEqual(sanitized.input[2].content[1], {
    type: "input_image",
    image_url: data,
  });
});

test("the forwarding path leaves a request with no images alone", async () => {
  const { sanitizeImages } = await import("../src/images.mjs");
  const original = {
    model: "grok-4.6",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  };
  assert.deepEqual(sanitizeImages(original), original);
});
