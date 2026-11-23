export type RoleInfo = { role: 'work' | 'service' }

/** Decide el rol de la sesión: servicio (CCAPI_SERVER=1) o trabajo. */
export function detectRole(env: (k: string) => string | undefined): RoleInfo {
  return { role: env('CCAPI_SERVER') === '1' ? 'service' : 'work' }
}
