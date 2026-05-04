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
  const shiftUp = useAudioPlayer(SHIFT_SOUNDS.up);
  const shiftDown = useAudioPlayer(SHIFT_SOUNDS.down);
  const startedRef = useRef(false);

  const loopPlayers = { idle, low, mid, high };

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

    const weights = weightsForRpm(rpm);
    const throttleGain = 0.24 + 0.76 * Math.pow(clamp(throttle, 0, 1), 0.72);
    const redlineGain = rpm > 10250 ? 0.92 + Math.random() * 0.08 : 1;

    Object.entries(loopPlayers).forEach(([layer, player]) => {
      const baseRpm = LAYER_BASE_RPM[layer];
      const rate = clamp(rpm / baseRpm, 0.52, 1.82);
      const layerVolume = volume * redlineGain * weights[layer] * throttleGain;
      setPlayerRate(player, rate);
      setPlayerVolume(player, layerVolume);
    });
  }, [enabled, rpm, throttle, volume, idle, low, mid, high]);

  useEffect(() => {
    if (!enabled || !shiftEvent) return;
    const player = shiftEvent.direction === 'UP' ? shiftUp : shiftDown;
    try {
      player.volume = clamp(volume * (0.65 + 0.25 * throttle), 0, 1);
      player.seekTo(0);
      player.play();
    } catch (error) {
      // A missed one-shot is acceptable during fast refresh.
    }
  }, [enabled, shiftEvent, shiftUp, shiftDown, volume, throttle]);
}
