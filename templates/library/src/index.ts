/** Public API of this library. Export only what other components may depend on. */
export function hello(name: string): string {
  return `hello, ${name}`;
}
