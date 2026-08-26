/**
 * The /api/dsh-desktop-launcher route family: one POST that writes the
 * launcher script under ~/.dsh/desktop-launcher/ and places the double-click
 * icon on the Desktop, one endpoint that queries or toggles the boot
 * autostart registration, plus shutdown handled separately. Every route
 * carries the same loopback-only trust fence as the dsh-ssh routes — these
 * endpoints write files on the host machine, so LAN-exposed dsh web
 * deployments must not serve them.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { autostartEntryPath, renderAutostartDesktopEntry, renderAutostartInstaller, renderAutostartPlist } from './core/autostart.ts'
import { autostartFileName, desktopFileName, renderAutostartScript, renderDesktopEntry, renderLauncherScript, renderShortcutInstaller, scriptFileName, type LauncherPlatform, type LauncherSpec } from './core/launcher.ts'
import { LAUNCHER_API, type AutostartStatus, type CreateResult } from './protocol.ts'
import { isLoopbackRequest } from './loopback.ts'

const execFileAsync = promisify(execFile)

/** Result of one spawned command (tests inject a fake runner). */
export interface CommandResult {
  /** Process exit code. */
  code: number | null
  /** Captured stderr. */
  stderr: string
}

/** Runner signature: execute a command with arguments and report its exit. */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>

/** Route dependencies: the live spec resolver plus test seams. */
export interface LauncherRoutesDeps {
  /** Resolve the live launcher spec (composition + settings). */
  resolveSpec: () => LauncherSpec
  /**
   * DSH_HOME embedded into generated autostart scripts so a portable home
   * survives a bare login environment; defaults to the ambient DSH_HOME or,
   * when unset, `<home>/.dsh`.
   */
  dshHome?: string
  /** Home directory (defaults to os.homedir()). */
  homeDir?: string
  /** Host platform (defaults to process.platform). */
  platform?: string
  /** Command runner (defaults to child_process.execFile). */
  run?: CommandRunner
  /** Test seam: explicit icon source file (overrides discovery). */
  iconSource?: string
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/**
 * The dsh icon bundled with the package (assets/dsh.ico next to lib/index.js).
 * Vitest transforms src modules to non-file URLs, so a missing or unparsable
 * bundle URL is tolerated (tests inject iconSource instead).
 */
let bundledIconPath: string | undefined
let bundledPngPath: string | undefined
if (import.meta.url.startsWith('file:')) {
  try { bundledIconPath = fileURLToPath(new URL('../assets/dsh.ico', import.meta.url)) } catch { /* keep undefined */ }
  try { bundledPngPath = fileURLToPath(new URL('../assets/dsh.png', import.meta.url)) } catch { /* keep undefined */ }
}

/**
 * Resolve the icon source: the injected override, then the configured
 * iconPath when it exists, then the bundled dsh icon. Undefined when none is
 * available.
 * @param configured - the spec's optional iconPath.
 * @param override - test seam: an explicit icon file.
 * @returns the source icon file, or undefined.
 */
function resolveIconSource(configured: string | undefined, override: string | undefined): string | undefined {
  if (override !== undefined && existsSync(override)) return override
  if (configured !== undefined && configured !== '' && existsSync(configured)) return configured
  return bundledIconPath !== undefined && existsSync(bundledIconPath) ? bundledIconPath : undefined
}

/** Default runner: execFile with a 30s cap, reporting exit code and stderr. */
const defaultRunner: CommandRunner = async (file, args) => {
  try {
    await execFileAsync(file, args, { timeout: 30_000, windowsHide: true })
    return { code: 0, stderr: '' }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : null
    return {
      code: typeof code === 'number' ? code : null,
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Narrow a raw platform string to the supported set. */
function toLauncherPlatform(platform: string): LauncherPlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  throw new Error(`unsupported platform: ${platform}`)
}

/** Resolve the home directory for route work. */
function resolveHome(deps: LauncherRoutesDeps): string {
  return deps.homeDir ?? homedir()
}

/**
 * Resolve the DSH_HOME embedded into autostart scripts: the explicit dep,
 * then the ambient variable of the running host (the value that demonstrably
 * works), then the conventional default location.
 */
function resolveDshHome(deps: LauncherRoutesDeps): string {
  if (deps.dshHome !== undefined && deps.dshHome !== '') return deps.dshHome
  const ambient = process.env.DSH_HOME
  if (ambient !== undefined && ambient.trim() !== '') return ambient
  return join(resolveHome(deps), '.dsh')
}

/**
 * Desktop directory: the standard Desktop, with the OneDrive redirect
 * fallback on Windows when the plain path does not exist.
 */
function resolveDesktopDir(home: string, platform: LauncherPlatform): string {
  const desktop = join(home, 'Desktop')
  if (platform === 'win32' && !existsSync(desktop)) {
    const onedrive = join(home, 'OneDrive', 'Desktop')
    if (existsSync(onedrive)) return onedrive
  }
  return desktop
}

/**
 * Best-effort dsh command probe (never throws). Absolute or path-like
 * commands are checked by existence; bare names are probed through the
 * platform's PATH lookup.
 */
async function probeDsh(platform: LauncherPlatform, run: CommandRunner, dshCommand: string): Promise<boolean> {
  if (isAbsolute(dshCommand) || dshCommand.includes('/') || dshCommand.includes('\\')) {
    return existsSync(dshCommand)
  }
  try {
    const result = platform === 'win32'
      ? await run('where', [dshCommand])
      : await run('sh', ['-lc', `command -v ${dshCommand}`])
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Write the launcher script and place the desktop icon for the current
 * platform. Refreshing is idempotent: rerunning overwrites both files.
 * @param deps - spec resolver plus test seams.
 * @returns the icon path and any non-fatal warning.
 */
export async function createDesktopShortcut(deps: LauncherRoutesDeps): Promise<CreateResult> {
  const spec = deps.resolveSpec()
  const platform = toLauncherPlatform(deps.platform ?? process.platform)
  const home = resolveHome(deps)
  const run = deps.run ?? defaultRunner
  const scriptsDir = join(home, '.dsh', 'desktop-launcher')
  await mkdir(scriptsDir, { recursive: true })
  const launcherPath = join(scriptsDir, scriptFileName(platform))
  // UTF-8 BOM: Windows PowerShell 5.1 misreads the Chinese popup text without it.
  await writeFile(launcherPath, '\uFEFF' + renderLauncherScript(platform, spec), { mode: 0o755 })
  // Copy the icons next to the launcher so the shortcut keeps working even if
  // the source package moves: windows uses dsh.ico as the .lnk icon, the
  // startup popup and linux use dsh.png when available.
  let iconIco: string | undefined
  let iconPng: string | undefined
  const iconSource = resolveIconSource(spec.iconPath, deps.iconSource)
  if (iconSource !== undefined) {
    iconIco = join(scriptsDir, 'dsh.ico')
    await copyFile(iconSource, iconIco)
    if (/\.png$/i.test(iconSource)) {
      iconPng = join(scriptsDir, 'dsh.png')
      await copyFile(iconSource, iconPng)
    } else if (bundledPngPath !== undefined && existsSync(bundledPngPath)) {
      iconPng = join(scriptsDir, 'dsh.png')
      await copyFile(bundledPngPath, iconPng)
    }
  }
  const desktopDir = resolveDesktopDir(home, platform)
  await mkdir(desktopDir, { recursive: true })
  const iconPath = join(desktopDir, desktopFileName(platform))
  let warning: string | undefined
  const dshFound = await probeDsh(platform, run, spec.dshCommand)
  if (!dshFound) warning = `dsh command "${spec.dshCommand}" was not found on PATH; the launcher shows a message when run`
  if (platform === 'win32') {
    const installerPath = join(scriptsDir, 'install-shortcut.ps1')
    await writeFile(installerPath, renderShortcutInstaller({ launcherPath, desktopPath: iconPath, homeDir: home, iconLocation: iconIco ?? 'powershell.exe,0' }))
    const result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerPath])
    if (result.code !== 0) throw new Error(`shortcut creation failed: ${result.stderr}`)
  } else if (platform === 'darwin') {
    await writeFile(iconPath, renderLauncherScript(platform, spec), { mode: 0o755 })
  } else {
    await writeFile(iconPath, renderDesktopEntry(launcherPath, iconPng ?? iconIco), { mode: 0o755 })
    await chmod(launcherPath, 0o755)
    // Best-effort trust marker: GNOME refuses untrusted desktop entries.
    const trust = await run('gio', ['set', iconPath, 'metadata::trusted', 'true'])
    if (trust.code !== 0) warning = `desktop entry created but not marked trusted: ${trust.stderr}`
  }
  return { ok: true, path: iconPath, platform, ...(warning === undefined ? {} : { warning }) }
}

/** Absolute path of the silent autostart script for the given platform/home. */
function autostartScriptPath(platform: LauncherPlatform, home: string): string {
  return join(home, '.dsh', 'desktop-launcher', autostartFileName(platform))
}

/**
 * Read the current boot-autostart registration state.
 * @param deps - spec resolver plus test seams.
 * @returns the status snapshot.
 */
export async function getAutostartStatus(deps: LauncherRoutesDeps): Promise<AutostartStatus> {
  const platform = toLauncherPlatform(deps.platform ?? process.platform)
  const home = resolveHome(deps)
  const entryPath = autostartEntryPath(platform, home)
  const scriptPath = autostartScriptPath(platform, home)
  return {
    ok: true,
    platform,
    registered: existsSync(entryPath),
    entryPath,
    scriptPath,
  }
}

/**
 * Enable boot autostart: write the silent script from the live spec (with
 * the embedded DSH_HOME) and register the per-user login entry. Idempotent —
 * rerunning refreshes the script in place so url/profile changes propagate.
 * @param deps - spec resolver plus test seams.
 * @returns the status after registration.
 */
export async function enableAutostart(deps: LauncherRoutesDeps): Promise<AutostartStatus> {
  const spec = deps.resolveSpec()
  const platform = toLauncherPlatform(deps.platform ?? process.platform)
  const home = resolveHome(deps)
  const run = deps.run ?? defaultRunner
  const dshHome = resolveDshHome(deps)
  const scriptsDir = join(home, '.dsh', 'desktop-launcher')
  await mkdir(scriptsDir, { recursive: true })
  const scriptPath = autostartScriptPath(platform, home)
  if (platform === 'win32') {
    // UTF-8 BOM: Windows PowerShell 5.1 misreads non-ASCII text without it.
    await writeFile(scriptPath, '\uFEFF' + renderAutostartScript(platform, spec, dshHome), { mode: 0o755 })
  } else {
    await writeFile(scriptPath, renderAutostartScript(platform, spec, dshHome), { mode: 0o755 })
    await chmod(scriptPath, 0o755)
  }
  const entryPath = autostartEntryPath(platform, home)
  if (platform === 'win32') {
    const icon = join(scriptsDir, 'dsh.ico')
    const installerPath = join(scriptsDir, 'install-autostart.ps1')
    await writeFile(installerPath, renderAutostartInstaller({
      autostartScriptPath: scriptPath,
      entryPath,
      homeDir: home,
      iconLocation: existsSync(icon) ? icon : 'powershell.exe,0',
    }))
    const result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerPath])
    if (result.code !== 0) throw new Error(`autostart registration failed: ${result.stderr}`)
  } else if (platform === 'darwin') {
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(entryPath, renderAutostartPlist(scriptPath, `${scriptsDir}/autostart.out.log`))
    await run('launchctl', ['unload', entryPath]).catch(() => ({ code: null, stderr: '' }))
    const loaded = await run('launchctl', ['load', entryPath])
    if (loaded.code !== 0) throw new Error(`launchctl load failed: ${loaded.stderr}`)
  } else {
    await mkdir(join(home, '.config', 'autostart'), { recursive: true })
    await writeFile(entryPath, renderAutostartDesktopEntry(scriptPath))
  }
  return {
    ok: true,
    platform,
    registered: true,
    entryPath,
    scriptPath,
  }
}

/**
 * Disable boot autostart: remove the per-user login entry (the silent script
 * stays behind harmlessly and is refreshed on the next enable).
 * @param deps - spec resolver plus test seams.
 * @returns the status after removal.
 */
export async function disableAutostart(deps: LauncherRoutesDeps): Promise<AutostartStatus> {
  const platform = toLauncherPlatform(deps.platform ?? process.platform)
  const home = resolveHome(deps)
  const run = deps.run ?? defaultRunner
  const entryPath = autostartEntryPath(platform, home)
  if (existsSync(entryPath)) {
    if (platform === 'darwin') await run('launchctl', ['unload', entryPath]).catch(() => ({ code: null, stderr: '' }))
    await rm(entryPath, { force: true })
  }
  return {
    ok: true,
    platform,
    registered: false,
    entryPath,
    scriptPath: autostartScriptPath(platform, home),
  }
}

/** Parsed body of an autostart toggle request. */
interface AutostartRequest {
  /** Desired registration state. */
  enabled: boolean
}

/**
 * Build the /api/dsh-desktop-launcher route family.
 * @param deps - spec resolver plus test seams.
 * @returns the routes.
 */
export function makeRoutes(deps: LauncherRoutesDeps): { routes: WebRoute[] } {
  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: LAUNCHER_API.create,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? 'GET') !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        try {
          writeJson(res, 200, { result: await createDesktopShortcut(deps) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: LAUNCHER_API.autostart,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        try {
          if ((req.method ?? 'GET') === 'GET') {
            writeJson(res, 200, await getAutostartStatus(deps))
            return
          }
          if ((req.method ?? 'GET') !== 'POST') {
            writeJson(res, 405, { error: `method not allowed: ${req.method}` })
            return
          }
          const raw = await readBody(req)
          let parsed: AutostartRequest | undefined
          try {
            const body: unknown = JSON.parse(raw)
            if (typeof body === 'object' && body !== null && typeof (body as AutostartRequest).enabled === 'boolean') {
              parsed = body as AutostartRequest
            }
          } catch { /* fall through to the invalid-body reply */ }
          if (parsed === undefined) {
            writeJson(res, 400, { error: 'expected JSON body {"enabled": boolean}' })
            return
          }
          writeJson(res, 200, parsed.enabled ? await enableAutostart(deps) : await disableAutostart(deps))
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
  return { routes }
}

/** Read one request body as UTF-8 text (bounded at 64 KiB). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65_536) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
