// Smoke harness: import the edited host bundle with exports stripped and
// exercise the pure render functions, then verify the generated PowerShell
// probe logic against the live local server.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const stripped = bundle.replace(/export \{[^}]*\};?/s, '')
const testFile = join(here, 'bundle-under-test.mjs')
writeFileSync(testFile, stripped + `
globalThis.__dshLauncherTest = {
  renderAutostartScript,
  renderPowerShell,
  autostartEntryPath,
  getAutostartStatus,
}
`)
const mod = await import(pathToFileURL(testFile).href)
const t = globalThis.__dshLauncherTest

const spec = { dshCommand: 'dsh', url: 'http://127.0.0.1:3080' }
const win = t.renderAutostartScript('win32', spec, 'F:\\workspace\\dsh-home')
const posix = t.renderAutostartScript('linux', spec, '/home/x/.dsh-home')
const interactive = t.renderPowerShell(spec)

mkdirSync(join(here, 'out'), { recursive: true })
// UTF-8 BOM like the real route writes (PS 5.1 compatibility).
writeFileSync(join(here, 'out', 'autostart.ps1'), '\uFEFF' + win)
writeFileSync(join(here, 'out', 'launcher.ps1'), '\uFEFF' + interactive)
writeFileSync(join(here, 'out', 'autostart.sh'), posix)

console.log('win autostart bytes:', Buffer.byteLength(win))
console.log('posix autostart bytes:', Buffer.byteLength(posix))
console.log('interactive bytes:', Buffer.byteLength(interactive))
console.log('entryPath(win):', t.autostartEntryPath('win32', 'C:\\Users\\u'))
console.log('entryPath(linux):', t.autostartEntryPath('linux', '/home/u'))
console.log('has Test-DshPort:', win.includes('function Test-DshPort'))
console.log('has single-instance guard:', win.includes('already held; waiting for readiness'))
console.log('has DSH_HOME embed:', win.includes(`$dshHome = 'F:\\workspace\\dsh-home'`))
console.log('no proxy in http probe:', !win.includes('Invoke-WebRequest') && win.includes('$request.Proxy = $null'))
