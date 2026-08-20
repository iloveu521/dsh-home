/**
 * Share the four immutable, first-party Host inspect providers contributed by
 * dsh-tool-cordis across standing preset generations.
 *
 * Agent presets intentionally keep an old generation alive when their source
 * stamp changes. dsh-tool-cordis normally registers process-global providers,
 * so mounting the next generation otherwise throws before a session can
 * resume. Only byte-for-byte equivalent manifests from the known first-party
 * provider ids are shared; every other collision keeps the native error.
 */

const SHAREABLE = new Set(['Service', 'Event', 'Builtin', 'Tool'])

function stableManifest(value) {
  return JSON.stringify(value)
}

export const inject = ['cordisInspect']

export function apply(ctx) {
  const registry = ctx.cordisInspect
  const logger = typeof ctx.logger === 'function' ? ctx.logger('cordis-resilience') : ctx.logger
  const nativeRegister = registry.register.bind(registry)
  const shared = new Map()

  registry.register = function registerShared(registration) {
    const id = registration?.manifest?.id
    if (!SHAREABLE.has(id)) return nativeRegister(registration)

    const manifest = stableManifest(registration.manifest)
    const current = shared.get(id)
    if (current) {
      if (current.manifest !== manifest) return nativeRegister(registration)
      current.references += 1
      logger?.warn?.(`reusing identical Host inspect provider "${id}"`)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        current.references -= 1
        if (current.references === 0) {
          current.dispose()
          shared.delete(id)
        }
      }
    }

    const dispose = nativeRegister(registration)
    const record = { manifest, references: 1, dispose }
    shared.set(id, record)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      record.references -= 1
      if (record.references === 0) {
        record.dispose()
        shared.delete(id)
      }
    }
  }

  logger?.info?.('identical tool-cordis providers will be shared safely')

  ctx.effect(() => () => {
    registry.register = nativeRegister
  }, 'cordis-resilience: restore registry method')
}

export default { inject, apply }
