export interface Change {
  kind: "added" | "fixed";
  text: string;
}

export function parseChanges(input: string): Change[] {
  const value: unknown = JSON.parse(input);
  if (!Array.isArray(value)) throw new Error("Expected a change list");
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Expected a change object");
    const { kind, text } = item as Record<string, unknown>;
    if (kind !== "added" && kind !== "fixed") throw new Error("Unknown change kind");
    if (typeof text !== "string" || !text.trim() || /[\r\n]/.test(text)) {
      throw new Error("Expected nonempty, single-line change text");
    }
    return { kind, text: text.trim() };
  });
}

export function renderNotes(changes: Change[]): string {
  return ["# Release Notes", "", ...changes.map(change => `- ${change.kind}: ${change.text}`), ""].join("\n");
}

if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path) throw new Error("Usage: bun notes.ts <changes.json>");
    process.stdout.write(renderNotes(parseChanges(await Bun.file(path).text())));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
