
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, join as joinPath, resolve as resolvePath, sep } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { json, requireSameOrigin } from './http-utils.ts'

/** Browser-facing base path of the custom-image upload API. */
export const IMAGE_API_PREFIX = '/api/skin-center/image'

/** Default store dir for uploaded images (<harnessHome>/skin-center/uploads). */
export function defaultImageUploadsDir(harnessHome: string): string {
  return joinPath(harnessHome, 'skin-center', 'uploads')
}

/** Max upload size: 30 MB (browser previews stay local; the backdrop never needs more). */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

/** Raster image extensions accepted for upload. */
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'])

/** The JSON shape of one uploaded image, matching the browser WallpaperDescriptor contract. */
export interface UploadedImageJson {
  id: string
  title: string
  type: 'image'
  source: 'uploaded'
  playable: true
  updateAvailable: false
  videoUrl: null
  webUrl: null
  frameUrl: null
  sceneUrl: null
  previewUrl: string
}

function mimeFor(absPath: string): string {
  const ext = extname(absPath).slice(1).toLowerCase()
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
  }[ext] || 'application/octet-stream'
}

/** Sanitize an upload base name to ASCII-ish safe characters (keeps CJK, strips path chars). */
function safeBase(name: string): string {
  return name
    .replace(/\\/g, '_')
    .replace(/\//g, '_')
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 60) || 'image'
}

/** Resolve a client-supplied file name inside the uploads dir; null when unsafe. */
function resolveUploadPath(uploadsDir: string, name: string): string | null {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('..')) return null
  const abs = resolvePath(uploadsDir, name)
  if (basename(abs) !== name) return null
  if (!abs.startsWith(uploadsDir + sep)) return null
  return abs
}

/** Sniff magic bytes so a renamed payload cannot masquerade as an image. */
function sniffImage(data: Buffer, ext: string): boolean {
  if (ext === '.png') return data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  if (ext === '.jpg' || ext === '.jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  if (ext === '.gif') return data.length >= 4 && data.toString('latin1', 0, 4) === 'GIF8'
  if (ext === '.bmp') return data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d
  if (ext === '.webp') {
    return data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP'
  }
  if (ext === '.avif') {
    return data.length >= 12 && data.toString('latin1', 4, 8) === 'ftyp'
      && (data.toString('latin1', 8, 12) === 'avif' || data.toString('latin1', 8, 12) === 'avis')
  }
  return false
}

/** Read a raw request body bounded to maxBytes. */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('upload-too-large'))
        queueMicrotask(() => req.destroy())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Extract the first multipart part with name="image": { filename, data }. */
function parseMultipartImage(body: Buffer, contentType: string): { filename: string; data: Buffer } | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!match) return null
  const boundary = (match[1] ?? match[2] ?? '').trim()
  if (boundary === '') return null
  const marker = Buffer.from('--' + boundary)
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'))
  if (headerEnd === -1) return null
  const header = body.subarray(0, headerEnd).toString('latin1')
  if (!/name="image"/.test(header)) return null
  const fileMatch = /filename="([^"]*)"/.exec(header)
  const contentStart = headerEnd + 4
  // Content ends at the next boundary marker (\r\n--boundary or --boundary).
  let contentEnd = body.indexOf(Buffer.from('\r\n--' + boundary), contentStart)
  if (contentEnd === -1) contentEnd = body.indexOf(marker, contentStart)
  if (contentEnd === -1) contentEnd = body.length
  return {
    filename: fileMatch ? fileMatch[1] : 'image',
    data: body.subarray(contentStart, contentEnd),
  }
}

/** List uploaded images newest-first as browser descriptors. */
export function listUploadedImages(uploadsDir: string): UploadedImageJson[] {
  if (!existsSync(uploadsDir)) return []
  let names: string[] = []
  try {
    names = readdirSync(uploadsDir).filter((n) => ALLOWED_EXT.has(extname(n).toLowerCase()))
  } catch {
    return []
  }
  const entries = names
    .map((name) => {
      const abs = joinPath(uploadsDir, name)
      let mtime = 0
      try { mtime = statSync(abs).mtimeMs } catch { return null }
      return { name, mtime }
    })
    .filter((e): e is { name: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime)
  return entries.map(({ name }) => {
    const base = basename(name, extname(name))
    return {
      id: 'upload/' + name,
      title: base,
      type: 'image' as const,
      source: 'uploaded' as const,
      playable: true as const,
      updateAvailable: false as const,
      videoUrl: null,
      webUrl: null,
      frameUrl: null,
      sceneUrl: null,
      previewUrl: IMAGE_API_PREFIX + '/file/' + encodeURIComponent(name),
    }
  })
}

/** Build the custom-image upload route family. */
export function makeImageRoutes(deps: { uploadsDir: string }): WebRoute[] {
  const { uploadsDir } = deps
  const routes: WebRoute[] = []

  // POST /upload — multipart/form-data, field "image". Saves into the
  // uploads dir and answers with the browser descriptor so the card can
  // apply it immediately.
  routes.push({
    kind: 'exact',
    path: IMAGE_API_PREFIX + '/upload',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!requireSameOrigin(req, res)) return
      const contentType = req.headers['content-type'] ?? ''
      if (!contentType.startsWith('multipart/form-data')) {
        json(res, 415, { ok: false, error: 'multipart-required' })
        return
      }
      void readRawBody(req, MAX_UPLOAD_BYTES).then((body) => {
        const part = parseMultipartImage(body, contentType)
        if (part === null || part.data.length === 0) {
          json(res, 400, { ok: false, error: 'missing-image-part' })
          return
        }
        const ext = extname(part.filename).toLowerCase()
        if (!ALLOWED_EXT.has(ext)) {
          json(res, 415, { ok: false, error: 'unsupported-image-type' })
          return
        }
        if (!sniffImage(part.data, ext)) {
          json(res, 415, { ok: false, error: 'not-an-image' })
          return
        }
        mkdirSync(uploadsDir, { recursive: true })
        const base = safeBase(basename(part.filename, ext))
        let name = base + '-' + String(Date.now()) + ext
        let guard = 0
        while (existsSync(joinPath(uploadsDir, name)) && guard < 100) {
          guard += 1
          name = base + '-' + String(Date.now()) + '-' + String(guard) + ext
        }
        const abs = joinPath(uploadsDir, name)
        try {
          writeFileSync(abs, part.data)
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        const descriptor = listUploadedImages(uploadsDir).find((w) => w.id === 'upload/' + name)
        json(res, 200, { ok: true, wallpaper: descriptor ?? null, id: 'upload/' + name })
      }).catch((error: unknown) => {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      })
    },
  })

  // GET /list — the uploaded images (newest first), same shape as the WE inventory slice.
  routes.push({
    kind: 'exact',
    path: IMAGE_API_PREFIX + '/list',
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!requireSameOrigin(req, res)) return
      try {
        json(res, 200, { ok: true, images: listUploadedImages(uploadsDir) })
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // GET /file/<name> (serve) and DELETE /file/<name> (remove) share one
  // prefix route — the webserver dispatches by path, the handler splits on
  // method. Same-origin fence + path-escape checks apply to both.
  routes.push({
    kind: 'prefix',
    path: IMAGE_API_PREFIX + '/file',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        json(res, 405, { ok: false, error: 'method-not-allowed' }); return
      }
      if (!requireSameOrigin(req, res)) return
      let name = ''
      try {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname
        name = decodeURIComponent(pathname.slice((IMAGE_API_PREFIX + '/file/').length).split('/')[0] ?? '')
      } catch { /* malformed */ }
      const abs = resolveUploadPath(uploadsDir, name)
      if (req.method === 'DELETE') {
        if (abs === null) { json(res, 400, { ok: false, error: 'bad-name' }); return }
        if (!existsSync(abs)) { json(res, 404, { ok: false, error: 'not-found' }); return }
        try {
          rmSync(abs, { force: true })
          json(res, 200, { ok: true })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (abs === null || !existsSync(abs) || !statSync(abs).isFile()) {
        json(res, 404, { ok: false, error: 'not-found' })
        return
      }
      res.writeHead(200, {
        'Content-Type': mimeFor(abs),
        'Content-Length': String(statSync(abs).size),
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      })
      createReadStream(abs).pipe(res)
    },
  })

  return routes
}
