/**
 * Shared test toolbox (dependency-free).
 *
 * NOTE: The app's own Elysia HTTP/WS server does not exist as an importable
 * module yet. Later integration tests will start the server via the app's own
 * Elysia server entry; this file only provides pure helpers so those tests
 * stay isolated and deterministic. Do NOT import the app from here.
 */

/**
 * Generates a unique, collision-safe room name for test isolation.
 *
 * Example: `stress-msymbolom9xku2h`
 */
export function randomRoomName(prefix: string): string {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * Returns an absolute temp-file path for tests that need a real-file DB.
 *
 * Example: `/tmp/chatroom-test-lx3k4h2.db`
 */
export function tmpDbPath(): string {
  return `/tmp/chatroom-test-${Math.random().toString(36).slice(2, 10)}.db`
}
