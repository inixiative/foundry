import { describe, expect, test } from "bun:test";
import { buildInjectionArtifact, type AssembledContext } from "../src";

describe("buildInjectionArtifact", () => {
  test("keeps user message and injected segments inspectable", () => {
    const assembled: AssembledContext = {
      blocks: [
        { role: "system", text: "You are the Artificer." },
        { role: "layer", id: "conventions", text: "Follow project placement rules." },
        { role: "content", id: "conventions", text: "Use existing primitives before adding wrappers." },
        { role: "content", id: "__thread-state", text: "User approved the session graph." },
      ],
      text: "",
    };

    const artifact = buildInjectionArtifact({
      userMessage: "Build the harness loop.",
      assembled,
      routing: "category=feature tags=foundry,harness",
      guardFindings: "No prior blockers.",
      layerFreshness: {
        conventions: { state: "warm", lastWarmed: 123 },
        "__thread-state": { state: "warm", lastWarmed: 456 },
      },
    });

    expect(artifact.text).toContain("# User Message\n\nBuild the harness loop.");
    expect(artifact.text).toContain("## Tags / Routing");
    expect(artifact.text).toContain("## Instructions");
    expect(artifact.text).toContain("## Domain Knowledge");
    expect(artifact.text).toContain("## Thread State");
    expect(artifact.text).toContain("## Prior Guard Findings");

    expect(artifact.blocks.map((block) => block.kind)).toEqual([
      "routing",
      "instructions",
      "instructions",
      "domain-knowledge",
      "thread-knowledge",
      "guard-findings",
    ]);
    expect(artifact.blocks.every((block) => block.hash.length > 0 && block.tokens > 0)).toBe(true);
    expect(artifact.blocks.find((block) => block.source === "conventions")?.freshness).toEqual({
      state: "warm",
      lastWarmed: 123,
    });
  });
});
