import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildGrokInvocation,
  parseGrokResult,
  decodeOutput,
} from "../../src/cli-inference.mjs";
const file = process.argv[2];
if (!file) throw Error("Supply a local PNG test image");
const data = (await readFile(file)).toString("base64");
const dir = await mkdtemp(path.join(tmpdir(), "grok-vision-probe-"));
try {
  const prompt = path.join(dir, "input.json");
  await writeFile(
    prompt,
    JSON.stringify([
      {
        type: "text",
        text: 'Read the remaining percentage in the 5h row of this image. Return JSON {"text":"the percentage only","calls":[]}.',
      },
      { type: "image", mimeType: "image/png", data },
    ]),
    { mode: 0o600 },
  );
  const invocation = buildGrokInvocation({
    input: [],
    reasoning: { effort: "low" },
  });
  invocation.args.splice(
    invocation.args.indexOf("--single"),
    2,
    "--prompt-file",
    prompt,
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(invocation.binary, invocation.args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.stdout.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
  if (result.code !== 0) throw Error("Vision CLI exited " + result.code);
  const parsed = parseGrokResult(result.output);
  console.log(
    JSON.stringify({
      code: result.code,
      sessionId: parsed.sessionId,
      output: decodeOutput(parsed),
    }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
