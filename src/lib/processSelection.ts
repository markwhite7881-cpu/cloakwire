/** Return the final executable component without persisting its local path. */
export function executableNameFromPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.at(-1)?.trim();
  if (!name || name === "." || name === "..") return null;
  return name;
}
