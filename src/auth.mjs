import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class GrokAuthError extends Error {}

function sessionEntries(auth) {
  if (!auth || typeof auth !== "object") return [];
  return Object.values(auth).filter(
    (value) =>
      value &&
      typeof value === "object" &&
      typeof value.key === "string" &&
      value.key.length > 0,
  );
}

export function readGrokBearerToken(home = homedir()) {
  let auth;
  try {
    auth = JSON.parse(readFileSync(join(home, ".grok/auth.json"), "utf8"));
  } catch {
    throw new GrokAuthError("Grok login required");
  }
  const entries = sessionEntries(auth);
  if (!entries.length) throw new GrokAuthError("Grok login required");
  entries.sort((left, right) =>
    String(right.expires_at ?? "").localeCompare(String(left.expires_at ?? "")),
  );
  const session = entries[0];
  return {
    token: session.key,
    userId: typeof session.user_id === "string" ? session.user_id : null,
  };
}
