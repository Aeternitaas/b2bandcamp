/**
 * Injected on every bandcamp.com page.
 *
 * The add-to-playlist panel and the "paste a link" FAB live inside one
 * shadow-DOM root appended to <body>, entirely separate from Bandcamp's own
 * DOM and stylesheets, so nothing about that floating UI can be affected by
 * (or bleed into) the page under it.
 *
 * The small per-track "+" badges are different: they are inserted directly
 * next to the track they belong to (a table cell on an album page, the
 * anchor itself on a grid page), each wrapped in its own shadow root for
 * style isolation. Anchoring them into Bandcamp's own layout instead of
 * floating them in a fixed, globally-positioned layer means they scroll
 * exactly with the row/tile they mark, no polling or per-frame repositioning
 * needed, and nothing to lag behind on a fast scroll.
 *
 * Release links are still detected by *link shape* (an <a href> pointing at
 * an /album/ or /track/ page) rather than any particular class name, since
 * that is stable across Bandcamp's mix of classic server-rendered pages and
 * newer client-rendered ones. The one exception is the track table on an
 * album page (#track_table tr.track_row_view), markup old and stable enough
 * that a long list of scraping tools and extensions already depend on it,
 * used here only to find where to insert each row's badge, not to detect the
 * release link itself.
 */

(() => {
  const RELEASE_LINK_RE = /^\/(album|track)\/[^/?#]+/;

  /** Every anchor already given a badge (by any of the paths below), so a
   *  rescan after a DOM mutation does not double up. */
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

  // ---------- shadow root & shared styles (panel + FAB only) ----------

  const host = document.createElement('div');
  host.id = 'b2bandcamp-extension-root';
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
    .fab, .panel { pointer-events: auto; }

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
    .track-row { display: flex; align-items: center; gap: 8px; }
    .track-row .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track-row .dur { color: #5d6874; font-size: 11px; }
    .track-art {
      position: relative;
      width: 32px; height: 32px; flex: none;
      border-radius: 4px;
      background: #1b2129;
      border: none;
      padding: 0;
      cursor: pointer;
      overflow: hidden;
      color: #5d6874;
      display: flex; align-items: center; justify-content: center;
    }
    .track-art:disabled { cursor: default; }
    .track-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .track-art .overlay {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(6,8,10,.35);
      opacity: 0;
      transition: opacity .1s ease;
      color: #fff;
    }
    .track-art:not(:disabled):hover .overlay, .track-row.playing .overlay { opacity: 1; }
    .track-row.playing .track-art { box-shadow: 0 0 0 2px #33c6e8; }
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

  // ---------- track preview audio ----------
  // One shared element: only ever one panel (and so one album track list)
  // open at a time, see closeActivePanel below.

  let previewAudio = null;
  let previewTrackId = null;
  // The current track's own onState, kept so starting a *different* track
  // can reset the row it is replacing, not just set up the new one.
  let previewOnState = null;

  function stopPreview() {
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.removeAttribute('src');
    }
    previewOnState?.(null);
    previewTrackId = null;
    previewOnState = null;
  }

  /** Toggles preview playback for one track, `onState(trackId | null)` is
   *  called whenever the playing track changes (including to null, on stop
   *  or natural end) so the caller can update its own play/pause icons. */
  async function togglePreview(track, onState) {
    if (previewTrackId === track.track_id) {
      stopPreview();
      return;
    }
    previewOnState?.(null); // reset whichever other row was playing, if any
    if (!previewAudio) {
      previewAudio = new Audio();
      previewAudio.addEventListener('ended', () => stopPreview());
    }
    previewTrackId = track.track_id;
    previewOnState = onState;
    try {
      const url = await send('streamUrl', { trackId: track.track_id, bandId: track.band_id });
      previewAudio.src = url;
      onState(track.track_id);
      await previewAudio.play();
    } catch {
      previewTrackId = null;
      previewOnState = null;
      onState(null);
    }
  }

  // ---------- the add-to-playlist panel ----------

  const LAST_PLAYLIST_KEY = 'b2bandcamp:lastPlaylistId';
  const HOVER_CLOSE_DELAY = 150;

  let closeActivePanel = null;

  async function openPanel(x, y, loadRelease) {
    closeActivePanel?.();

    const panel = document.createElement('div');
    panel.className = 'panel';
    const width = 320;
    panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 200))}px`;
    layer.appendChild(panel);

    const onDocPointerDown = e => {
      if (!panel.contains(e.composedPath()[0])) close();
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);

    // Only armed for a release that actually shows a track list to hover
    // (renderPanel turns this on for an album), leaving via edge here
    // means leaving the album's track viewer, close it and stop the preview.
    let hoverCloseTimer = null;
    let hoverCloseArmed = false;
    const cancelHoverClose = () => {
      if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
    };
    const scheduleHoverClose = () => {
      if (!hoverCloseArmed) return;
      cancelHoverClose();
      hoverCloseTimer = setTimeout(close, HOVER_CLOSE_DELAY);
    };
    panel.addEventListener('pointerenter', cancelHoverClose);
    panel.addEventListener('pointerleave', scheduleHoverClose);

    function close() {
      cancelHoverClose();
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      stopPreview();
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
    hoverCloseArmed = renderPanel(panel, playlists, release, close);

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

  /** Renders the panel body; returns whether it should now close when the
   *  pointer leaves it (true only for an album's track list, see openPanel). */
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
        textContent: 'No playlists yet, create one in b2bandcamp first.'
      }));
      return false;
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

        const art = document.createElement('button');
        art.className = 'track-art';
        art.disabled = !t.streamable;
        art.title = t.streamable ? 'Preview, click again to stop' : 'Not streamable';
        const artURL = t.art_url || release.art_url;
        if (artURL) {
          const img = document.createElement('img');
          img.src = artURL;
          img.alt = '';
          img.loading = 'lazy';
          art.appendChild(img);
        } else {
          art.appendChild(musicGlyph());
        }
        const overlay = document.createElement('span');
        overlay.className = 'overlay';
        overlay.appendChild(playPauseGlyph(false));
        art.appendChild(overlay);
        if (t.streamable) {
          art.addEventListener('click', () => togglePreview(t, playingId => {
            const isPlaying = playingId === t.track_id;
            row.classList.toggle('playing', isPlaying);
            overlay.replaceChildren(playPauseGlyph(isPlaying));
          }));
        }
        row.appendChild(art);

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
      return true;
    }

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
    return false;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Small inline SVGs, Feather Icons (MIT licensed, https://feathericons.com),
  // matching the icon set the b2bandcamp web app itself uses.
  function svg(inner, filled) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', '14');
    el.setAttribute('height', '14');
    el.setAttribute('fill', filled ? 'currentColor' : 'none');
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.innerHTML = inner;
    return el;
  }
  function musicGlyph() {
    return svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', false);
  }
  function playPauseGlyph(playing) {
    return playing
      ? svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>', true)
      : svg('<polygon points="5 3 19 12 5 21 5 3"/>', true);
  }

  // ---------- release-link detection ----------

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

  function isReleasePage() {
    return RELEASE_LINK_RE.test(location.pathname);
  }

  // ---------- badges ----------

  /**
   * Builds one "+" badge, isolated in its own shadow root so neither
   * Bandcamp's page styles nor ours can bleed across the boundary, sized to
   * exactly fill whatever box the caller places it in (`size` in CSS px).
   * The caller is responsible for positioning the returned host element,
   * this only builds and wires the control itself.
   */
  function makeBadge(href, size) {
    const badgeHost = document.createElement('span');
    badgeHost.style.cssText = `all: initial; display: block; width: ${size}px; height: ${size}px;`;
    const sh = badgeHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .b {
        width: 100%; height: 100%;
        border-radius: 50%;
        background: #14181d;
        color: #33c6e8;
        border: 1px solid #33c6e8;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font: 700 ${Math.round(size * 0.68)}px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 1px 4px rgba(0,0,0,.4);
        transition: transform .1s ease;
      }
      .b:hover { transform: scale(1.12); }
      .b.done { color: #59d99b; border-color: #59d99b; }
    `;
    sh.appendChild(style);
    const badge = document.createElement('div');
    badge.className = 'b';
    badge.textContent = '+';
    badge.title = 'Add to a b2bandcamp playlist';
    sh.appendChild(badge);

    badge.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const rect = badgeHost.getBoundingClientRect();
      openPanel(rect.right, rect.top, () => send('resolveUrl', { url: href }))
        .then(() => badge.classList.add('done'))
        .catch(() => {});
    });

    return badgeHost;
  }

  /**
   * Every #track_table row (an album page) gets its own badge in a new
   * leading table cell, a real table column rather than anything overlaid,
   * so it takes part in the row's own layout and scrolls with it for free,
   * and can never run past the table's own left edge.
   */
  function decorateTrackTable() {
    const table = document.querySelector('#track_table');
    if (!table) return;
    for (const row of table.querySelectorAll('tr.track_row_view')) {
      if (row.dataset.b2bDone) continue;
      const anchor = row.querySelector('td.title-col a[href]');
      const href = anchor && releaseHref(anchor);
      if (!href) continue;
      row.dataset.b2bDone = '1';
      // A row's title, info, and download links all point at this same
      // track, one badge for the row is enough, the generic scan below
      // must not also badge the other two.
      for (const a of row.querySelectorAll('a[href]')) seen.add(a);

      const cell = document.createElement('td');
      cell.style.cssText = 'width: 26px; padding: 0 4px 0 0; text-align: center; vertical-align: middle;';
      cell.appendChild(makeBadge(href, 20));
      row.insertBefore(cell, row.firstElementChild);
    }
  }

  /**
   * The album/track page heading (#name-section), present on both, gets one
   * badge for the release as a whole: the album itself, or the page's own
   * track. A standalone track page has no self-link to badge (you are
   * already on that track's page), this is that page's only way in, and it
   * replaces the old floating "+ Add to playlist" button for both page
   * types, the per-row badges above now cover picking an individual track.
   */
  function decorateNameSection() {
    if (!isReleasePage()) return;
    const heading = document.querySelector('#name-section h2.trackTitle');
    if (!heading || heading.dataset.b2bDone) return;
    heading.dataset.b2bDone = '1';

    if (getComputedStyle(heading).position === 'static') heading.style.position = 'relative';
    const badgeHost = makeBadge(location.href, 22);
    badgeHost.style.cssText += 'position: absolute; top: 2px; left: -30px;';
    heading.appendChild(badgeHost);
  }

  /**
   * Everywhere else a release link turns up (Discover, a fan's wishlist, an
   * artist's discography grid, a tag page): the badge is appended straight
   * into the anchor itself, so it inherits the anchor's own position in the
   * page and scrolls with it exactly, no tracking needed. Bandcamp's own
   * client-rendered grids are unstable enough that this, anchoring to
   * whatever element we already know encloses the release, is more robust
   * than trying to name a specific "card" container for each layout.
   */
  function attachInlineBadge(anchor, href) {
    if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
    const badgeHost = makeBadge(href, 22);
    badgeHost.style.cssText += 'position: absolute; top: 6px; right: 6px; z-index: 1;';
    anchor.appendChild(badgeHost);
  }

  function scanForReleaseLinks() {
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (seen.has(anchor)) continue;
      const href = releaseHref(anchor);
      if (!href) continue;
      seen.add(anchor);
      attachInlineBadge(anchor, href);
    }
  }

  // ---------- the "paste a link" floating button ----------
  // Only needed off a release page: on an album or track page the name
  // section's own badge above already covers adding that page's release.

  function addFab() {
    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.textContent = '+ b2bandcamp';
    layer.appendChild(fab);

    fab.addEventListener('click', () => {
      const url = promptForUrl();
      if (!url) return;
      const rect = fab.getBoundingClientRect();
      openPanel(Math.max(8, rect.left - 320 + rect.width), Math.max(8, rect.top - 268), () => send('resolveUrl', { url }))
        .catch(() => {});
    });
  }

  function promptForUrl() {
    const url = window.prompt('Paste a Bandcamp album or track link to add:');
    return url?.trim() || null;
  }

  // ---------- boot ----------

  async function main() {
    const status = await send('getStatus').catch(() => ({ linked: false }));
    if (!status.linked) return; // nothing to do until the popup is used to link an instance

    if (!isReleasePage()) addFab();
    decorateTrackTable();
    decorateNameSection();
    scanForReleaseLinks();

    // Bandcamp's grids (wishlist, discover, an artist's discography) load
    // and re-render content well after the initial page load; each of these
    // is a no-op past its first successful pass over anything already done.
    new MutationObserver(() => {
      decorateTrackTable();
      decorateNameSection();
      scanForReleaseLinks();
    }).observe(document.body, { childList: true, subtree: true });
  }

  main();
})();
