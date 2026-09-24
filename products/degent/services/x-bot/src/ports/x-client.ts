/** Posting to X. Adapters: `HttpXClient` (X API v2 `POST /2/tweets`, user-context token), `MemoryXClient` (tests, dry runs). */
export interface XClient {
  post(text: string): Promise<{ id: string }>;
}
