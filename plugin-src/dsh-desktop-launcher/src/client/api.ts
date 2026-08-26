/**
 * Browser-side API client for /api/dsh-desktop-launcher — plain same-origin
 * fetch, the only data path the settings card uses.
 */
import { LAUNCHER_API, type AutostartStatus, type CreateResult } from '../protocol.ts'

/** Error carrying the route's JSON error message. */
export class DesktopLauncherApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopLauncherApiError'
  }
}

/** Unwrap one route JSON envelope, mapping HTTP errors to ApiError. */
async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new DesktopLauncherApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new DesktopLauncherApiError(message)
  }
  return body as T
}

/** Create (or refresh) the desktop icon. */
export async function createDesktopShortcut(): Promise<CreateResult> {
  const body = await requestJson<{ result?: unknown }>(LAUNCHER_API.create, { method: 'POST' })
  const result = body.result
  if (typeof result !== 'object' || result === null || (result as CreateResult).ok !== true) {
    throw new DesktopLauncherApiError('desktop shortcut creation returned an invalid result')
  }
  return result as CreateResult
}

/** Read the live boot-autostart registration state. */
export async function fetchAutostartStatus(): Promise<AutostartStatus> {
  return requestJson<AutostartStatus>(LAUNCHER_API.autostart)
}

/** Enable or disable boot autostart. */
export async function setAutostartEnabled(enabled: boolean): Promise<AutostartStatus> {
  return requestJson<AutostartStatus>(LAUNCHER_API.autostart, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}
