/**
 * The ONE place for per-test timeouts of slow unit tests. The global testTimeout (vitest.config.ts, 30 s) stays as it is so
 * fast tests still fail fast; a test that is slow by nature opts in with one of these. Why they are generous: the project is
 * developed on a slow disk/network machine, and slow files run in parallel and starve each other (measured: three heavy files
 * together made a 17 s test take 40 s). A timeout only bounds a HANG; it never hides a wrong result, and the tests keep their
 * own explicit speed assertions (for example "under 500 ms").
 *
 * Use as `describe("...", { timeout: SLOW_TOOL_TIMEOUT_MS }, () => ...)` or `it("...", () => ..., HEAVY_FUZZ_TIMEOUT_MS)`.
 * tests/timeout-helper-guard.test.ts fails if a test file runs ESLint, Next or a child process without importing this file.
 */

/** In-process ESLint (loads the full flat config) and dynamic imports of whole Next pages (cold module graph, transform). */
export const SLOW_TOOL_TIMEOUT_MS = 120_000;

/** A test that starts a child process (none today). The child must ALSO carry its own kill timeout, see CHILD_KILL_TIMEOUT_MS. */
export const CHILD_PROCESS_TIMEOUT_MS = 120_000;

/** The kill timeout to give a spawned child, strictly below CHILD_PROCESS_TIMEOUT_MS so a hung child dies before the test gives up. */
export const CHILD_KILL_TIMEOUT_MS = 90_000;

/** CPU-heavy fuzz and size-limit tests (every bit flip of a message, 20,000 random inputs, megabyte inputs). */
export const HEAVY_FUZZ_TIMEOUT_MS = 90_000;

/** Fast tests that were seen to stall only because the machine was loaded (a cold worker, a starved event loop). */
export const LOADED_MACHINE_TIMEOUT_MS = 60_000;
