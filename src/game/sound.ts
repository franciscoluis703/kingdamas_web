const MOVE_SOUND_KEY = "kingdamas-move-sound";
const BACKGROUND_SOUND_KEY = "kingdamas-background-sound";
const BACKGROUND_VOLUME_KEY = "kingdamas-background-volume";
const BACKGROUND_TRACK_URL = "/audio/cozy-puzzle-clear-mix.mp3";
const MOVE_SOUND_URL = "/audio/step-wood-03.mp3";
const CAPTURE_SOUND_URL = "/audio/gun-reload-click.mp3";

const DEFAULT_MOVE_SOUND = true;
const DEFAULT_BACKGROUND_SOUND = true;
const DEFAULT_BACKGROUND_VOLUME = 0.2;
const MOVE_EFFECT_VOLUME = 0.6;
const CAPTURE_EFFECT_VOLUME = 0.55;

export const AUDIO_CREDITS = Object.freeze({
  title: "Cozy Puzzle (Clear Mix)",
  creator: "glitchart",
  creatorUrl: "https://opengameart.org/users/glitchart",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  effects: Object.freeze({
    movement: Object.freeze({
      title: "12 Step wood 03",
      creator: "leohpaz",
      sourceUrl: "https://opengameart.org/users/leohpaz",
      licenses: Object.freeze([
        Object.freeze({ label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" }),
        Object.freeze({ label: "CC BY 3.0", url: "https://creativecommons.org/licenses/by/3.0/" }),
      ]),
    }),
    capture: Object.freeze({
      title: "Gun reload, lock or click sound",
      creator: "Paulius Jurgelevičius (pauliuw)",
      sourceUrl: "https://opengameart.org/content/gun-reload-lock-or-click-sound",
      license: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    }),
  }),
});

let backgroundTrack: HTMLAudioElement | null = null;
let backgroundRequested = false;
let unlockListenersAttached = false;
const effectPools = new Map<string, HTMLAudioElement[]>();
const effectIndexes = new Map<string, number>();

function stored(key: string, fallback: boolean) {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === "on";
}

function storedBackgroundVolume() {
  const value = Number.parseFloat(localStorage.getItem(BACKGROUND_VOLUME_KEY) || "");
  if (!Number.isFinite(value)) return DEFAULT_BACKGROUND_VOLUME;
  return Math.min(Math.max(value, 0), 1);
}

export const soundPreferences = () => ({
  moves: stored(MOVE_SOUND_KEY, DEFAULT_MOVE_SOUND),
  background: stored(BACKGROUND_SOUND_KEY, DEFAULT_BACKGROUND_SOUND),
  backgroundVolume: storedBackgroundVolume(),
});

function createBackgroundTrack() {
  if (backgroundTrack) return backgroundTrack;
  backgroundTrack = new Audio(BACKGROUND_TRACK_URL);
  backgroundTrack.loop = true;
  backgroundTrack.preload = "auto";
  backgroundTrack.volume = storedBackgroundVolume();
  return backgroundTrack;
}

function removeUnlockListeners() {
  if (!unlockListenersAttached) return;
  document.removeEventListener("pointerdown", unlockBackground, true);
  document.removeEventListener("keydown", unlockBackground, true);
  unlockListenersAttached = false;
}

function attachUnlockListeners() {
  if (unlockListenersAttached) return;
  unlockListenersAttached = true;
  document.addEventListener("pointerdown", unlockBackground, { capture: true, once: true });
  document.addEventListener("keydown", unlockBackground, { capture: true, once: true });
}

async function tryBackgroundPlayback() {
  if (!backgroundRequested || !stored(BACKGROUND_SOUND_KEY, DEFAULT_BACKGROUND_SOUND)) return;
  try {
    await createBackgroundTrack().play();
    removeUnlockListeners();
  } catch {
    // Chrome puede exigir una interacción antes de iniciar música. El
    // siguiente toque o tecla vuelve a intentarlo dentro del gesto permitido.
    attachUnlockListeners();
  }
}

function unlockBackground() {
  removeUnlockListeners();
  void tryBackgroundPlayback();
}

function effectPool(url: string, volume: number) {
  const existing = effectPools.get(url);
  if (existing) return existing;
  const pool = Array.from({ length: 6 }, () => {
    const sound = new Audio(url);
    sound.preload = "auto";
    sound.volume = volume;
    return sound;
  });
  effectPools.set(url, pool);
  effectIndexes.set(url, 0);
  return pool;
}

function playEffect(url: string, volume: number) {
  const pool = effectPool(url, volume);
  const index = effectIndexes.get(url) || 0;
  const sound = pool[index]!;
  effectIndexes.set(url, (index + 1) % pool.length);
  sound.pause();
  sound.currentTime = 0;
  void sound.play().catch(() => {});
}

export function setMoveSound(enabled: boolean) {
  localStorage.setItem(MOVE_SOUND_KEY, enabled ? "on" : "off");
  if (enabled) playMoveSound(0);
}

export function playCaptureSound(captures = 1) {
  if (!stored(MOVE_SOUND_KEY, DEFAULT_MOVE_SOUND)) return;
  const audibleCaptures = Math.min(Math.max(Math.round(captures), 1), 6);
  for (let index = 0; index < audibleCaptures; index += 1) {
    window.setTimeout(() => {
      if (stored(MOVE_SOUND_KEY, DEFAULT_MOVE_SOUND)) playEffect(CAPTURE_SOUND_URL, CAPTURE_EFFECT_VOLUME);
    }, index * 95);
  }
}

export function playMoveSound(captures: boolean | number = 0) {
  const captureCount = typeof captures === "boolean" ? Number(captures) : captures;
  if (captureCount > 0) {
    playCaptureSound(captureCount);
    return;
  }
  if (!stored(MOVE_SOUND_KEY, DEFAULT_MOVE_SOUND)) return;
  playEffect(MOVE_SOUND_URL, MOVE_EFFECT_VOLUME);
}

export function startBackgroundSound() {
  backgroundRequested = true;
  effectPool(MOVE_SOUND_URL, MOVE_EFFECT_VOLUME);
  effectPool(CAPTURE_SOUND_URL, CAPTURE_EFFECT_VOLUME);
  if (!stored(BACKGROUND_SOUND_KEY, DEFAULT_BACKGROUND_SOUND)) return;
  void tryBackgroundPlayback();
}

export function stopBackgroundSound() {
  backgroundRequested = false;
  removeUnlockListeners();
  backgroundTrack?.pause();
}

export function setBackgroundSound(enabled: boolean) {
  localStorage.setItem(BACKGROUND_SOUND_KEY, enabled ? "on" : "off");
  if (enabled) startBackgroundSound();
  else stopBackgroundSound();
}

export function setBackgroundVolume(volume: number) {
  const safeVolume = Number.isFinite(volume)
    ? Math.min(Math.max(volume, 0), 1)
    : DEFAULT_BACKGROUND_VOLUME;
  localStorage.setItem(BACKGROUND_VOLUME_KEY, String(safeVolume));
  if (backgroundTrack) backgroundTrack.volume = safeVolume;
}
