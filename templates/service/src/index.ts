/**
 * Service entry point. Keep I/O at the edges: build the app from injected ports so tests can run it
 * with in-memory adapters.
 */
export interface Health {
  status: "ok";
  service: string;
}

export function health(): Health {
  return { status: "ok", service: "__component__" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(health()));
}
