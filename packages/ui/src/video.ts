import { createIcon } from './icons';

/**
 * The app's own controls for a video: play and pause, a line that shows how far it is and
 * moves it, the time, and sound on or off. The same in notes and in the viewer.
 */

const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
};

/** How loud videos are, kept for the next one (and the next time the app is opened). */
const SOUND_KEY = 'pumice.video.sound';
function rememberedSound(): { volume: number; muted: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null') as {
      volume?: unknown;
      muted?: unknown;
    } | null;
    const volume = typeof saved?.volume === 'number' ? Math.min(1, Math.max(0, saved.volume)) : 1;
    return { volume, muted: saved?.muted === true };
  } catch {
    return { volume: 1, muted: false };
  }
}
function rememberSound(video: HTMLVideoElement): void {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify({ volume: video.volume, muted: video.muted }));
  } catch {
    // Not kept, then.
  }
}

/** The control bar for `video`. Its listeners go when the video does. */
export function createVideoControls(video: HTMLVideoElement): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'pm-video-controls';

  const iconButton = (label: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pm-video-button';
    b.setAttribute('aria-label', label);
    b.title = label;
    return b;
  };
  const play = iconButton('Play');
  const sound = iconButton('Mute');
  // How loud: a short line beside the speaker, moved like the progress line.
  const loud = document.createElement('div');
  loud.className = 'pm-video-volume';
  loud.tabIndex = 0;
  loud.setAttribute('role', 'slider');
  loud.setAttribute('aria-label', 'Volume');
  loud.setAttribute('aria-valuemin', '0');
  loud.setAttribute('aria-valuemax', '100');
  const loudFill = document.createElement('div');
  loudFill.className = 'pm-video-volume-fill';
  const loudKnob = document.createElement('div');
  loudKnob.className = 'pm-video-volume-knob';
  loud.append(loudFill, loudKnob);
  const before = rememberedSound();
  video.volume = before.volume;
  video.muted = before.muted;
  const time = document.createElement('span');
  time.className = 'pm-video-time';

  // The progress line: a slider, moved with the pointer or the arrow keys.
  const line = document.createElement('div');
  line.className = 'pm-video-progress';
  line.tabIndex = 0;
  line.setAttribute('role', 'slider');
  line.setAttribute('aria-label', 'Position');
  line.setAttribute('aria-valuemin', '0');
  const loaded = document.createElement('div');
  loaded.className = 'pm-video-progress-loaded';
  const played = document.createElement('div');
  played.className = 'pm-video-progress-played';
  const knob = document.createElement('div');
  knob.className = 'pm-video-progress-knob';
  line.append(loaded, played, knob);

  const length = () => (Number.isFinite(video.duration) ? video.duration : 0);
  /** Where it is: drawn at every frame while it plays, so the line moves evenly. */
  const showPosition = () => {
    const total = length();
    const at = total ? Math.min(1, video.currentTime / total) : 0;
    played.style.width = `${at * 100}%`;
    knob.style.left = `${at * 100}%`;
    const text = `${clock(video.currentTime)} / ${clock(total)}`;
    if (time.textContent !== text) time.textContent = text;
  };
  let frame = 0;
  const follow = () => {
    cancelAnimationFrame(frame);
    const step = () => {
      showPosition();
      if (!video.paused && !video.ended && bar.isConnected) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };
  video.addEventListener('play', follow);
  video.addEventListener('playing', follow);
  const show = () => {
    const total = length();
    showPosition();
    const end = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    loaded.style.width = `${total ? Math.min(1, end / total) * 100 : 0}%`;
    line.setAttribute('aria-valuemax', String(Math.round(total)));
    line.setAttribute('aria-valuenow', String(Math.round(video.currentTime)));
    line.setAttribute('aria-valuetext', `${clock(video.currentTime)} of ${clock(total)}`);
    const paused = video.paused || video.ended;
    play.replaceChildren(createIcon(paused ? 'play' : 'pause', 15));
    play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    play.title = paused ? 'Play' : 'Pause';
    const silent = video.muted || video.volume === 0;
    sound.replaceChildren(createIcon(silent ? 'volume-off' : 'volume', 15));
    sound.setAttribute('aria-label', silent ? 'Sound on' : 'Mute');
    sound.title = silent ? 'Sound on' : 'Mute';
    const level = video.muted ? 0 : video.volume;
    loudFill.style.width = `${level * 100}%`;
    loudKnob.style.left = `${level * 100}%`;
    loud.setAttribute('aria-valuenow', String(Math.round(level * 100)));
    loud.setAttribute('aria-valuetext', `${Math.round(level * 100)}%`);
    bar.classList.toggle('is-paused', paused);
  };
  for (const event of [
    'play',
    'pause',
    'ended',
    'timeupdate',
    'durationchange',
    'loadedmetadata',
    'progress',
    'volumechange',
    'seeked',
  ])
    video.addEventListener(event, show);

  const toggle = () => {
    if (video.paused || video.ended) void video.play().catch(() => undefined);
    else video.pause();
  };
  play.addEventListener('click', toggle);
  sound.addEventListener('click', () => {
    // Sound that was turned all the way down comes back at a level that can be heard.
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.5;
    } else video.muted = true;
  });
  video.addEventListener('volumechange', () => rememberSound(video));
  const setVolume = (level: number) => {
    video.volume = Math.min(1, Math.max(0, level));
    video.muted = video.volume === 0;
  };
  const volumeAt = (clientX: number) => {
    const r = loud.getBoundingClientRect();
    if (r.width) setVolume((clientX - r.left) / r.width);
  };
  loud.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    loud.setPointerCapture(e.pointerId);
    volumeAt(e.clientX);
  });
  loud.addEventListener('pointermove', (e) => {
    if (loud.hasPointerCapture(e.pointerId)) volumeAt(e.clientX);
  });
  const releaseVolume = (e: PointerEvent) => {
    if (loud.hasPointerCapture(e.pointerId)) loud.releasePointerCapture(e.pointerId);
  };
  loud.addEventListener('pointerup', releaseVolume);
  loud.addEventListener('pointercancel', releaseVolume);
  loud.addEventListener('keydown', (e) => {
    const level = video.muted ? 0 : video.volume;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setVolume(level + 0.05);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setVolume(level - 0.05);
    else if (e.key === 'Home') setVolume(0);
    else if (e.key === 'End') setVolume(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  const seekTo = (clientX: number) => {
    const r = line.getBoundingClientRect();
    const total = length();
    if (!total || !r.width) return;
    video.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total;
    show();
  };
  line.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    line.setPointerCapture(e.pointerId);
    line.classList.add('is-seeking');
    seekTo(e.clientX);
  });
  line.addEventListener('pointermove', (e) => {
    if (line.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
  });
  const release = (e: PointerEvent) => {
    line.classList.remove('is-seeking');
    if (line.hasPointerCapture(e.pointerId)) line.releasePointerCapture(e.pointerId);
  };
  line.addEventListener('pointerup', release);
  line.addEventListener('pointercancel', release);
  line.addEventListener('keydown', (e) => {
    const total = length();
    const step = e.shiftKey ? 10 : 5;
    if (e.key === 'ArrowRight') video.currentTime = Math.min(total, video.currentTime + step);
    else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - step);
    else if (e.key === 'Home') video.currentTime = 0;
    else if (e.key === 'End') video.currentTime = total;
    else if (e.key === ' ' || e.key === 'Enter') toggle();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  // The controls are not part of the text around them.
  for (const event of ['mousedown', 'click', 'dblclick', 'pointerdown', 'pointerup'] as const)
    bar.addEventListener(event, (e) => e.stopPropagation());

  bar.append(play, line, time, sound, loud);
  show();
  return bar;
}

export interface VideoPlayer {
  /** The video with its controls under the picture. */
  dom: HTMLElement;
  video: HTMLVideoElement;
}

/**
 * A video as it is shown in a note. Only the play button plays it; a click on the picture is
 * the caller's (it enlarges the video, as a click on a picture does).
 */
export function createVideoPlayer(
  /** Absent: the caller sets it when it is there. */
  src: string | undefined,
  opts: { onClick?: (video: HTMLVideoElement, event: MouseEvent) => void } = {},
): VideoPlayer {
  const dom = document.createElement('span');
  dom.className = 'pm-video';
  const video = document.createElement('video');
  video.className = 'pm-video-picture';
  video.preload = 'metadata';
  video.playsInline = true;
  if (src) video.src = src;
  video.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    opts.onClick?.(video, e);
  });
  dom.append(video, createVideoControls(video));
  return { dom, video };
}
