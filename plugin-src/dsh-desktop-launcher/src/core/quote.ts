/**
 * Shell quoting helpers shared by the launcher and autostart generators.
 */

/** Single-quote a value for PowerShell (embedded quotes are doubled). */
export function psSingle(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Single-quote a value for POSIX sh (embedded quotes are escaped). */
export function shSingle(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
