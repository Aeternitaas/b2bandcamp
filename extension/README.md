# b2bandcamp browser extension

Adds a "+ Add to playlist" control to Bandcamp album, track, wishlist, and
discover/browse pages, so a track or album goes straight into one of your
b2bandcamp playlists without leaving Bandcamp.

## Install (unpacked, not published to the Chrome Web Store)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this `extension/` folder.
4. Click the extension's icon in the toolbar.

## Link it to your instance

1. In the popup, enter your b2bandcamp instance's URL (e.g.
   `https://b2b.example.com`) and click **Connect**. Chrome will ask you to
   grant the extension permission to talk to that site, this is expected;
   a self-hosted instance can be on any domain, so the extension has to ask
   at runtime rather than being pre-configured for one.
2. Sign in with your b2bandcamp username/email and password. This does not
   store your password, it exchanges it once for a bearer token (see
   `docs/API.md`) kept in the extension's own local storage, the same way a
   browser keeps you signed into a site without re-entering a password every
   visit.
3. **Sign out** in the popup revokes that token on the server and forgets it
   locally. If you ever lose track of a device or lose faith in one, your
   b2bandcamp instance's **Settings → API tokens** page lists and can revoke
   any token, including this one, without needing the extension at all.

## Using it

- **Album or track page:** a small **+** badge sits just left of the page's
  own title, click it to preview the release (art, title, every track) and
  add the whole thing or pick individual tracks. On an album, every row in
  the track list also gets its own **+** to its left, for adding just that
  one track without opening the release picker.
- **Wishlist, discover, an artist's discography, or any page listing
  releases:** a small **+** badge appears on each album/track link. Same
  picker, scoped to that one item.
- **Previewing an album's tracks:** clicking a track's cover art in the
  picker plays a short preview, click again (or click another track's art)
  to switch or stop it. Moving the pointer off the picker closes it and
  stops playback.
- Playlist choice is remembered between uses in the same browser, so adding
  several tracks in a row does not mean reselecting the target playlist
  each time.

## How it finds things to add

Rather than depending on Bandcamp's own page markup, which differs between
a classic server-rendered artist page and a client-rendered wishlist or
discover page, and which this extension has no control over if Bandcamp
changes it, it looks for the one thing common to all of them: a link whose
address is a Bandcamp album or track page
(`https://*.bandcamp.com/album/...` or `/track/...`). Everything else (art,
title, artist, the full track list) comes from your b2bandcamp instance
resolving that link, the same way pasting a link into the web app's "Add
music" does. The one exception is an album's own track table, old, stable
markup that a long list of Bandcamp tools already rely on, used only to
place each row's badge, not to detect the track itself.

Each badge is planted directly next to the thing it marks (a cell in the
track table, the release link itself elsewhere), rather than floated on top
of it and tracked with polling, so it scrolls exactly with its row or tile
and never lags behind. It still carries its own shadow root, so it is
visually isolated from Bandcamp's styles either way.

The add-to-playlist picker itself lives inside an isolated shadow DOM node
appended to the page, it never modifies Bandcamp's own markup, so there is
nothing here
that can break the page under it.

## Architecture, briefly

- `background.js`, the only thing that talks to your b2bandcamp instance.
  Holds the linked instance URL and token in `chrome.storage.local`.
- `content/inject.js`, runs on every bandcamp.com page; finds release
  links, renders the picker, and asks the background script to do the actual
  API calls (a content script's own fetches run in the *page's* origin and
  would hit the same cross-origin restrictions any other website would).
- `popup/`, the toolbar popup: link an instance, sign in, sign out.

See `../docs/API.md` for the full HTTP API this talks to, useful if you
want to build your own integration instead of using this extension.

## Releasing

`.github/workflows/release-extension.yml` zips this folder and publishes a
GitHub release with the zip attached, ready to unzip and load as an
unpacked extension. Bump `manifest.json`'s `version` and commit it, then
either:

- **Push a matching tag** (`extension-vX.Y.Z`), which triggers the release
  automatically:

  ```
  git tag extension-v1.0.1
  git push origin extension-v1.0.1
  ```

- **Or run it manually**: Actions -> Release extension -> Run workflow, on
  the branch with the version bump. No input needed, it reads the version
  straight from `manifest.json` and creates the tag itself. Don't type a
  tag name into a workflow's manual-run form unless you already pushed that
  exact tag, `actions/checkout` fails trying to fetch a ref that does not
  exist on the remote yet.
