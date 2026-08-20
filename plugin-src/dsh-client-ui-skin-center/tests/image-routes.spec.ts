/**
 * image-routes tests: the custom-image upload family (upload / list / file /
 * delete) over a real HTTP server and a temp uploads dir, plus the WE
 * inventory integration (uploaded images join the wallpaper inventory so the
 * browser half's selection sync works unchanged). Assertions cover the
 * image sniff, extension allowlist, path-escape fence and same-origin gate.
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { makeImageRoutes, IMAGE_API_PREFIX } from '../src/image-routes.ts'
import { makeWeRoutes, WE_API_PREFIX } from '../src/we-routes.ts'

/** 1x1 transparent PNG (valid magic + structure for the sniff + serve tests). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let root: string
let uploads: string
let server: Server
let port: number

function multipart(boundary: string, filename: string, data: Buffer, contentType: string): Buffer {
  const head = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="image"; filename="' + filename + '"\r\n' +
    'Content-Type: ' + contentType + '\r\n\r\n',
    'utf8',
  )
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8')
  return Buffer.concat([head, data, tail])
}

async function serve(routes: WebRoute[]): Promise<void> {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname
    const route = routes.find(r => r.kind === 'exact'
      ? r.path === pathname
      : pathname === r.path || pathname.startsWith(r.path + '/'))
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    void route.handler(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
}

async function rawCall(
  method: string,
  path: string,
  opts: { body?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: string; headers: Record<string, unknown> }> {
  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = { connection: 'close', ...opts.headers }
    if (opts.body !== undefined) {
      headers['content-length'] = String(opts.body.length)
    }
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(raw) as Record<string, unknown> } catch { /* binary payload */ }
        resolve({ status: response.statusCode ?? 0, body, raw, headers: response.headers })
      })
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

async function uploadPng(filename = 'wallpaper.png'): Promise<{ status: number; body: Record<string, unknown> }> {
  const boundary = 'dsh-image-boundary-' + Date.now()
  const body = multipart(boundary, filename, PNG_1X1, 'image/png')
  return await rawCall('POST', IMAGE_API_PREFIX + '/upload', {
    body,
    headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-image-'))
  uploads = join(root, 'uploads')
})

afterEach(async () => {
  await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve() })
  rmSync(root, { recursive: true, force: true })
})

describe('makeImageRoutes', () => {
  it('accepts a PNG upload, persists it and returns the browser descriptor', async () => {
    await serve(makeImageRoutes({ uploadsDir: uploads }))
    const { status, body } = await uploadPng('ocean.png')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const wallpaper = body.wallpaper as Record<string, unknown>
    expect(typeof wallpaper.id).toBe('string')
    expect((wallpaper.id as string).startsWith('upload/')).toBe(true)
    expect(wallpaper.type).toBe('image')
    expect(wallpaper.source).toBe('uploaded')
    expect(wallpaper.previewUrl).toMatch(/^\/api\/skin-center\/image\/file\//)
    const name = (wallpaper.id as string).slice('upload/'.length)
    expect(existsSync(join(uploads, name))).toBe(true)
    expect(readFileSync(join(uploads, name))).toEqual(PNG_1X1)
  })

  it('lists uploaded images newest-first with the wallpaper contract', async () => {
    await serve(makeImageRoutes({ uploadsDir: uploads }))
    await uploadPng('a.png')
    const { status, body } = await rawCall('GET', IMAGE_API_PREFIX + '/list')
    expect(status).toBe(200)
    const images = body.images as Array<Record<string, unknown>>
    expect(images).toHaveLength(1)
    expect(images[0]!.source).toBe('uploaded')
    expect(images[0]!.previewUrl).toContain('/api/skin-center/image/file/')
  })

  it('serves the uploaded file with an image content type', async () => {
    await serve(makeImageRoutes({ uploadsDir: uploads }))
    const uploaded = await uploadPng()
    const name = (uploaded.body.wallpaper as Record<string, unknown>).id as string
    const { status, headers, raw } = await rawCall('GET', IMAGE_API_PREFIX + '/file/' + encodeURIComponent(name.slice('upload/'.length)))
    expect(status).toBe(200)
    expect(headers['content-type']).toMatch(/image\/png/)
    // The raw response carries the original bytes.
    expect(Buffer.from(raw, 'latin1').length).toBeGreaterThan(0)
  })

  it('rejects non-image magic bytes even with a .png name', async () => {
    await serve(makeImageRoutes({ uploadsDir: uploads }))
    const boundary = 'b-' + Date.now()
    const body = multipart(boundary, 'fake.png', Buffer.from('this is not a png at all', 'utf8'), 'image/png')
    const { status, body: payload } = await rawCall('POST', IMAGE_API_PREFIX + '/upload', {
      body,
      headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
    })
    expect(status).toBe(415)
    expect(payload.error).toBe('not-an-image')
  })

  it('rejects unsupported extensions', async () => {
    await serve(makeImageRoutes({ uploadsDir: uploads }))
    const boundary = 'b-' + Date.now()
    const body = multipart(boundary, 'notes.txt', Buffer.from('hello'), 'text/plain')
    const { status, body: payload } = await rawCall('POST', IMAGE_API_PREFIX + '/upload', {
      body,
      headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
    })
    expect(status).toBe(415)
    expect(payload.error).toBe('unsupported-image-type')
  })

  it('blocks path traversal on the file route', async () => {
    await serve(makeImageRoutes({ uploadsDir: uploads }))
    const escape = await rawCall('GET', IMAGE_API_PREFIX + '/file/..%2F..%2Fsecret.png')
    expect([400, 404]).toContain(escape.status)
    expect(escape.body.error).toBeTruthy()
  })

  it('deletes an uploaded image and answers 404 for a second delete', async () => {
    await serve(makeImageRoutes({ uploadsDir: uploads }))
    const uploaded = await uploadPng()
    const name = (uploaded.body.wallpaper as Record<string, unknown>).id as string
    const file = IMAGE_API_PREFIX + '/file/' + encodeURIComponent(name.slice('upload/'.length))
    const del = await rawCall('DELETE', file)
    expect(del.status).toBe(200)
    expect(del.body.ok).toBe(true)
    expect(existsSync(join(uploads, name.slice('upload/'.length)))).toBe(false)
    const again = await rawCall('DELETE', file)
    expect(again.status).toBe(404)
  })

  it('rejects cross-site uploads through the same-origin fence', async () => {
    await serve(makeImageRoutes({ uploadsDir: uploads }))
    const boundary = 'b-' + Date.now()
    const body = multipart(boundary, 'x.png', PNG_1X1, 'image/png')
    const { status, body: payload } = await rawCall('POST', IMAGE_API_PREFIX + '/upload', {
      body,
      headers: {
        'content-type': 'multipart/form-data; boundary=' + boundary,
        'sec-fetch-site': 'cross-site',
      },
    })
    expect(status).toBe(403)
    expect(payload.error).toBe('cross-site-request-rejected')
  })
})

describe('WE inventory integration', () => {
  it('joins uploaded images into the wallpaper inventory', async () => {
    await serve([
      ...makeImageRoutes({ uploadsDir: uploads }),
      ...makeWeRoutes({ getConfig: () => ({ weLibraryDirs: [] }), storeDir: join(root, 'wallpapers'), autoDetect: false, uploadsDir: uploads }),
    ])
    await uploadPng('aurora.png')
    const { status, body } = await rawCall('GET', WE_API_PREFIX + '/inventory')
    expect(status).toBe(200)
    const wallpapers = body.wallpapers as Array<Record<string, unknown>>
    expect(wallpapers.some(w => w.source === 'uploaded' && w.type === 'image')).toBe(true)
  })
})
