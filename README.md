# Synology Audio Station Media Keys

Enables Previous/Next in the Windows System Media Transport Controls
(the popup that appears when you press a media key) for Audio Station
at `http://192.168.20.101/audio/`.

Previous/Next were greyed out because the page never tells Windows
those actions exist; this extension tells it for them. Default Play/Pause functionality is overwritten also.

It also lets you rate the currently playing track by pressing the
number keys **1-5** (1 = one star, ... 5 = five stars) anywhere on the
page, as long as you're not typing in a text field.

## Install (unpacked, Edge)

1. Go to `edge://extensions`
2. Turn on **Developer mode** (toggle, bottom-left)
3. Click **Load unpacked**
4. Select this folder (`synology-media-keys`)
5. Reload the Audio Station tab

Press a media key once (or press Play/Pause) so Windows' overlay
picks up the tab as the active media session — Previous/Next should
no longer be greyed out.

## How it works

`content.js` runs in the page's **main JS world** (`"world": "MAIN"`
in the manifest) so it shares the exact same `navigator.mediaSession`
object as Audio Station's own script — not a separate isolated-world
copy.

1. **Registers `previoustrack`/`nexttrack` handlers** that click the
   real `<button>` elements (`.player-prev button`, `.player-next
   button`), and **patches `setActionHandler`** so Audio Station's own
   script can't clear or replace those two handlers later.

   Play/Pause is left to Chromium's built-in default (calling
   `.play()`/`.pause()` on the page's media element directly). An
   explicit handler was tried twice and reverted both times — most
   recently it caused an asymmetry where hardware pause worked but
   play didn't, which turned out to be entangled with the playing/paused
   detection bug below rather than a real reason to own the action.
   Sticking with the default for now.

2. **Mirrors real playback state, partially**: reads `style.visibility`
   on `.syno-as-player-song-info` (Audio Station's own now-playing info
   block) and, if nothing is loaded, sets
   `navigator.mediaSession.playbackState = "none"`. This matters more
   than it sounds — if `playbackState` stays at `"none"` forever
   (which it does by default, since nothing sets it otherwise), Windows
   greys out the transport controls even though action handlers are
   correctly registered.

   Deliberately never explicitly sets `"playing"` (or `"paused"`).
   Chromium appears to auto-infer playing/paused from the real
   (detached) media element on its own as long as the page never
   touches `playbackState` — which is why play/pause worked with zero
   effort before this extension existed. Explicitly asserting
   `"playing"` was tried and took over that field from the browser;
   since nothing then asserted `"paused"` (every detection method
   tried — the underlying media element, then the play/pause button's
   class — turned out unreliable), the value stayed pinned at
   `"playing"` even while genuinely paused, silently breaking resuming
   via hardware/OS controls (pause worked, play/resume didn't). Only
   ever setting `"none"` avoids fighting the browser's inference in the
   other direction — though this means if the page goes truly idle,
   there's currently no code path that explicitly moves it back out of
   `"none"` once a track loads again; that's an open question still
   being tested.

   The `"none"` transition is debounced by ~2s: `song-info` briefly
   goes to `visibility: hidden` (around 300ms typically, but real-world
   next-track latency to the NAS can occasionally run longer) while
   Audio Station swaps to the next/previous track even though playback
   never really stops, so committing to `"none"` too eagerly caused the
   Windows overlay to disappear entirely on some `next` presses rather
   than just missing a metadata update.

   Earlier versions tried to derive this from the underlying
   `<audio>`/`<video>` element instead (listening for
   play/pause/ended, patching `Audio()`/`document.createElement` to
   catch elements Audio Station never attaches to the document). That
   worked but was a lot of surface area for something two small UI
   reads accomplish just as well, so it was replaced.

3. **Keeps metadata populated**: reads the title/artist and cover art
   from Audio Station's own now-playing display and sets
   `navigator.mediaSession.metadata`. Re-checks on either the title
   text changing or the artwork `<img>`'s `src` changing — tracking
   both separately matters because the cover image URL
   (`cover.cgi?...method=getsongcover...`) comes from its own server
   round-trip that can resolve *after* the title's already updated;
   gating on title alone left metadata pinned to whichever artwork
   happened to be loaded at that exact moment (usually the previous
   track's). Updated immediately via a `MutationObserver` on the page
   whenever the relevant DOM changes (title text, or `style`/`src`
   attributes) — this covers hardware next/prev, UI clicks, and
   auto-advance to the next track alike, rather than waiting for the
   next periodic/focus/visibility refresh, which could lag up to 15
   seconds behind a track change.

4. **Rates the current track from the keyboard**: listens for keydown
   on `1`-`5` and dispatches a synthetic mouse click sequence
   (`mouseover`/`mousedown`/`mouseup`/`click`) on the matching star in
   the `.syno-song-rating-container` widget, the same widget Audio
   Station itself renders for the now-playing track. Ignored while
   focus is in a text input/textarea/contenteditable, and while any
   modifier key is held, so it doesn't interfere with normal typing or
   OS shortcuts. If more than one rating widget is present on the page
   (e.g. also inline in a song list row), it prefers the one nested
   inside the player bar.

   You may see a harmless console error here —
   `Cannot read properties of null (reading 'addClass')` in
   `applyAvgRatingAndDisplay`, from Audio Station's own
   `onGridRowClick` handler getting triggered by the click bubbling up
   (it assumes real grid-row context this widget doesn't have). A
   `bubbles: false` dispatch was tried to avoid that, but it turned out
   the rating-setting logic itself is also wired through that same
   bubbled handler, so blocking it broke ratings entirely. Bubbling was
   restored and the console error left in place — it's cosmetic and
   doesn't affect whether the rating is actually applied.

Together this should stop the Windows overlay from collapsing to just
the volume slider, which happens when Windows briefly sees no active
"now playing" session.

It also reasserts on `visibilitychange` and `focus` since Chrome
throttles background-tab timers heavily, and keeps a 15-second timer
as a lighter backstop while the tab is active.

## If it still doesn't work

- Make sure the Audio Station tab is the one Windows thinks is
  "now playing" — click Play in the tab first if you have multiple
  tabs/apps playing audio.
- Right-click the Previous/Next buttons in Audio Station → Inspect,
  and confirm they're still inside `.player-prev` / `.player-next`
  divs. Update the `SELECTORS` object in `content.js` if DSM changed
  the markup.
- Open DevTools console on the Audio Station tab and check for any
  `[Synology Media Keys]` warnings. With `DEBUG = true` at the top of
  `content.js` (default), every `refresh()` logs a snapshot —
  `prevBtnFound`, `nextBtnFound`, `songInfoVisibility`, `playbackState`,
  `patched` — so if keys go dead again you can see exactly which of
  those flipped.
- If pressing 1-5 doesn't change the rating, right-click a star →
  Inspect and confirm it's still `.syno-rating-star` with a `star="N"`
  attribute inside `.syno-song-rating-container`. Update the
  `ratingContainer` entry in `SELECTORS` in `content.js` if DSM changed
  the markup.
- If it degrades again after a long idle period, try switching to the
  tab and back (triggers the `focus`/`visibilitychange` reassertion)
  before reporting — that alone may fix it without a reload.

## Notes

If you access Audio Station from other addresses too (different
local IP, hostname, or QuickConnect URL), add those as extra entries
in the `matches` array in `manifest.json`.
