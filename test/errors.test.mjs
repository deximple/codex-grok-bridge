import test from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_ERROR, classifyBridgeError, errorSignature, bridgeErrorMessage } from "../src/errors.mjs";

const undiciFailure = (message, causeName, causeCode, causeMessage) => {
  const error = new TypeError(message);
  const cause = new Error(causeMessage);
  cause.name = causeName;
  cause.code = causeCode;
  error.cause = cause;
  return error;
};

test("classifies the undici failures the old allowlist missed", () => {
  const cases = [
    ["fetch failed", "Error", "EAI_AGAIN", "getaddrinfo EAI_AGAIN cli-chat-proxy.grok.com", BRIDGE_ERROR.DNS],
    ["fetch failed", "Error", "ETIMEOUT", "queryA ETIMEOUT", BRIDGE_ERROR.DNS],
    ["fetch failed", "Error", "ENOTFOUND", "getaddrinfo ENOTFOUND", BRIDGE_ERROR.DNS],
    ["fetch failed", "ConnectTimeoutError", "UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error", BRIDGE_ERROR.CONNECT],
    ["terminated", "HeadersTimeoutError", "UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error", BRIDGE_ERROR.UPSTREAM_TIMEOUT],
    ["terminated", "BodyTimeoutError", "UND_ERR_BODY_TIMEOUT", "Body Timeout Error", BRIDGE_ERROR.UPSTREAM_TIMEOUT],
    ["terminated", "SocketError", "UND_ERR_SOCKET", "other side closed", BRIDGE_ERROR.UPSTREAM_CLOSED],
    ["terminated", "HTTPParserError", "HPE_INVALID_CHUNK_SIZE", "Invalid character in chunk size", BRIDGE_ERROR.UPSTREAM_PROTOCOL],
  ];
  for (const [message, name, code, causeMessage, expected] of cases)
    assert.equal(classifyBridgeError(undiciFailure(message, name, code, causeMessage)), expected, `${code} misclassified`);
});

test("still classifies a genuine client abort as abort", () => {
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  assert.equal(classifyBridgeError(abort), BRIDGE_ERROR.ABORTED);
  assert.equal(classifyBridgeError(Object.assign(new Error("write after end"), { code: "ERR_STREAM_DESTROYED" })), BRIDGE_ERROR.ABORTED);
});

test("an abort the bridge raised for its own reason keeps that reason", () => {
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  // Classification never guesses from socket state; the caller states the reason.
  assert.equal(classifyBridgeError(abort), BRIDGE_ERROR.ABORTED);
  assert.equal(
    classifyBridgeError(abort, { reason: BRIDGE_ERROR.UPSTREAM_TIMEOUT }),
    BRIDGE_ERROR.UPSTREAM_TIMEOUT,
  );
});

test("signature carries names and codes but never messages", () => {
  const error = undiciFailure("fetch failed", "Error", "EAI_AGAIN", "getaddrinfo EAI_AGAIN secret-host.internal");
  const signature = errorSignature(error);
  assert.equal(signature, "TypeError <- Error[EAI_AGAIN]");
  assert.ok(!signature.includes("secret-host"));
});

test("user-facing messages are actionable and leak nothing", () => {
  assert.match(bridgeErrorMessage(BRIDGE_ERROR.DNS), /DNS lookup/);
  assert.match(bridgeErrorMessage(BRIDGE_ERROR.UPSTREAM_CLOSED, "after 0 events"), /Retry\. \(after 0 events\)/);
  for (const kind of Object.values(BRIDGE_ERROR))
    assert.ok(!/\/Users\/|Bearer|eyJ/.test(bridgeErrorMessage(kind)));
});
