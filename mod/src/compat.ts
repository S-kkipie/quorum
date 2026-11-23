/**
 * Calls a mod API that may not exist in this Claude Code version
 * (e.g. `$.session.info` is missing in 2.1.325). If the function does not exist,
 * throws synchronously or its promise fails, returns `fallback` instead of aborting the hook.
 */
export function optional<T>(call: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return Promise.resolve(call()).catch(() => fallback)
  } catch {
    return Promise.resolve(fallback)
  }
}
