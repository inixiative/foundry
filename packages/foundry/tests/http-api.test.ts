import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { HttpApi } from "../src/tools/http-api";

// We'll test against a real local server for integration tests.
// For unit tests, we test URL resolution and gating logic without network.

describe("HttpApi", () => {
  test("has correct metadata", () => {
    const api = new HttpApi();
    expect(api.id).toBe("api");
    expect(api.kind).toBe("api");
    expect(api.capability).toBe("net:api");
  });

  test("custom id", () => {
    const api = new HttpApi({ id: "github-api" });
    expect(api.id).toBe("github-api");
  });

  // -- URL gating --

  test("blocks URLs not in allowedUrls", async () => {
    const api = new HttpApi({
      allowedUrls: ["https://api.example.com/**"],
    });
    const result = await api.get("https://evil.com/steal");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("URL not allowed");
  });

  test("allows URLs matching allowedUrls pattern", async () => {
    const api = new HttpApi({
      baseUrl: "https://httpbin.org",
      allowedUrls: ["https://httpbin.org/**"],
    });
    // This will make a real request to httpbin
    const result = await api.get("/get");
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe(200);
  });

  test("blocks URLs in blockedUrls even when allowedUrls is empty", async () => {
    const api = new HttpApi({
      blockedUrls: ["https://blocked.example.com/**"],
    });
    const result = await api.get("https://blocked.example.com/path");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("URL not allowed");
  });

  // -- URL resolution --

  test("prepends baseUrl to relative paths", async () => {
    const api = new HttpApi({
      baseUrl: "https://httpbin.org",
      allowedUrls: ["https://httpbin.org/**"],
    });
    const result = await api.get("/get");
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("200");
  });

  test("uses absolute URLs as-is", async () => {
    const api = new HttpApi({
      baseUrl: "https://should-not-use.com",
      allowedUrls: ["https://httpbin.org/**"],
    });
    const result = await api.get("https://httpbin.org/get");
    expect(result.ok).toBe(true);
  });

  // -- HTTP methods --

  test("GET returns structured response", async () => {
    const api = new HttpApi({ baseUrl: "https://httpbin.org" });
    const result = await api.get("/get");
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe(200);
    expect(result.data?.statusText).toBe("OK");
    expect(result.data?.headers).toBeDefined();
    expect(result.data?.durationMs).toBeGreaterThan(0);
    expect(result.summary).toContain("GET");
    expect(result.summary).toContain("200");
  });

  test("POST sends body", async () => {
    const api = new HttpApi({ baseUrl: "https://httpbin.org" });
    const result = await api.post("/post", { key: "value" });
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe(200);
    const body = result.data?.body as any;
    expect(body.json).toEqual({ key: "value" });
  });

  test("handles 404 as ok=false", async () => {
    const api = new HttpApi({ baseUrl: "https://httpbin.org" });
    const result = await api.get("/status/404");
    expect(result.ok).toBe(false);
    expect(result.data?.status).toBe(404);
    expect(result.error).toContain("404");
  });

  // -- Auth --

  test("applies bearer token", async () => {
    const api = new HttpApi({
      baseUrl: "https://httpbin.org",
      bearerToken: "test-token-123",
    });
    const result = await api.get("/get");
    expect(result.ok).toBe(true);
    const body = result.data?.body as any;
    expect(body.headers?.Authorization).toBe("Bearer test-token-123");
  });

  test("setBearerToken updates token", async () => {
    const api = new HttpApi({ baseUrl: "https://httpbin.org" });
    api.setBearerToken("new-token");
    const result = await api.get("/get");
    expect(result.ok).toBe(true);
    const body = result.data?.body as any;
    expect(body.headers?.Authorization).toBe("Bearer new-token");
  });

  // -- Response handling --

  test("includes estimatedTokens", async () => {
    const api = new HttpApi({ baseUrl: "https://httpbin.org" });
    const result = await api.get("/get");
    expect(result.ok).toBe(true);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  test("handles connection errors gracefully", async () => {
    const api = new HttpApi({ baseUrl: "http://localhost:19999" }); // nothing listening
    const result = await api.get("/nope");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.summary).toContain("failed");
  });
});
