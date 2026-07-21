(function () {
  if (!("mediaSession" in navigator)) return;

  const SELECTORS = {
    previoustrack: ".player-prev button",
    nexttrack: ".player-next button",
    playpause: ".player-play button",
    title: ".syno-as-player-song-info .info-title span",
    artistAlbum: ".syno-as-player-song-info .info-album-artist span",
    artwork: ".player-info-thumb",
    songInfo: ".syno-as-player-song-info",
    ratingContainer: ".syno-song-rating-container"
  };

  function clickControl(action) {
    const button = document.querySelector(SELECTORS[action]);
    if (!button) return;
    button.click();
  }

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

  const PROTECTED_ACTIONS = new Set(["previoustrack", "nexttrack", "play", "pause"]);

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
  }

  const previousHandler = () => {
    setPlaybackState("playing");
    clickControl("previoustrack");
  };

  const nextHandler = () => {
    setPlaybackState("playing");
    clickControl("nexttrack");
  };

  const playHandler = () => {
    setPlaybackState("playing");
    clickControl("playpause");
  };

  const pauseHandler = () => {
    setPlaybackState("paused");
    clickControl("playpause");
  };

  // No "already registered" latch here on purpose. Audio Station's own
  // script can silently clear the browser's internal action-handler
  // registry (e.g. on track change/reconnect) without ever swapping out
  // the setActionHandler property itself — the only thing that would
  // reset a one-shot latch. So instead this just re-asserts all four
  // handlers unconditionally every refresh() cycle. setActionHandler
  // calls are cheap and idempotent, so there's no real cost to that.
  function registerHandlers() {
    if (!nativeSetActionHandler) return;
    nativeSetActionHandler("previoustrack", previousHandler);
    nativeSetActionHandler("nexttrack", nextHandler);
    nativeSetActionHandler("play", playHandler);
    nativeSetActionHandler("pause", pauseHandler);
  }
  ensureSetActionHandlerPatched();
  let lastTitle = null;
  let lastArtworkSrc = null;
  let mediaMetadataInstance = null;
  function updateMetadataIfChanged() {
    const titleEl = document.querySelector(SELECTORS.title);
    const title = titleEl && titleEl.textContent.trim();
    if (!title) return;

    const artworkEl = document.querySelector(SELECTORS.artwork);
    const artworkSrc = (artworkEl && artworkEl.src) || "";

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
      } else {
        mediaMetadataInstance.title = title;
        mediaMetadataInstance.artist = artist;
        mediaMetadataInstance.artwork = artwork;
      }
    } catch (err) {}
  }

  function setPlaybackState(state) {
    // Deliberately always writes, even if `state` matches what we
    // last set. Windows' SMTC bridge appears to need an actual write
    // to navigator.mediaSession.playbackState to treat the session as
    // live — confirmed by the fact that toggling play/pause via the
    // UI (a guaranteed real "playing"->"paused"->"playing" transition)
    // restores hardware-key responsiveness, whereas a track skip that
    // stays "playing" throughout previously never wrote to the API at
    // all under an equality-gated version of this function.
    navigator.mediaSession.playbackState = state;
  }

  const PRIME_DEBOUNCE_MS = 800;
  const lastPlayAt = {};

  const watchedSoundMethods = new WeakMap();
  
  function watchSoundMethod(sound, prop, handler) {
    let watched = watchedSoundMethods.get(sound);
    if (!watched) {
      watched = new Set();
      watchedSoundMethods.set(sound, watched);
    }

    if (watched.has(prop)) return;
    watched.add(prop);

    const original = sound[prop];
    if (typeof original !== "function") return;

    sound[prop] = function (...args) {
      handler.apply(this, args);
      return original.apply(this, args);
    };
  }

  function patchSoundMethods(target, id) {
    if (!target) return;

    const soundId = id || target.id || null;

    const onPlayLike = () => {
      if (soundId !== null) {
        lastPlayAt[soundId] = Date.now();
      }
      setPlaybackState("playing");
      // Deliberately not gated on setPlaybackState's "did the string
      // actually change" check — skipping while already playing never
      // trips that, but SM2 still tore down the old Audio() element
      // and created a fresh one for the new track (see _setup_html5),
      // and that's exactly the moment handlers need reasserting.
      registerHandlers();
    };

    // SM2 defines `this.start = this.play = function (...) {...}` on each
    // sound instance: both properties reference the same function object at
    // construction time, but they are two distinct own properties. Wrapping
    // only "play" would miss any caller that invokes sound.start() instead.
    watchSoundMethod(target, "play", onPlayLike);
    watchSoundMethod(target, "start", onPlayLike);

    watchSoundMethod(target, "resume", onPlayLike);

    watchSoundMethod(target, "pause", () => {
      const playedAt = soundId !== null ? lastPlayAt[soundId] : undefined;
      const msSincePlay = playedAt !== undefined ? Date.now() - playedAt : null;

      if (msSincePlay !== null && msSincePlay < PRIME_DEBOUNCE_MS) {
        return;
      }

      setPlaybackState("paused");
    });
  }

  let soundManagerCreateSoundPatched = false;

  function ensureSoundManagerPatched() {
    const sm = window.soundManager;
    if (!sm) return;

    if (!soundManagerCreateSoundPatched && typeof sm.createSound === "function") {
      const nativeCreateSound = sm.createSound.bind(sm);

      sm.createSound = function (options) {
        const sound = nativeCreateSound(options);

        patchSoundMethods(sound, sound && sound.id);

        return sound;
      };

      soundManagerCreateSoundPatched = true;
    }

    if (sm.sounds) {
      Object.entries(sm.sounds).forEach(([id, sound]) => {
        patchSoundMethods(sound, id);
      });
    }
  }

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

  function refresh() {
    ensureSetActionHandlerPatched();
    registerHandlers();
    ensureSoundManagerPatched();
    updateMetadataIfChanged();
    syncPlaybackState();
  }

  refresh();

  function startDomObserver() {
    const domObserver = new MutationObserver(() => {
      ensureSetActionHandlerPatched();
      registerHandlers();
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

  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("focus", refresh);

  setInterval(refresh, 15000);
})();
