import { describe, expect, it } from "vitest";
import { hello } from "../src/index.js";

describe("hello", () => {
  it("greets", () => {
    expect(hello("world")).toBe("hello, world");
  });
});
