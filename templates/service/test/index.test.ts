import { describe, expect, it } from "vitest";
import { health } from "../src/index.js";

describe("health", () => {
  it("reports ok", () => {
    expect(health().status).toBe("ok");
  });
});
