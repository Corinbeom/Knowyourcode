import { afterEach, describe, expect, it } from "vitest";

import { GET } from "./route";

const originalSha = process.env.COMMIT_SHA;

afterEach(() => {
  if (originalSha === undefined) delete process.env.COMMIT_SHA;
  else process.env.COMMIT_SHA = originalSha;
});

describe("GET /api/health", () => {
  it("returns the deployed commit SHA", async () => {
    process.env.COMMIT_SHA = "abc123";
    const response = await GET();

    await expect(response.json()).resolves.toEqual({ status: "ok", commitSha: "abc123" });
  });
});
