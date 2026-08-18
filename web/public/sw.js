/*
 * Service worker for b2bandcamp.
 *
 * Deliberately conservative: it makes the app installable and lets the shell
 * open offline, but it never caches API responses or audio. Playlist data is
 * collaborative and stream URLs are signed and short-lived, so serving either
 * from a cache would show stale state or play back broken URLs.
 */

const VERSION = 'v1'
const SHELL_CACHE = `b2bandcamp-shell-${VERSION}`
const ASSET_CACHE = `b2bandcamp-assets-${VERSION}`

const SHELL_URLS = ['/', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Same-origin only; Bandcamp art and audio go straight to the network.
  if (url.origin !== self.location.origin) return

  // Never intercept the API, including the stream redirect endpoint.
  if (url.pathname.startsWith('/api/')) return

  // Navigations: network first so deploys are picked up, cached shell as the
  // offline fallback. The SPA handles routing once the shell loads.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy)).catch(() => {})
          return response
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error())),
    )
    return
  }

  // Fingerprinted build output: cache first, it can never go stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      })),
    )
  }
})
