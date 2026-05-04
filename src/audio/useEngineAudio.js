import { useEffect, useRef } from 'react';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { MAX_RPM, MIN_RPM } from '../engine/simulation';
import { ENGINE_LOOPS, SHIFT_SOUNDS } from './audioAssets';

const LAYER_BASE_RPM = {
  idle: 1500,
  low: 3600,
  mid: 6900,
  high: 10100
};

const RATE_LIMIT = {
  min: 0.62,
  max: 1.7
};

const AUDIO_UPDATE_MS = 90;
const MASTER_HEADROOM = 0.68;
const MIN_UPDATE_DELTA = {
  rpm: 90,
  throttle: 0.025,
  volume: 0.015
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function setPlayerRate(player, rate) {
  if (!player) return;
  try {
    player.shouldCorrectPitch = false;
    if (typeof player.setPlaybackRate === 'function') {
      player.setPlaybackRate(rate);
    } else {
      player.playbackRate = rate;
    }
  } catch (error) {
    // Native players can be a frame late during reload.
  }
}

function setPlayerVolume(player, volume) {
  if (!player) return;
  try {
    player.volume = clamp(volume, 0, 1);
  } catch (error) {
    // Ignore readiness races.
  }
}

function startLoop(player) {
  if (!player) return;
  try {
    player.loop = true;
    player.play();
  } catch (error) {
    // Mobile audio starts after the first user gesture.
  }
}

function stopLoop(player) {
  if (!player) return;
  try {
    player.pause();
    player.seekTo(0);
  } catch (error) {
    // Ignore teardown races.
  }
}

function weightsForRpm(rpm) {
  const r = clamp((rpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);
  return {
    idle: 1 - smoothstep(0.06, 0.24, r),
    low: smoothstep(0.05, 0.25, r) * (1 - smoothstep(0.34, 0.54, r)),
    mid: smoothstep(0.32, 0.58, r) * (1 - smoothstep(0.68, 0.88, r)),
    high: smoothstep(0.62, 0.86, r)
  };
}

export function useEngineAudio({ enabled, rpm, throttle, volume, shiftEvent }) {
  const idle = useAudioPlayer(ENGINE_LOOPS.idle);
  const low = useAudioPlayer(ENGINE_LOOPS.low);
  const mid = useAudioPlayer(ENGINE_LOOPS.mid);
  const high = useAudioPlayer(ENGINE_LOOPS.high);
  const shiftUpA = useAudioPlayer(SHIFT_SOUNDS.up);
  const shiftUpB = useAudioPlayer(SHIFT_SOUNDS.up);
  const shiftDownA = useAudioPlayer(SHIFT_SOUNDS.down);
  const shiftDownB = useAudioPlayer(SHIFT_SOUNDS.down);
  const startedRef = useRef(false);
  const lastLoopUpdateRef = useRef({ at: 0, rpm: MIN_RPM, throttle: 0, volume: 0 });
  const processedShiftRef = useRef(null);
  const shiftPoolRef = useRef({ UP: 0, DOWN: 0 });

  const loopPlayers = { idle, low, mid, high };
  const shiftPools = {
    UP: [shiftUpA, shiftUpB],
    DOWN: [shiftDownA, shiftDownB]
  };

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: 'doNotMix'
    });
  }, []);

  useEffect(() => {
    if (enabled && !startedRef.current) {
      Object.values(loopPlayers).forEach(startLoop);
      startedRef.current = true;
    }
    if (!enabled && startedRef.current) {
      Object.values(loopPlayers).forEach(stopLoop);
      startedRef.current = false;
    }
  }, [enabled, idle, low, mid, high]);

  useEffect(() => {
    if (!enabled) return;

    const now = Date.now();
    const last = lastLoopUpdateRef.current;
    const meaningfulChange =
      Math.abs(rpm - last.rpm) >= MIN_UPDATE_DELTA.rpm ||
      Math.abs(throttle - last.throttle) >= MIN_UPDATE_DELTA.throttle ||
      Math.abs(volume - last.volume) >= MIN_UPDATE_DELTA.volume;

    if (now - last.at < AUDIO_UPDATE_MS && !meaningfulChange) {
      return;
    }

    lastLoopUpdateRef.current = { at: now, rpm, throttle, volume };

    const weights = weightsForRpm(rpm);
    const totalWeight = Math.max(1, Object.values(weights).reduce((sum, weight) => sum + weight, 0));
    const throttleGain = 0.24 + 0.76 * Math.pow(clamp(throttle, 0, 1), 0.72);
    const redlineGain = rpm > 10250 ? 0.9 + 0.08 * Math.sin(now / 34) : 1;

    Object.entries(loopPlayers).forEach(([layer, player]) => {
      const baseRpm = LAYER_BASE_RPM[layer];
      const rate = clamp(rpm / baseRpm, RATE_LIMIT.min, RATE_LIMIT.max);
      const normalizedWeight = weights[layer] / totalWeight;
      const layerVolume = volume * MASTER_HEADROOM * redlineGain * normalizedWeight * throttleGain;
      setPlayerRate(player, rate);
      setPlayerVolume(player, layerVolume);
    });
  }, [enabled, rpm, throttle, volume, idle, low, mid, high]);

  useEffect(() => {
    if (!enabled || !shiftEvent) return;
    if (processedShiftRef.current === shiftEvent.id) return;

    processedShiftRef.current = shiftEvent.id;

    const direction = shiftEvent.direction === 'UP' ? 'UP' : 'DOWN';
    const pool = shiftPools[direction];
    const nextIndex = shiftPoolRef.current[direction] % pool.length;
    shiftPoolRef.current[direction] = nextIndex + 1;
    const player = pool[nextIndex];

    try {
      player.volume = clamp(volume * 0.78 * (0.65 + 0.25 * throttle), 0, 0.9);
      Promise.resolve(player.seekTo(0))
        .then(() => player.play())
        .catch(() => {});
    } catch (error) {
      // A missed one-shot is acceptable during fast refresh.
    }
  }, [enabled, shiftEvent, shiftUpA, shiftUpB, shiftDownA, shiftDownB, volume, throttle]);
}
