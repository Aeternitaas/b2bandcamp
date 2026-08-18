/**
 * Injected on every bandcamp.com page.
 *
 * All UI here lives inside one shadow-DOM root appended to <body>, entirely
 * separate from Bandcamp's own DOM and stylesheets. Two reasons: Bandcamp's
 * album/track/wishlist pages are a mix of classic server-rendered markup and
 * newer client-rendered ones, so there is no single set of CSS classes that
 * would reliably match a link's "add" button across all of them — and
 * whatever selectors do match today are outside our control and could change
 * on Bandcamp's next redesign. Detecting releases by *link shape* instead
 * (an <a href> pointing at an /album/ or /track/ page) is far more stable
 * than depending on any particular class name, and never touches Bandcamp's
 * own nodes, so there is nothing here that can break the page under it.
 */

(() => {
  const RELEASE_LINK_RE = /^\/(album|track)\/[^/?#]+/;

  /** Every bandcamp.com/track/track-slug or /album/album-slug link found on
   *  the page so far, keyed by absolute URL, so a link that appears more
   *  than once (a grid item's art and its title, say) is only handled once. */
  const seen = new WeakSet();

  // ---------- messaging ----------

  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response) {
          reject(new Error('No response from the extension background script.'));
        } else if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.result);
        }
      });
    });
  }

  // ---------- shadow root & shared styles ----------

  const host = document.createElement('div');
  host.id = 'b2bandcamp-extension-root';
  // Fixed at the very end of <body> and given the shadow root below, so
  // nothing about Bandcamp's own layout (position, overflow, z-index,
  // transforms on ancestors) can clip or displace what is inside it.
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .badge, .fab, .panel { pointer-events: auto; }

    .badge {
      position: absolute;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #14181d;
      color: #33c6e8;
      border: 1px solid #33c6e8;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 15px;
      font-weight: 700;
      line-height: 1;
      box-shadow: 0 2px 8px rgba(0,0,0,.4);
      transition: transform .1s ease;
    }
    .badge:hover { transform: scale(1.12); }
    .badge.done { color: #59d99b; border-color: #59d99b; }

    .fab {
      position: fixed;
      right: 20px;
      bottom: 20px;
      padding: 10px 16px;
      border-radius: 999px;
      background: #33c6e8;
      color: #06282f;
      font-weight: 700;
      border: none;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0,0,0,.4);
    }
    .fab:hover { filter: brightness(1.05); }

    .panel {
      position: fixed;
      width: 320px;
      max-height: 70vh;
      overflow-y: auto;
      background: #14181d;
      color: #e7eef5;
      border: 1px solid #262f3a;
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0,0,0,.55);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .panel h2 { margin: 0; font-size: 14px; }
    .panel .sub { color: #8c99a8; font-size: 12px; margin: -4px 0 4px; }
    .panel select, .panel input {
      width: 100%;
      padding: 7px 8px;
      background: #1b2129;
      border: 1px solid #262f3a;
      border-radius: 6px;
      color: #e7eef5;
      font-size: 12.5px;
    }
    .panel button {
      padding: 7px 10px;
      background: #1b2129;
      border: 1px solid #262f3a;
      border-radius: 6px;
      color: #e7eef5;
      cursor: pointer;
      font-size: 12.5px;
      text-align: left;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .panel button:hover { border-color: #33c6e8; }
    .panel button.primary { background: #33c6e8; color: #06282f; border-color: transparent; font-weight: 600; justify-content: center; }
    .panel button.close { align-self: flex-end; background: none; border: none; color: #5d6874; padding: 0 4px; }
    .track-row { display: flex; align-items: center; gap: 6px; }
    .track-row .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track-row .dur { color: #5d6874; font-size: 11px; }
    .error { color: #f2616b; font-size: 12px; }
    .empty { color: #8c99a8; font-size: 12px; }
    .spin {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid #262f3a; border-top-color: #33c6e8;
      animation: b2b-spin 0.7s linear infinite;
    }
    @keyframes b2b-spin { to { transform: rotate(360deg); } }
  `;
  root.appendChild(style);

  const layer = document.createElement('div');
  layer.className = 'layer';
  root.appendChild(layer);

  // ---------- the add-to-playlist panel ----------

  /** Remembers the last playlist picked, so repeat use (adding several
   *  tracks from one browsing session) does not require reselecting it. */
  const LAST_PLAYLIST_KEY = 'b2bandcamp:lastPlaylistId';

  let closeActivePanel = null;

  /**
   * Opens the add-to-playlist panel anchored near (x, y) — the click that
   * triggered it. `release` is either a resolved Tralbum (already fetched)
   * or a function returning one, so the panel can show a loading state
   * while the badge that opened it is still resolving.
   */
  async function openPanel(x, y, loadRelease) {
    closeActivePanel?.();

    const panel = document.createElement('div');
    panel.className = 'panel';
    // Clamped so the panel never renders partly off-screen, the same
    // reasoning as the web app's own hover-menu fix: compute from the
    // viewport, not from wherever the trigger happens to sit.
    const width = 320;
    panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 200))}px`;
    layer.appendChild(panel);

    const onDocPointerDown = e => {
      if (!panel.contains(e.composedPath()[0])) close();
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);

    function close() {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      panel.remove();
      if (closeActivePanel === close) closeActivePanel = null;
    }
    closeActivePanel = close;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', close);
    panel.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'spin';
    panel.appendChild(body);

    let playlists;
    let release;
    try {
      [playlists, release] = await Promise.all([send('listPlaylists'), loadRelease()]);
    } catch (err) {
      body.replaceWith(errorNode(err.message));
      return;
    }

    body.remove();
    renderPanel(panel, playlists, release, close);

    // The panel's real height depends on the track list just rendered, which
    // was not known when it was first positioned — an album with a lot of
    // tracks can run past the bottom of the screen even though the panel's
    // own max-height/overflow keeps any *single* panel from growing past
    // 70vh. Shift it up (never down) if it does.
    const rect = panel.getBoundingClientRect();
    const overflowBy = rect.bottom - (window.innerHeight - 8);
    if (overflowBy > 0) {
      panel.style.top = `${Math.max(8, rect.top - overflowBy)}px`;
    }
  }

  function errorNode(message) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = message;
    return p;
  }

  function renderPanel(panel, playlists, release, close) {
    const title = document.createElement('h2');
    title.textContent = release.title;
    panel.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = release.artist;
    panel.appendChild(sub);

    if (playlists.length === 0) {
      panel.appendChild(Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent: 'No playlists yet — create one in b2bandcamp first.'
      }));
      return;
    }

    const select = document.createElement('select');
    for (const p of playlists) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.title;
      select.appendChild(opt);
    }
    chrome.storage.local.get(LAST_PLAYLIST_KEY).then(({ [LAST_PLAYLIST_KEY]: last }) => {
      if (last && playlists.some(p => String(p.id) === String(last))) select.value = String(last);
    });
    select.addEventListener('change', () => {
      chrome.storage.local.set({ [LAST_PLAYLIST_KEY]: select.value });
    });
    panel.appendChild(select);

    const status = document.createElement('p');
    status.className = 'sub';
    panel.appendChild(status);

    const setStatus = (text, isError) => {
      status.textContent = text;
      status.className = isError ? 'error' : 'sub';
    };

    const streamable = release.tracks.filter(t => t.streamable);

    if (release.type === 'a') {
      const addAll = document.createElement('button');
      addAll.className = 'primary';
      addAll.textContent = `Add whole album (${streamable.length})`;
      addAll.addEventListener('click', async () => {
        addAll.disabled = true;
        try {
          await send('addByUrl', { playlistId: Number(select.value), url: release.url });
          setStatus('Added the whole album.');
        } catch (err) {
          setStatus(err.message, true);
        } finally {
          addAll.disabled = false;
        }
      });
      panel.appendChild(addAll);

      for (const t of release.tracks) {
        const row = document.createElement('div');
        row.className = 'track-row';

        const name = document.createElement('span');
        name.className = 'title';
        name.textContent = t.title;
        row.appendChild(name);

        if (!t.streamable) {
          const dur = document.createElement('span');
          dur.className = 'dur';
          dur.textContent = 'not streamable';
          row.appendChild(dur);
        } else {
          const dur = document.createElement('span');
          dur.className = 'dur';
          dur.textContent = formatDuration(t.duration);
          row.appendChild(dur);

          const add = document.createElement('button');
          add.textContent = '+';
          add.title = `Add ${t.title}`;
          add.addEventListener('click', async () => {
            add.disabled = true;
            try {
              await send('addTrack', {
                playlistId: Number(select.value), type: 't', id: t.track_id, bandId: t.band_id
              });
              add.textContent = '✓';
            } catch (err) {
              setStatus(err.message, true);
              add.disabled = false;
            }
          });
          row.appendChild(add);
        }
        panel.appendChild(row);
      }
    } else {
      const addOne = document.createElement('button');
      addOne.className = 'primary';
      addOne.textContent = 'Add track';
      addOne.disabled = streamable.length === 0;
      addOne.addEventListener('click', async () => {
        addOne.disabled = true;
        try {
          await send('addByUrl', { playlistId: Number(select.value), url: release.url });
          setStatus('Added.');
        } catch (err) {
          setStatus(err.message, true);
          addOne.disabled = false;
        }
      });
      panel.appendChild(addOne);
    }
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---------- link discovery ----------

  /** True for an <a> whose href resolves to a Bandcamp album or track page,
   *  on any subdomain (an artist's own site included). */
  function releaseHref(anchor) {
    let url;
    try {
      url = new URL(anchor.href, location.href);
    } catch {
      return null;
    }
    if (!/(^|\.)bandcamp\.com$/.test(url.hostname)) return null;
    if (!RELEASE_LINK_RE.test(url.pathname)) return null;
    return url.href;
  }

  function attachBadge(anchor, href) {
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = '+';
    badge.title = 'Add to a b2bandcamp playlist';
    layer.appendChild(badge);

    const reposition = () => {
      const rect = anchor.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        badge.style.display = 'none';
        return;
      }
      badge.style.display = 'flex';
      badge.style.left = `${rect.right - 10}px`;
      badge.style.top = `${rect.top - 10}px`;
    };
    reposition();

    // Anchors move constantly on Bandcamp's own infinite-scroll and
    // client-rendered grids — cheap to recompute, so just always do it.
    const interval = setInterval(reposition, 400);

    badge.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      openPanel(e.clientX, e.clientY, () => send('resolveUrl', { url: href }))
        .then(() => badge.classList.add('done'))
        .catch(() => {});
    });

    // If the anchor itself is ever removed (grid re-rendered), stop
    // polling and remove the now-orphaned badge instead of leaking both.
    new MutationObserver(() => {
      if (!document.contains(anchor)) {
        clearInterval(interval);
        badge.remove();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function scanForReleaseLinks() {
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (seen.has(anchor)) continue;
      const href = releaseHref(anchor);
      if (!href) continue;
      seen.add(anchor);
      attachBadge(anchor, href);
    }
  }

  // ---------- the single-release floating button ----------

  function isReleasePage() {
    return RELEASE_LINK_RE.test(location.pathname);
  }

  function addFab() {
    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.textContent = isReleasePage() ? '+ Add to playlist' : '+ b2bandcamp';
    layer.appendChild(fab);

    fab.addEventListener('click', e => {
      const rect = fab.getBoundingClientRect();
      const x = rect.left - 320 + rect.width;
      const y = rect.top - 8;
      const url = isReleasePage() ? location.href : promptForUrl();
      if (!url) return;
      openPanel(Math.max(8, x), Math.max(8, y - 260), () => send('resolveUrl', { url }))
        .catch(() => {});
    });
  }

  /** Off a grid/browse page (Discover, a tag page, a feed) there is no
   *  single release the button obviously means — ask for a link instead of
   *  guessing at one. Browsing-and-picking on those pages is what the small
   *  per-item "+" badges from scanForReleaseLinks are for; this covers the
   *  case where none matched (a page layout the link-shape heuristic missed). */
  function promptForUrl() {
    const url = window.prompt('Paste a Bandcamp album or track link to add:');
    return url?.trim() || null;
  }

  // ---------- boot ----------

  async function main() {
    const status = await send('getStatus').catch(() => ({ linked: false }));
    if (!status.linked) return; // nothing to do until the popup is used to link an instance

    addFab();
    scanForReleaseLinks();

    // Bandcamp's grids (wishlist, discover, an artist's discography) load
    // and re-render content well after the initial page load.
    new MutationObserver(() => scanForReleaseLinks())
      .observe(document.body, { childList: true, subtree: true });
  }

  main();
})();
