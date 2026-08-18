/**
 * Background service worker.
 *
 * Every network call to the linked b2bandcamp instance goes through here,
 * never through the content script directly. Two reasons: a self-hosted
 * instance can be on any domain, and only a privileged extension context
 * (background, popup) with a granted host permission can fetch cross-origin
 * without running into the page's own CORS/CSP, a content script's fetches
 * run in the *page's* origin and would be blocked exactly like any other
 * cross-site request from bandcamp.com. See docs/API.md for the HTTP side
 * of this contract.
 */

const STORAGE_KEY = 'b2bandcamp';

/** @returns {Promise<{instanceUrl: string, token: string, tokenId: number, label: string} | null>} */
async function getLink() {
  const { [STORAGE_KEY]: link } = await chrome.storage.local.get(STORAGE_KEY);
  return link ?? null;
}

async function setLink(link) {
  await chrome.storage.local.set({ [STORAGE_KEY]: link });
}

async function clearLink() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * Normalises whatever the user typed ("b2b.example.com", "example.com/",
 * "http://example.com") into a bare origin the rest of the code can safely
 * concatenate a path onto.
 */
function normalizeInstanceUrl(input) {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  return url.origin;
}

/**
 * Whether the extension currently holds the runtime host permission for
 * this origin. This service worker can only check, it cannot request:
 * chrome.permissions.request() requires an active user gesture, and a
 * background service worker has no window/document and so never has one,
 * no matter how directly a click in the popup triggered this call. The
 * popup calls chrome.permissions.request() itself, synchronously within
 * its click handler, before sending the "ping" or "login" message.
 */
async function hasOriginPermission(origin) {
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

class APIError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Calls one JSON endpoint on the linked instance. Throws APIError with the
 * server's own message on a non-2xx response, and a plain Error (no status)
 * when there is no linked instance at all, callers use that distinction to
 * tell "not logged in" apart from "the server rejected this."
 */
async function apiFetch(path, options = {}) {
  const link = await getLink();
  if (!link) throw new Error('Not linked to a b2bandcamp instance yet.');

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${link.token}`);
  if (options.body) headers.set('Content-Type', 'application/json');

  const res = await fetch(`${link.instanceUrl}${path}`, { ...options, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new APIError(res.status, data?.error || `request failed (${res.status})`);
  }
  return data;
}

// ---------- message handlers ----------
// Every content script and popup call funnels through one of these. Keys
// match the `type` field of the message; see content/inject.js and
// popup/popup.js for the calling side.

const handlers = {
  async getStatus() {
    const link = await getLink();
    if (!link) return { linked: false };
    return { linked: true, instanceUrl: link.instanceUrl, label: link.label };
  },

  /** Step 1 of linking: verify the instance actually responds before asking
   *  for a permission grant or credentials. */
  async ping({ instanceUrl }) {
    const origin = normalizeInstanceUrl(instanceUrl);
    if (!(await hasOriginPermission(origin))) {
      throw new Error('Permission to reach that site was not granted.');
    }
    const res = await fetch(`${origin}/api/health`);
    if (!res.ok) throw new Error(`That instance responded with ${res.status}.`);
    return { origin };
  },

  /** Step 2: exchange credentials for a token, and remember the instance. */
  async login({ instanceUrl, login, password }) {
    const origin = normalizeInstanceUrl(instanceUrl);
    if (!(await hasOriginPermission(origin))) {
      throw new Error('Permission to reach that site was not granted.');
    }

    const res = await fetch(`${origin}/api/auth/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password, label: 'Chrome extension' })
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new APIError(res.status, data?.error || 'sign-in failed');

    await setLink({ instanceUrl: origin, token: data.token, tokenId: data.id, label: data.label });
    return { instanceUrl: origin, label: data.label };
  },

  /** Best-effort revoke on the server, then forget the instance either way,
   *  a network error here should not leave the user stuck "logged in" to a
   *  extension that no longer has a usable token. */
  async logout() {
    const link = await getLink();
    if (link) {
      try {
        await apiFetch(`/api/account/tokens/${link.tokenId}`, { method: 'DELETE' });
      } catch {
        // ignored, clearing the local copy is what actually matters
      }
    }
    await clearLink();
    return { ok: true };
  },

  /** Playlists the signed-in user can add tracks to: owns, or collaborates on. */
  async listPlaylists() {
    const data = await apiFetch('/api/playlists');
    return (data.playlists || []).filter(p => p.role === 'owner' || p.role === 'collaborator');
  },

  async createPlaylist({ title }) {
    return apiFetch('/api/playlists', { method: 'POST', body: JSON.stringify({ title }) });
  },

  /** Full detail for one Bandcamp release, art, title, artist, and every
   *  track with its own streamable/duration/art, used for both the "is this
   *  a track or an album" check and the Discover overlay's track browser. */
  async resolveUrl({ url }) {
    return apiFetch('/api/bc/resolve', { method: 'POST', body: JSON.stringify({ url }) });
  },

  async addByUrl({ playlistId, url }) {
    return apiFetch(`/api/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ url })
    });
  },

  async addTrack({ playlistId, type, id, bandId }) {
    return apiFetch(`/api/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ type, id, band_id: bandId }] })
    });
  },

  /** The stream endpoint needs no auth (see docs/API.md), so the content
   *  script can point an <audio> element at it directly, this just hands
   *  back the full URL, no fetch, since only the instance URL is secret. */
  async streamUrl({ trackId, bandId }) {
    const link = await getLink();
    if (!link) throw new Error('Not linked to a b2bandcamp instance yet.');
    return `${link.instanceUrl}/api/bc/stream/${trackId}?band_id=${bandId}`;
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ error: `Unknown message type "${message?.type}"` });
    return;
  }

  handler(message)
    .then(result => sendResponse({ result }))
    .catch(err => sendResponse({ error: err.message, status: err.status }));

  // Tells Chrome the response is coming asynchronously, from the .then above.
  return true;
});
