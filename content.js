// Runs in the page's MAIN world (see manifest "world": "MAIN"), so it
// shares the exact same navigator.mediaSession object Audio Station's
// own script uses.
//
// UNUSUAL THINGS ABOUT THIS FILE (read before touching mediaSession
// writes or the SoundManager 2 integration):
//
// 1. Audio Station streams through SoundManager 2, which keeps a
//    persistent PAIR of buffers (soundManager.sounds has exactly two
//    entries, "syno_audio" / "syno_audio2") for gapless/crossfaded
//    playback, rather than creating a fresh sound object per track.
//    Whichever buffer is about to play next gets briefly played (to
//    pre-buffer it) and immediately paused again, milliseconds later,
//    as pure priming -- not a real pause.
//
// 2. Play/pause are deliberately left 100% native (no "play"/"pause"
//    action handlers registered, playbackState never written to
//    "playing"/"paused" anywhere). Chrome already drives those
//    correctly off the real <audio> element on its own. Every attempt
//    to assert that state manually -- speculatively on click, from
//    SM2's onplay/onpause callbacks, from SM2's own play()/pause()/
//    resume() methods, from native events on the underlying element --
//    measurably made Windows' SMTC hardware-key routing go stale after
//    a track skip or two. Removing all of it fixed that. Don't
//    reintroduce a playbackState write for play/pause without
//    re-confirming against real hardware-key testing first.
//
// 3. previoustrack/nexttrack DO need manual handling (Chrome has no
//    native concept of "skip"), but keep the actual mediaSession API
//    traffic this produces as low as possible -- see the notes on
//    registerHandlers() and updateMetadataIfChanged() below. Debug
//    logging (window.__synologyMediaKeysDebug) proved that a single
//    track skip was triggering far more real setActionHandler/metadata
//    writes than necessary, and that volume of traffic is what was
//    destabilizing hardware-key routing, not any one write in isolation.

(function () {
  if (!("mediaSession" in navigator)) return;

  const DEBUG = false; // set true for verbose console logging

  // Structured log of every real touch to navigator.mediaSession
  // (setActionHandler calls, metadata writes, playbackState writes),
  // kept regardless of DEBUG so a report of "hardware keys stopped
  // responding" can always be diagnosed after the fact. In the page
  // console:
  //   window.__synologyMediaKeysDebug.dump()   -- readable table
  //   window.__synologyMediaKeysDebug.counts() -- running totals
  //   copy(JSON.stringify(window.__synologyMediaKeysDebug.log))
  const debugLog = [];
  function debugRecord(event, detail) {
    const entry = { t: Date.now(), event, detail: detail === undefined ? null : detail };
    debugLog.push(entry);
    if (debugLog.length > 1000) debugLog.shift();
    if (DEBUG) {
      console.log(`[Synology Media Keys] ${new Date(entry.t).toISOString()} ${event}`, detail !== undefined ? detail : "");
    }
    return entry;
  }
  let nativeSetActionHandlerCallCount = 0;
  let metadataWriteCount = 0;
  window.__synologyMediaKeysDebug = {
    log: debugLog,
    dump() {
      console.table(
        debugLog.map((e) => ({ time: new Date(e.t).toISOString(), event: e.event, detail: JSON.stringify(e.detail) }))
      );
    },
    counts() {
      return { nativeSetActionHandlerCallCount, metadataWriteCount };
    }
  };

  const SELECTORS = {
    previoustrack: ".player-prev button",
    nexttrack: ".player-next button",
    // Single toggle button -- same element handles both play and
    // pause, referenced here only for logging (see clickControl);
    // it's never clicked programmatically since play/pause is native.
    playpause: ".player-play button",
    title: ".syno-as-player-song-info .info-title span",
    artistAlbum: ".syno-as-player-song-info .info-album-artist span",
    artwork: ".player-info-thumb",
    // Same element also tells us whether a track is loaded at all:
    // style.visibility is "hidden" when nothing is loaded and
    // "visible" once a track is loaded/playing.
    songInfo: ".syno-as-player-song-info",
    ratingContainer: ".syno-song-rating-container"
  };

  function clickControl(action) {
    const button = document.querySelector(SELECTORS[action]);
    debugRecord("clickControl", { action, found: !!button, disabled: !!(button && button.disabled) });
    if (!button) return;
    button.click();
  }

  // --- Rating via number keys 1-5 -------------------------------------
  function findRatingContainer() {
    const containers = document.querySelectorAll(SELECTORS.ratingContainer);
    if (containers.length !== 1) return null;
    return containers[0];
  }

  function setRating(stars) {
    const container = findRatingContainer();
    if (!container) return;
    const starEl = container.querySelector(`.syno-rating-star[star="${stars}"]`);
    if (!starEl) return;
    for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
      starEl.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      if (e.key >= "1" && e.key <= "5") {
        setRating(Number(e.key));
      }
    },
    true
  );

  // "play"/"pause" are deliberately NOT protected -- see note 2 at the
  // top of this file. previoustrack/nexttrack have no native browser
  // equivalent, so Audio Station's own attempts to register handlers
  // for those two specifically are blocked here in favor of ours.
  const PROTECTED_ACTIONS = new Set(["previoustrack", "nexttrack"]);

  // Audio Station's own script may (re)assign
  // navigator.mediaSession.setActionHandler later in the session (e.g.
  // on reconnect), which would silently wipe our interceptor. This
  // re-patches if that happens.
  let nativeSetActionHandler;
  function ensureSetActionHandlerPatched() {
    const current = navigator.mediaSession.setActionHandler;
    if (current.__synologyMediaKeysPatched) return;

    nativeSetActionHandler = current.bind(navigator.mediaSession);
    const patched = function (action, handler) {
      if (PROTECTED_ACTIONS.has(action)) {
        return;
      }
      return nativeSetActionHandler(action, handler);
    };
    patched.__synologyMediaKeysPatched = true;
    navigator.mediaSession.setActionHandler = patched;
    debugRecord("repatch-setActionHandler");

    // A repatch only reinstalls the interceptor -- it doesn't push our
    // handlers back to the browser on its own, so re-register here too.
    registerHandlers("repatch");
  }

  const previousHandler = () => clickControl("previoustrack");
  const nextHandler = () => clickControl("nexttrack");

  // Re-asserts previoustrack/nexttrack. Called on startup, after a
  // genuine repatch, and periodically from refresh() (every 15s +
  // focus/visibility) as a safety net -- deliberately NOT called on
  // every track change/native playback event. It doesn't need to be:
  // Audio Station has never actually been observed clearing the
  // registry mid-session, so reasserting per-track was pure
  // unnecessary setActionHandler traffic that measurably contributed
  // to hardware keys going stale. Keep new call sites rare.
  function registerHandlers(reason) {
    if (!nativeSetActionHandler) return;
    nativeSetActionHandlerCallCount += 2;
    debugRecord("registerHandlers", { reason, nativeSetActionHandlerCallCount });
    nativeSetActionHandler("previoustrack", previousHandler);
    nativeSetActionHandler("nexttrack", nextHandler);
  }
  ensureSetActionHandlerPatched();

  let lastTitle = null;
  let lastArtworkSrc = null;
  let mediaMetadataInstance = null;
  function updateMetadataIfChangedNow() {
    const titleEl = document.querySelector(SELECTORS.title);
    const title = titleEl && titleEl.textContent.trim();
    if (!title) return;

    const artworkEl = document.querySelector(SELECTORS.artwork);
    const artworkSrc = (artworkEl && artworkEl.src) || "";

    // Re-check on artwork src changing too, not just title -- the
    // cover image URL comes from a separate server round-trip
    // (cover.cgi?...) that can resolve after the title's already
    // updated.
    if (title === lastTitle && artworkSrc === lastArtworkSrc) return;
    lastTitle = title;
    lastArtworkSrc = artworkSrc;

    const artistEl = document.querySelector(SELECTORS.artistAlbum);
    const artist = (artistEl && artistEl.textContent.trim()) || "";

    const artwork = artworkSrc ? [{ src: artworkSrc, sizes: "512x512", type: "image/png" }] : [];

    try {
      if (!mediaMetadataInstance) {
        mediaMetadataInstance = new MediaMetadata({ title, artist, artwork });
        navigator.mediaSession.metadata = mediaMetadataInstance;
        metadataWriteCount++;
        debugRecord("metadata-write", { kind: "initial-assign", title, metadataWriteCount });
      } else {
        // Mutate the existing instance's properties rather than
        // reassigning navigator.mediaSession.metadata each time --
        // both are real touches Chrome forwards to the OS, but this
        // keeps the intent (updating one metadata object) clearer.
        mediaMetadataInstance.title = title;
        mediaMetadataInstance.artist = artist;
        mediaMetadataInstance.artwork = artwork;
        metadataWriteCount++;
        debugRecord("metadata-write", { kind: "mutate", title, metadataWriteCount });
      }
    } catch (err) {
      debugRecord("metadata-write-error", { message: err && err.message });
    }
  }

  // Debounced entry point -- call this, not updateMetadataIfChangedNow()
  // directly. Title, artist, and artwork resolve at slightly different
  // moments as Audio Station's DOM updates trickle in (see the artwork
  // comment above), which without debouncing produced 2-3 separate
  // real metadata writes per track change a few ms to ~70ms apart.
  // 250ms comfortably absorbs that burst into a single write while
  // staying imperceptible for a title update.
  let metadataDebounceTimer = null;
  function updateMetadataIfChanged() {
    if (metadataDebounceTimer) clearTimeout(metadataDebounceTimer);
    metadataDebounceTimer = setTimeout(() => {
      metadataDebounceTimer = null;
      updateMetadataIfChangedNow();
    }, 250);
  }

  function setPlaybackState(state) {
    // Only ever called with "none" (see syncPlaybackState) -- play/pause
    // are fully native, see note 2 at the top of this file.
    navigator.mediaSession.playbackState = state;
    debugRecord("playbackState-write", { state });
  }

  // SM2 exposes the underlying native HTMLAudioElement as sound._a in
  // HTML5 mode. Watched here purely for debug visibility and to catch
  // the moment a fresh element appears for a new track (SM2 tears down
  // and recreates it per track -- see _setup_html5) -- NOT for
  // asserting playbackState, which play/pause no longer touches at all.
  const watchedAudioElements = new WeakSet();

  function attachAudioElementListeners(sound, id) {
    if (!sound) return;
    const audioEl = sound._a;
    if (!audioEl || typeof audioEl.addEventListener !== "function") return; // not created yet -- retried on next scan
    if (watchedAudioElements.has(audioEl)) return;
    watchedAudioElements.add(audioEl);

    const soundId = id || sound.id || null;

    audioEl.addEventListener("playing", () => {
      debugRecord("audio-playing", { soundId });
    });

    audioEl.addEventListener("pause", () => {
      debugRecord("audio-pause", { soundId });
    });

    debugRecord("attached-audio-listeners", { soundId });
  }

  let soundManagerCreateSoundPatched = false;

  function ensureSoundManagerPatched() {
    const sm = window.soundManager;
    if (!sm) return; // SM2 attaches to window asynchronously; retried on next scan

    if (!soundManagerCreateSoundPatched && typeof sm.createSound === "function") {
      const nativeCreateSound = sm.createSound.bind(sm);

      sm.createSound = function (options) {
        const sound = nativeCreateSound(options);
        attachAudioElementListeners(sound, sound && sound.id);
        return sound;
      };

      soundManagerCreateSoundPatched = true;
    }

    // Audio Station reuses its two persistent buffers rather than
    // calling createSound() per track, so re-scan on every call rather
    // than once -- idempotency is handled per-element via
    // watchedAudioElements above.
    if (sm.sounds) {
      Object.entries(sm.sounds).forEach(([id, sound]) => {
        attachAudioElementListeners(sound, id);
      });
    }
  }

  // Simple, reliable signal straight from the UI: whether a track is
  // loaded at all. Doesn't distinguish playing from paused -- that's
  // handled natively now (see note 2 at the top of this file) -- this
  // only covers previoustrack/nexttrack greying out when nothing is
  // loaded at all.
  //
  // song-info briefly goes to visibility:hidden (~300ms) while Audio
  // Station swaps to the next/previous track, even though playback
  // itself never really stops. Debounce the "none" transition so that
  // blip doesn't fire -- only commit to "none" if it's still hidden
  // 2s later.
  let pendingNoneTimeout = null;
  function syncPlaybackState() {
    const songInfo = document.querySelector(SELECTORS.songInfo);
    if (!songInfo) return;

    if (songInfo.style.visibility === "hidden") {
      if (pendingNoneTimeout) return;
      pendingNoneTimeout = setTimeout(() => {
        pendingNoneTimeout = null;
        const info = document.querySelector(SELECTORS.songInfo);
        if (info && info.style.visibility === "hidden") {
          setPlaybackState("none");
        }
      }, 2000);
      return;
    }

    if (pendingNoneTimeout) {
      clearTimeout(pendingNoneTimeout);
      pendingNoneTimeout = null;
    }
  }

  // Debounced against back-to-back calls -- visibilitychange and focus
  // can both fire from the same window interaction, which would
  // otherwise double every registerHandlers() call for no reason.
  let lastRefreshAt = 0;
  function refresh() {
    const now = Date.now();
    if (now - lastRefreshAt < 1000) {
      debugRecord("refresh-skipped-debounce");
      return;
    }
    lastRefreshAt = now;
    debugRecord("refresh");
    ensureSetActionHandlerPatched();
    registerHandlers("refresh");
    ensureSoundManagerPatched();
    updateMetadataIfChanged();
    syncPlaybackState();
  }

  refresh();

  // Catch track changes immediately rather than waiting up to 15s for
  // the next poll -- covers hardware next/prev, UI clicks, and
  // auto-advance to the next track, since all of them change the title
  // text the same way.
  function startDomObserver() {
    const domObserver = new MutationObserver(() => {
      ensureSetActionHandlerPatched();
      ensureSoundManagerPatched();
      updateMetadataIfChanged();
      syncPlaybackState();
    });
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "src"]
    });
  }
  if (document.documentElement) {
    startDomObserver();
  } else {
    document.addEventListener("DOMContentLoaded", startDomObserver, { once: true });
  }

  // Re-check when the tab regains attention, since backgrounded-tab
  // throttling could otherwise leave things stale for a while.
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("focus", refresh);

  // Light safety-net poll.
  setInterval(refresh, 15000);
})();
