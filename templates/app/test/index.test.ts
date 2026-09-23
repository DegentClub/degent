import { describe, expect, it } from "vitest";
import { title } from "../src/index.js";

describe("title", () => {
  it("names the product", () => {
    expect(title("x")).toContain("x");
  });
});
