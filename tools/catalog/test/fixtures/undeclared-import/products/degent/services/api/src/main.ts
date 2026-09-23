import { core } from "@bsh/core";
export * from "@bsh/other";
export const lazy = () => import("@bsh/core");
const c = require("@bsh/core");
type T = import("@bsh/other").X;
import { y } from "@bsh/ghost";
export { core, c };
