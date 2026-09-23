// import "@bsh/not-a-dep" in a comment is ignored
import { core } from "@bsh/core";
import { sub } from "@bsh/core/sub";
export * from "@bsh/degent-sdk";
const s = 'import "@bsh/also-ignored"';
export async function load() { return import("@bsh/degent-sdk"); }
import { helper } from "./lib/helper";
import self from "@bsh/degent-api";
export { core, sub, s, helper, self };
