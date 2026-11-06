// Restricted sessions use only host-granted DSH schemas; Claude built-in
// tools never execute. The host remains responsible for object/file scopes.
export function nativeToolPolicy(allowlist) {
  if (allowlist === undefined) return null;
  if (!Array.isArray(allowlist) || allowlist.some(name => typeof name !== "string" || !name.trim())) {
    throw new Error("Claude Relay requires a valid native tool allowlist");
  }
  return new Set(allowlist);
}
