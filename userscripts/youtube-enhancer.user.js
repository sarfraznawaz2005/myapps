// My Apps userscript: YouTube Enhancer.
// Settings > Userscripts > + Add userscript. Runs on: https://www.youtube.com/*
// Change a value below, save, and reload the YouTube page.

if (!window.__myappsYoutubeEnhancer) {
  window.__myappsYoutubeEnhancer = true;

  const SETTINGS = {
    // Playback
    quality: 'large',              // tiny 144p, small 240p, medium 360p, large 480p, hd720, hd1080, hd1440, hd2160
    blockHighFrameRate: true,      // no 48/50/60 FPS formats
    blockAutoplay: true,           // a new video waits until you press play
    stopInsteadOfPause: true,      // stop the blocked video, so it does not buffer
    disableUpNext: true,           // turn off the "next video" autoplay switch
    pauseOtherTabs: true,          // a video that starts pauses YouTube in other links

    // Volume
    wheelVolume: true,             // mouse wheel on the player changes volume
    wheelReverse: false,
    wheelStep: 5,
    boostMultiplier: 2,            // volume booster button level

    // Player size
    theaterMode: true,
    fillWindow: true,              // theater player fills the window height
    miniPlayer: true,              // small player when you scroll down
    miniPlayerSize: [480, 270],
    miniPlayerSide: 'left',        // left or right, always at the top

    // Page
    darkTheme: true,
    accentColor: '#00adee',
    hideChat: true,
    hideShorts: true,
    videosPerRow: 4,
  };

  const MASTHEAD_HEIGHT = 56;
  const QUALITY_ORDER = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080', 'hd1440', 'hd2160', 'hd2880', 'highres'];
  const ICONS = {
    boost: 'M3 9v6h4l5 5V4L7 9H3zm11.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM12 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
    size: 'M3 5h18v14H3V5zm2 2v10h14V7H5zm2 2h4v2H9v2H7V9zm10 6h-4v-2h2v-2h2v4z',
    screenshot: 'M9 3 7.2 5H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  };

  const getPlayer = () => document.getElementById('movie_player');
  const getVideo = () => document.querySelector('#movie_player video.html5-main-video');
  const getWatch = () => document.querySelector('ytd-watch-flexy');
  const isWatchPage = () => location.pathname === '/watch';
  const currentVideoId = () => new URLSearchParams(location.search).get('v');

  function setCookie(name, value) {
    const year = 60 * 60 * 24 * 365;
    document.cookie = `${name}=${value}; domain=.youtube.com; path=/; max-age=${year}; secure; samesite=lax`;
  }

  function readCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? match[1] : '';
  }

  // ---- Styles ------------------------------------------------------------

  function buildCss() {
    const parts = [`
      .myapps-yt-button { display: inline-flex; align-items: center; justify-content: center; vertical-align: top; }
      .myapps-yt-button svg { width: 24px; height: 24px; fill: #fff; }
      .myapps-yt-button.active svg { fill: ${SETTINGS.accentColor}; }
      .myapps-yt-bubble {
        position: absolute; top: 12%; left: 50%; transform: translateX(-50%); z-index: 70;
        padding: 6px 14px; border-radius: 4px; background: rgba(0, 0, 0, .75); color: #fff;
        font: 500 16px Roboto, Arial, sans-serif; pointer-events: none; opacity: 0; transition: opacity .2s;
      }
      .myapps-yt-bubble.show { opacity: 1; }
    `];

    if (SETTINGS.darkTheme) {
      parts.push(`
        html[dark] {
          --yt-spec-base-background: #111111;
          --yt-spec-general-background-a: #111111;
          --yt-spec-general-background-b: #111111;
          --yt-spec-general-background-c: #111111;
          --yt-spec-raised-background: #181818;
          --yt-spec-menu-background: #181818;
          --yt-spec-text-primary: #eff0f1;
          --yt-spec-text-secondary: #cccccc;
          --yt-spec-call-to-action: ${SETTINGS.accentColor};
          --yt-spec-themed-blue: ${SETTINGS.accentColor};
        }
        html[dark], html[dark] body, html[dark] ytd-app { background: #111111 !important; }
        html[dark] ytd-masthead, html[dark] #background.ytd-masthead,
        html[dark] #guide-content, html[dark] ytd-mini-guide-renderer { background: #111111 !important; }
        .ytp-play-progress, .ytp-swatch-background-color, .ytp-volume-slider-handle::before { background: ${SETTINGS.accentColor} !important; }
        a.yt-simple-endpoint.ytd-comment-view-model, #description a { color: ${SETTINGS.accentColor}; }
      `);
    }

    if (SETTINGS.hideChat) {
      parts.push('ytd-live-chat-frame#chat, #chat-container { display: none !important; }');
    }

    if (SETTINGS.hideShorts) {
      parts.push(`
        ytd-reel-shelf-renderer,
        ytd-rich-shelf-renderer[is-shorts],
        ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
        grid-shelf-view-model:has(a[href^="/shorts/"]),
        ytd-video-renderer:has(a[href^="/shorts/"]),
        ytd-grid-video-renderer:has(a[href^="/shorts/"]),
        ytd-rich-item-renderer:has(a[href^="/shorts/"]),
        ytd-compact-video-renderer:has(a[href^="/shorts/"]),
        ytd-guide-entry-renderer:has(a[title="Shorts"]),
        ytd-mini-guide-entry-renderer[aria-label="Shorts"] { display: none !important; }
      `);
    }

    if (SETTINGS.videosPerRow) {
      parts.push(`
        ytd-rich-grid-renderer { --ytd-rich-grid-items-per-row: ${SETTINGS.videosPerRow} !important; }
        ytd-two-column-browse-results-renderer { --ytd-rich-grid-items-per-row: ${SETTINGS.videosPerRow} !important; }
      `);
    }

    if (SETTINGS.fillWindow) {
      // Without overflow-anchor the browser scrolls down when the player grows.
      parts.push(`
        html.myapps-yt-fill, html.myapps-yt-fill body { overflow-anchor: none; }
        html.myapps-yt-fill ytd-watch-flexy[theater] #full-bleed-container,
        html.myapps-yt-fill ytd-watch-flexy[theater] #player-full-bleed-container {
          height: calc(100vh - ${MASTHEAD_HEIGHT}px) !important;
          max-height: none !important;
          min-height: 0 !important;
        }
      `);
    }

    if (SETTINGS.miniPlayer) {
      const [width, height] = SETTINGS.miniPlayerSize;
      parts.push(`
        html.myapps-yt-mini #full-bleed-container,
        html.myapps-yt-mini #player-full-bleed-container {
          position: relative !important;
          z-index: 3000 !important;
        }
        html.myapps-yt-mini #movie_player {
          position: fixed !important;
          top: ${MASTHEAD_HEIGHT + 8}px !important;
          ${SETTINGS.miniPlayerSide === 'right' ? 'right' : 'left'}: 8px !important;
          width: ${width}px !important;
          height: ${height}px !important;
          z-index: 3000 !important;
          box-shadow: 0 2px 12px rgba(0, 0, 0, .7);
        }
        html.myapps-yt-mini #movie_player video.html5-main-video {
          left: 0 !important;
          top: 0 !important;
          width: ${width}px !important;
          height: ${height}px !important;
          object-fit: contain;
        }
        html.myapps-yt-mini #movie_player .ytp-chrome-bottom {
          left: 12px !important;
          width: calc(100% - 24px) !important;
        }
      `);
    }

    return parts.join('\n');
  }

  function addStyles() {
    const style = document.createElement('style');
    style.id = 'myapps-yt-style';
    style.textContent = buildCss();
    document.documentElement.appendChild(style);
  }

  // ---- Dark theme --------------------------------------------------------

  function applyDarkTheme() {
    if (!SETTINGS.darkTheme) return;
    document.documentElement.setAttribute('dark', '');
    // The f6 bit tells the server to send the dark page on the next load, so
    // there is no white flash before this script runs.
    const params = new URLSearchParams(readCookie('PREF').replace(/%3D/gi, '=').replace(/%26/gi, '&'));
    const flags = parseInt(params.get('f6') || '0', 16);
    if (flags & 0x400) return;
    params.set('f6', (flags | 0x400).toString(16));
    setCookie('PREF', params.toString());
  }

  // ---- Quality and formats -----------------------------------------------

  function applyQuality() {
    const player = getPlayer();
    if (!player || !player.getAvailableQualityLevels) return;
    const levels = player.getAvailableQualityLevels().filter((q) => q !== 'auto');
    if (!levels.length) return;
    const wanted = QUALITY_ORDER.indexOf(SETTINGS.quality);
    const best = levels
      .filter((q) => QUALITY_ORDER.indexOf(q) <= wanted)
      .sort((a, b) => QUALITY_ORDER.indexOf(b) - QUALITY_ORDER.indexOf(a))[0] || levels[levels.length - 1];
    if (player.setPlaybackQualityRange) player.setPlaybackQualityRange(best, best);
    if (player.setPlaybackQuality) player.setPlaybackQuality(best);
  }

  function blockHighFrameRate() {
    if (!SETTINGS.blockHighFrameRate || !window.MediaSource) return;
    const original = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (type) => {
      const fps = /framerate=(\d+)/i.exec(type || '');
      if (fps && Number(fps[1]) > 30) return false;
      return original(type);
    };
  }

  // ---- Autoplay ----------------------------------------------------------

  let blockedVideoId = null;  // the video that may not start without the user
  let lastUserAction = 0;

  function markUserAction() { lastUserAction = Date.now(); }

  function armAutoplayBlock() {
    if (!SETTINGS.blockAutoplay || !isWatchPage()) return;
    const id = currentVideoId();
    if (id && id !== blockedVideoId) blockedVideoId = id;
  }

  // Cue the video again, so YouTube shows the thumbnail and the big play button.
  function blockVideo(video) {
    const player = getPlayer();
    if (!SETTINGS.stopInsteadOfPause || !player.stopVideo || !player.cueVideoById) {
      video.pause();
      return;
    }
    const startSeconds = parseInt(new URLSearchParams(location.search).get('t'), 10) || 0;
    player.stopVideo();
    player.cueVideoById({ videoId: blockedVideoId, startSeconds });
  }

  function onPlay(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !video.closest('#movie_player')) return;
    if (SETTINGS.blockAutoplay && blockedVideoId) {
      if (Date.now() - lastUserAction < 1500) {
        blockedVideoId = null;
      } else if (currentVideoId() === blockedVideoId) {
        blockVideo(video);
        return;
      }
    }
    if (pauseChannel) pauseChannel.postMessage('playing');
  }

  function watchUserActions() {
    document.addEventListener('pointerdown', (event) => {
      if (event.target.closest && event.target.closest('#movie_player')) markUserAction();
    }, true);
    document.addEventListener('keydown', (event) => {
      const tag = (event.target.tagName || '').toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && !event.target.isContentEditable) markUserAction();
    }, true);
  }

  function disableUpNext() {
    if (!SETTINGS.disableUpNext) return;
    const toggle = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
    if (toggle) toggle.click();
  }

  // ---- Other links ------------------------------------------------------

  const pauseChannel = SETTINGS.pauseOtherTabs && window.BroadcastChannel
    ? new BroadcastChannel('myapps-yt-pause')
    : null;

  if (pauseChannel) {
    pauseChannel.onmessage = () => {
      const video = getVideo();
      if (video && !video.paused) video.pause();
    };
  }

  // ---- Volume ------------------------------------------------------------

  let bubbleTimer = null;

  function showBubble(text) {
    const player = getPlayer();
    if (!player) return;
    let bubble = player.querySelector('.myapps-yt-bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'myapps-yt-bubble';
      player.appendChild(bubble);
    }
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 900);
  }

  function onWheel(event) {
    const player = event.target.closest && event.target.closest('#movie_player');
    if (!player || !player.getVolume || event.ctrlKey || event.target.closest('.ytp-settings-menu, .ytp-panel')) return;
    event.preventDefault();
    const up = (event.deltaY < 0) !== SETTINGS.wheelReverse;
    const volume = Math.max(0, Math.min(100, player.getVolume() + (up ? SETTINGS.wheelStep : -SETTINGS.wheelStep)));
    if (player.isMuted()) player.unMute();
    player.setVolume(volume);
    showBubble(`${volume}%`);
  }

  let audio = null;

  function toggleBooster(button) {
    const video = getVideo();
    if (!video) return;
    if (!audio || audio.video !== video) {
      const context = new AudioContext();
      const gain = context.createGain();
      context.createMediaElementSource(video).connect(gain);
      gain.connect(context.destination);
      audio = { context, gain, video };
    }
    audio.context.resume();
    const on = audio.gain.gain.value === 1;
    audio.gain.gain.value = on ? SETTINGS.boostMultiplier : 1;
    button.classList.toggle('active', on);
    showBubble(on ? `Volume boost ${SETTINGS.boostMultiplier}x` : 'Volume boost off');
  }

  // ---- Screenshot --------------------------------------------------------

  function takeScreenshot() {
    const video = getVideo();
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const title = document.title.replace(/ - YouTube$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'youtube';
      link.href = url;
      link.download = `${title} ${Math.floor(video.currentTime)}s.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, 'image/png');
  }

  // ---- Player size -------------------------------------------------------

  function setFill(on) {
    const root = document.documentElement;
    if (root.classList.contains('myapps-yt-fill') === on) return;
    root.classList.toggle('myapps-yt-fill', on);
    window.dispatchEvent(new Event('resize'));
  }

  function applyTheater() {
    const watch = getWatch();
    if (!isWatchPage() || !watch) return;
    if (SETTINGS.theaterMode && !watch.hasAttribute('theater')) {
      const button = document.querySelector('#movie_player .ytp-size-button');
      if (button) button.click();
    }
    setFill(SETTINGS.fillWindow && watch.hasAttribute('theater'));
  }

  function toggleSize(button) {
    const on = !document.documentElement.classList.contains('myapps-yt-fill');
    const watch = getWatch();
    if (on && watch && !watch.hasAttribute('theater')) {
      const sizeButton = document.querySelector('#movie_player .ytp-size-button');
      if (sizeButton) sizeButton.click();
    }
    setFill(on);
    button.classList.toggle('active', on);
  }

  // ---- Mini player -------------------------------------------------------

  function updateMiniPlayer() {
    if (!SETTINGS.miniPlayer) return;
    const video = getVideo();
    const holder = document.querySelector('#player-full-bleed-container, #full-bleed-container, #player-container-outer');
    let show = false;
    if (isWatchPage() && video && holder && !document.fullscreenElement) {
      show = holder.getBoundingClientRect().bottom < MASTHEAD_HEIGHT + 120 && !video.paused;
    }
    const root = document.documentElement;
    if (root.classList.contains('myapps-yt-mini') === show) return;
    root.classList.toggle('myapps-yt-mini', show);
    window.dispatchEvent(new Event('resize'));
  }

  // ---- Player buttons ----------------------------------------------------

  function makeButton(name, title, path, onClick) {
    const button = document.createElement('button');
    button.className = `ytp-button myapps-yt-button myapps-yt-${name}`;
    button.title = title;
    button.setAttribute('aria-label', title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path);
    svg.appendChild(shape);
    button.appendChild(svg);
    button.addEventListener('click', () => onClick(button));
    return button;
  }

  function addButtons() {
    const controls = document.querySelector('#movie_player .ytp-right-controls');
    if (!controls || controls.querySelector('.myapps-yt-button')) return;
    const buttons = [
      makeButton('boost', 'Volume boost', ICONS.boost, toggleBooster),
      makeButton('size', 'Fill the window', ICONS.size, toggleSize),
      makeButton('screenshot', 'Screenshot', ICONS.screenshot, takeScreenshot),
    ];
    if (document.documentElement.classList.contains('myapps-yt-fill')) buttons[1].classList.add('active');
    controls.prepend(...buttons);
  }

  // ---- Page changes ------------------------------------------------------

  // YouTube changes pages without a real load, and it builds the player late,
  // so this runs a few times after each change until the player is ready.
  function refreshPage() {
    armAutoplayBlock();
    [0, 500, 1500, 3000, 6000].forEach((delay) => setTimeout(() => {
      applyDarkTheme();
      applyTheater();
      addButtons();
      disableUpNext();
      if (isWatchPage()) applyQuality();
    }, delay));
  }

  function start() {
    blockHighFrameRate();
    if (SETTINGS.theaterMode) setCookie('wide', '1');
    addStyles();
    watchUserActions();
    document.addEventListener('play', onPlay, true);
    document.addEventListener('loadedmetadata', applyQuality, true);
    document.addEventListener('yt-navigate-start', armAutoplayBlock);
    document.addEventListener('yt-navigate-finish', refreshPage);
    if (SETTINGS.wheelVolume) document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('scroll', updateMiniPlayer, { passive: true });
    document.addEventListener('pause', updateMiniPlayer, true);
    document.addEventListener('playing', updateMiniPlayer, true);
    document.addEventListener('fullscreenchange', updateMiniPlayer);
    refreshPage();
    const video = getVideo();
    if (video && !video.paused) onPlay({ target: video });
  }

  start();
}
