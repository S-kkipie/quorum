export type RoleInfo = { role: 'work' | 'service' }

/** Decides the session role: service (CCAPI_SERVER=1) or work. */
export function detectRole(env: (k: string) => string | undefined): RoleInfo {
  return { role: env('CCAPI_SERVER') === '1' ? 'service' : 'work' }
}
