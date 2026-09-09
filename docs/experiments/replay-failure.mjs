import fs from "node:fs";
import {
  runGrok,
  buildGrokInvocation,
  parseGrokResult,
  decodeOutput,
} from "../../src/cli-inference.mjs";
// A captured Grok CLI chat history to replay. Pass one as the first argument;
// the CLI writes them under ~/.grok/sessions/.
const source = process.argv[2];
if (!source) {
  console.error("usage: replay-failure.mjs <path-to-chat_history.jsonl>");
  process.exit(2);
}
const rows = fs.readFileSync(source, "utf8").trim().split("\n").map(JSON.parse);
const prompt = rows
  .flatMap((r) => (Array.isArray(r.content) ? r.content : []))
  .find((c) => c.text?.includes("CODEX REQUEST:\n"))?.text;
if (!prompt) throw Error("Captured request missing");
const body = JSON.parse(prompt.split("CODEX REQUEST:\n")[1]);
const result = await runGrok(buildGrokInvocation(body));
const parsed = parseGrokResult(result.stdout);
fs.writeFileSync(
  new URL("../replay-result.json", import.meta.url),
  JSON.stringify(
    {
      exitCode: result.exitCode,
      sessionId: parsed.sessionId,
      stopReason: parsed.stopReason,
      numTurns: parsed.num_turns,
    },
    null,
    2,
  ),
);
const output = decodeOutput(parsed, body.tools, body.tool_choice);
console.log(
  JSON.stringify({
    exitCode: result.exitCode,
    sessionId: parsed.sessionId,
    stopReason: parsed.stopReason,
    numTurns: parsed.num_turns,
    outputTypes: output.map((o) => o.type),
    toolNames: output.filter((o) => o.name).map((o) => o.name),
  }),
);
if (result.exitCode !== 0) process.exitCode = 1;
