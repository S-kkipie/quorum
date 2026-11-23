/**
 * Llama una API del mod que puede no existir en esta versión de Claude Code
 * (p. ej. `$.session.info` falta en 2.1.325). Si la función no existe, lanza
 * de forma síncrona o su promesa falla, devuelve `fallback` en vez de abortar el hook.
 */
export function optional<T>(call: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return Promise.resolve(call()).catch(() => fallback)
  } catch {
    return Promise.resolve(fallback)
  }
}
