import { useEffect, useRef } from 'react';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { MAX_RPM, MIN_RPM } from '../engine/simulation';
import { AIRBOX_SCREAM, DRIVE_SOUNDS, ENGINE_LOOPS, GEAR_WHINE, SHIFT_SOUNDS } from './audioAssets';

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
const LIMITER_START_RPM = 10250;
const LOOP_RATE_DELTA = 0.004;
const LOOP_VOLUME_DELTA = 0.006;
const SILENT_LOOP_VOLUME = 0.003;
const MIN_UPDATE_DELTA = {
  rpm: 90,
  rpmVel: 220,
  throttle: 0.025,
  volume: 0.015
};

const SHIFT_FX = {
  UP: {
    durationMs: 135,
    cutFloor: 0.34,
    rateDip: 0.965
  },
  DOWN: {
    durationMs: 180,
    blipGain: 0.3,
    rateBoost: 1.035
  }
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function slew(current, target, amount) {
  return current + (target - current) * clamp(amount, 0, 1);
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

function applyLoopParams(cacheRef, key, player, { rate, volume, force = false }) {
  const targetRate = clamp(rate, RATE_LIMIT.min, RATE_LIMIT.max);
  const targetVolume = clamp(volume, 0, 1);
  const cache = cacheRef.current[key] || {};
  const audible = targetVolume >= SILENT_LOOP_VOLUME;
  const rateChanged = typeof cache.rate !== 'number' || Math.abs(targetRate - cache.rate) >= LOOP_RATE_DELTA;
  const volumeChanged =
    typeof cache.volume !== 'number' ||
    Math.abs(targetVolume - cache.volume) >= LOOP_VOLUME_DELTA ||
    (targetVolume === 0 && cache.volume !== 0);

  if (audible && (force || rateChanged)) {
    setPlayerRate(player, targetRate);
    cache.rate = targetRate;
  }

  if (force || volumeChanged) {
    setPlayerVolume(player, targetVolume);
    cache.volume = targetVolume;
  }

  cacheRef.current[key] = cache;
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

function limiterPulse(rpm, now) {
  if (rpm < LIMITER_START_RPM) {
    return { gain: 1, highPush: 1 };
  }

  const intensity = clamp((rpm - LIMITER_START_RPM) / (MAX_RPM - LIMITER_START_RPM), 0, 1);
  const phase = (now / (58 - 18 * intensity)) % 1;
  const cut = phase < 0.34 + intensity * 0.2 ? 1 : 0;
  const gain = cut ? 1 - intensity * 0.38 : 0.84 + intensity * 0.1;

  return {
    gain,
    highPush: 1 + intensity * 0.32
  };
}

function shiftEnvelope(fx, now) {
  if (!fx) {
    return { active: false, loopGain: 1, rateFactor: 1, throttleBoost: 0 };
  }

  const elapsed = now - fx.startedAt;
  const progress = clamp(elapsed / fx.durationMs, 0, 1);
  if (progress >= 1) {
    return { active: false, loopGain: 1, rateFactor: 1, throttleBoost: 0 };
  }

  const release = smoothstep(0.18, 1, progress);
  if (fx.direction === 'UP') {
    return {
      active: true,
      loopGain: fx.cutFloor + (1 - fx.cutFloor) * release,
      rateFactor: fx.rateDip + (1 - fx.rateDip) * release,
      throttleBoost: 0
    };
  }

  const blip = 1 - smoothstep(0.2, 1, progress);
  return {
    active: true,
    loopGain: 1 + fx.blipGain * blip,
    rateFactor: 1 + (fx.rateBoost - 1) * blip,
    throttleBoost: 0.18 * blip
  };
}

function driveToneFor({ rpm, rpmVel, throttle, brakeHeld }) {
  const rpmNorm = clamp((rpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);
  const accel = clamp(rpmVel / 7200, -1, 1);
  const positiveLoad = clamp(throttle * 0.85 + Math.max(accel, 0) * 0.35, 0, 1);
  const engineBrake = clamp((brakeHeld ? 0.55 : 0) + Math.max(-accel, 0) * 0.7 + (1 - throttle) * 0.18, 0, 1);

  return {
    loopGain: clamp(0.86 + positiveLoad * 0.18 - engineBrake * 0.2, 0.68, 1.12),
    highBias: clamp(1 + positiveLoad * 0.28 + rpmNorm * 0.1 - engineBrake * 0.16, 0.84, 1.38),
    lowBias: clamp(1 + engineBrake * 0.22 - positiveLoad * 0.08, 0.88, 1.24),
    rateLeadRpm: clamp(rpm + Math.max(accel, 0) * 260 - Math.max(-accel, 0) * 180, MIN_RPM, MAX_RPM),
    whineGain: clamp(0.9 + positiveLoad * 0.18 + engineBrake * 0.25, 0.82, 1.32)
  };
}

function oneShotVariation(kind, rpm, throttle, seed) {
  const rpmNorm = clamp((rpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);
  const jitter = Math.sin(seed * 12.9898) * 0.5 + Math.sin(seed * 78.233) * 0.5;
  const jitterNorm = jitter - Math.trunc(jitter);
  const randomOffset = (jitterNorm - 0.5) * 0.05;

  if (kind === 'UP') {
    return {
      rate: clamp(0.98 + rpmNorm * 0.1 + randomOffset, 0.94, 1.12),
      gain: clamp(0.68 + throttle * 0.24 + rpmNorm * 0.16 + randomOffset, 0.55, 1)
    };
  }

  if (kind === 'DOWN') {
    return {
      rate: clamp(0.91 + rpmNorm * 0.08 + randomOffset, 0.86, 1.04),
      gain: clamp(0.74 + throttle * 0.16 + rpmNorm * 0.12 - randomOffset, 0.58, 1)
    };
  }

  return {
    rate: clamp(0.95 + rpmNorm * 0.08 + randomOffset, 0.9, 1.08),
    gain: clamp(0.82 + rpmNorm * 0.18 - randomOffset, 0.68, 1)
  };
}

function shiftCatchRpm(fx, fallbackRpm) {
  if (!fx || !fx.startedAt || !fx.rpmBefore || !fx.rpmAfter) {
    return fallbackRpm;
  }

  const elapsed = Date.now() - fx.startedAt;
  const progress = clamp(elapsed / fx.durationMs, 0, 1);
  if (progress >= 1) {
    return fallbackRpm;
  }

  if (fx.direction === 'UP') {
    if (progress < 0.2) {
      return fx.rpmBefore;
    }
    const catchProgress = smoothstep(0.2, 1, progress);
    return fx.rpmBefore + (fx.rpmAfter - fx.rpmBefore) * catchProgress;
  }

  const overshoot = clamp((fx.rpmBefore - fx.rpmAfter) * 0.08, 120, 360);
  const peak = Math.min(MAX_RPM, fx.rpmAfter + overshoot);
  if (progress < 0.34) {
    const up = smoothstep(0, 0.34, progress);
    return fx.rpmBefore + (peak - fx.rpmBefore) * up;
  }

  const down = smoothstep(0.34, 1, progress);
  return peak + (fx.rpmAfter - peak) * down;
}

export function useEngineAudio({ enabled, rpm, rpmVel, gear, throttle, throttleHeld, brakeHeld, volume, shiftEvent }) {
  const idle = useAudioPlayer(ENGINE_LOOPS.idle);
  const low = useAudioPlayer(ENGINE_LOOPS.low);
  const mid = useAudioPlayer(ENGINE_LOOPS.mid);
  const high = useAudioPlayer(ENGINE_LOOPS.high);
  const gearWhine = useAudioPlayer(GEAR_WHINE);
  const airbox = useAudioPlayer(AIRBOX_SCREAM);
  const liftOff = useAudioPlayer(DRIVE_SOUNDS.liftOff);
  const throttleOnA = useAudioPlayer(DRIVE_SOUNDS.throttleOn);
  const throttleOnB = useAudioPlayer(DRIVE_SOUNDS.throttleOn);
  const overrunA = useAudioPlayer(DRIVE_SOUNDS.overrunA);
  const overrunB = useAudioPlayer(DRIVE_SOUNDS.overrunB);
  const shiftUpA = useAudioPlayer(SHIFT_SOUNDS.up);
  const shiftUpB = useAudioPlayer(SHIFT_SOUNDS.up);
  const shiftDownA = useAudioPlayer(SHIFT_SOUNDS.down);
  const shiftDownB = useAudioPlayer(SHIFT_SOUNDS.down);
  const startedRef = useRef(false);
  const lastLoopUpdateRef = useRef({ at: 0, rpm: MIN_RPM, rpmVel: 0, throttle: 0, volume: 0 });
  const appliedParamsRef = useRef({});
  const processedShiftRef = useRef(null);
  const shiftPoolRef = useRef({ UP: 0, DOWN: 0 });
  const shiftFxRef = useRef(null);
  const previousThrottleHeldRef = useRef(false);
  const liftSeedRef = useRef(0);
  const throttleOnPoolRef = useRef(0);
  const overrunRef = useRef({ nextAt: 0, pool: 0 });
  const audioMotionRef = useRef({
    rpm: MIN_RPM,
    volume: {
      idle: 0,
      low: 0,
      mid: 0,
      high: 0,
      gearWhine: 0,
      airbox: 0
    }
  });

  const engineLoopPlayers = { idle, low, mid, high };
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
    const loopPlayers = [...Object.values(engineLoopPlayers), gearWhine, airbox];

    if (enabled && !startedRef.current) {
      appliedParamsRef.current = {};
      loopPlayers.forEach((player) => setPlayerVolume(player, 0));
      loopPlayers.forEach(startLoop);
      startedRef.current = true;
    }
    if (!enabled && startedRef.current) {
      loopPlayers.forEach((player) => setPlayerVolume(player, 0));
      loopPlayers.forEach(stopLoop);
      audioMotionRef.current.rpm = MIN_RPM;
      Object.keys(audioMotionRef.current.volume).forEach((key) => {
        audioMotionRef.current.volume[key] = 0;
      });
      appliedParamsRef.current = {};
      startedRef.current = false;
    }
  }, [enabled, idle, low, mid, high, gearWhine, airbox]);

  useEffect(() => {
    if (!enabled) return;

    const now = Date.now();
    const shiftFx = shiftEnvelope(shiftFxRef.current, now);
    if (!shiftFx.active) {
      shiftFxRef.current = null;
    }
    const forceLoopUpdate = shiftFx.active || rpm >= LIMITER_START_RPM;

    const last = lastLoopUpdateRef.current;
    const meaningfulChange =
      Math.abs(rpm - last.rpm) >= MIN_UPDATE_DELTA.rpm ||
      Math.abs(rpmVel - last.rpmVel) >= MIN_UPDATE_DELTA.rpmVel ||
      Math.abs(throttle - last.throttle) >= MIN_UPDATE_DELTA.throttle ||
      Math.abs(volume - last.volume) >= MIN_UPDATE_DELTA.volume;

    if (now - last.at < AUDIO_UPDATE_MS && !meaningfulChange && !shiftFx.active) {
      return;
    }

    lastLoopUpdateRef.current = { at: now, rpm, rpmVel, throttle, volume };

    const driveTone = driveToneFor({ rpm, rpmVel, throttle, brakeHeld });
    const motion = audioMotionRef.current;
    const rpmSlew = clamp(0.2 + Math.abs(rpmVel) / 18000 + throttle * 0.08, 0.18, 0.48);
    const catchTargetRpm = shiftCatchRpm(shiftFxRef.current, driveTone.rateLeadRpm);
    motion.rpm = slew(motion.rpm || rpm, catchTargetRpm, shiftFx.active ? 0.62 : rpmSlew);
    const audibleRpm = motion.rpm;

    const weights = weightsForRpm(audibleRpm);
    const limiter = limiterPulse(rpm, now);
    weights.high *= limiter.highPush;
    weights.high *= driveTone.highBias;
    weights.mid *= 0.94 + driveTone.highBias * 0.06;
    weights.low *= driveTone.lowBias;

    const totalWeight = Math.max(1, Object.values(weights).reduce((sum, weight) => sum + weight, 0));
    const audibleThrottle = clamp(throttle + shiftFx.throttleBoost, 0, 1);
    const throttleGain = 0.24 + 0.76 * Math.pow(audibleThrottle, 0.72);

    Object.entries(engineLoopPlayers).forEach(([layer, player]) => {
      const baseRpm = LAYER_BASE_RPM[layer];
      const rate = clamp((audibleRpm / baseRpm) * shiftFx.rateFactor, RATE_LIMIT.min, RATE_LIMIT.max);
      const normalizedWeight = weights[layer] / totalWeight;
      const targetVolume = volume * MASTER_HEADROOM * limiter.gain * shiftFx.loopGain * driveTone.loopGain * normalizedWeight * throttleGain;
      motion.volume[layer] = slew(motion.volume[layer] || 0, targetVolume, shiftFx.active ? 0.72 : 0.34);
      applyLoopParams(appliedParamsRef, `engine:${layer}`, player, {
        rate,
        volume: motion.volume[layer],
        force: forceLoopUpdate
      });
    });

    const rpmNorm = clamp((audibleRpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);
    const whineGear = clamp(gear || 1, 1, 8);
    const whineRate = clamp(0.72 + rpmNorm * 0.78 + whineGear * 0.045, 0.72, 1.72);
    const whineVolume = volume * 0.16 * driveTone.whineGain * smoothstep(0.2, 0.72, rpmNorm) * (0.55 + 0.45 * audibleThrottle);
    motion.volume.gearWhine = slew(motion.volume.gearWhine || 0, whineVolume, 0.38);
    applyLoopParams(appliedParamsRef, 'gearWhine', gearWhine, {
      rate: whineRate,
      volume: motion.volume.gearWhine,
      force: forceLoopUpdate
    });

    const airboxRate = clamp(0.82 + rpmNorm * 0.94 + throttle * 0.08, 0.82, 1.86);
    const airboxVolume = volume * 0.105 * smoothstep(0.64, 0.94, rpmNorm) * Math.pow(audibleThrottle, 0.7);
    motion.volume.airbox = slew(motion.volume.airbox || 0, airboxVolume, 0.42);
    applyLoopParams(appliedParamsRef, 'airbox', airbox, {
      rate: airboxRate,
      volume: motion.volume.airbox,
      force: forceLoopUpdate
    });

    const overrunChance = smoothstep(5200, 9500, rpm) * clamp((-rpmVel - 450) / 5200, 0, 1) * (brakeHeld ? 1 : 0.45);
    if (now >= overrunRef.current.nextAt && overrunChance > 0.18 && throttle < 0.42) {
      const pool = [overrunA, overrunB];
      const index = overrunRef.current.pool % pool.length;
      overrunRef.current.pool = index + 1;
      overrunRef.current.nextAt = now + 150 + (1 - overrunChance) * 260;
      const player = pool[index];
      const variation = oneShotVariation('LIFT', rpm, throttle, overrunRef.current.pool + Math.round(rpm));

      try {
        setPlayerRate(player, clamp(variation.rate + index * 0.035, 0.88, 1.14));
        player.volume = clamp(volume * 0.18 * variation.gain * overrunChance, 0, 0.24);
        Promise.resolve(player.seekTo(0))
          .then(() => player.play())
          .catch(() => {});
      } catch (error) {
        // Overrun pops are optional texture.
      }
    }
  }, [enabled, rpm, rpmVel, gear, throttle, brakeHeld, volume, idle, low, mid, high, gearWhine, airbox, overrunA, overrunB]);

  useEffect(() => {
    const wasHeld = previousThrottleHeldRef.current;
    previousThrottleHeldRef.current = Boolean(throttleHeld);

    if (enabled && !wasHeld && throttleHeld && !brakeHeld && rpm >= 1800) {
      throttleOnPoolRef.current += 1;
      const pool = [throttleOnA, throttleOnB];
      const player = pool[throttleOnPoolRef.current % pool.length];
      const variation = oneShotVariation('LIFT', rpm, throttle, throttleOnPoolRef.current + Math.round(rpm));

      try {
        setPlayerRate(player, clamp(variation.rate + 0.04, 0.94, 1.16));
        player.volume = clamp(volume * 0.135 * variation.gain * smoothstep(1800, 6800, rpm), 0, 0.22);
        Promise.resolve(player.seekTo(0))
          .then(() => player.play())
          .catch(() => {});
      } catch (error) {
        // Throttle-on snap is decorative.
      }
    }

    if (!enabled || !wasHeld || throttleHeld || brakeHeld || rpm < 4200 || throttle < 0.35) {
      return;
    }

    try {
      liftSeedRef.current += 1;
      const variation = oneShotVariation('LIFT', rpm, throttle, liftSeedRef.current);
      setPlayerRate(liftOff, variation.rate);
      liftOff.volume = clamp(volume * 0.22 * variation.gain * smoothstep(4200, MAX_RPM, rpm), 0, 0.3);
      Promise.resolve(liftOff.seekTo(0))
        .then(() => liftOff.play())
        .catch(() => {});
    } catch (error) {
      // Lift-off bark is decorative; skip if the player is not ready.
    }
  }, [enabled, throttleHeld, brakeHeld, rpm, throttle, volume, liftOff, throttleOnA, throttleOnB]);

  useEffect(() => {
    if (!enabled || !shiftEvent) return;
    if (processedShiftRef.current === shiftEvent.id) return;

    processedShiftRef.current = shiftEvent.id;

    const direction = shiftEvent.direction === 'UP' ? 'UP' : 'DOWN';
    shiftFxRef.current = {
      startedAt: Date.now(),
      direction,
      rpmBefore: shiftEvent.rpmBefore || rpm,
      rpmAfter: shiftEvent.rpmAfter || rpm,
      ...SHIFT_FX[direction]
    };
    lastLoopUpdateRef.current.at = 0;

    const pool = shiftPools[direction];
    const nextIndex = shiftPoolRef.current[direction] % pool.length;
    shiftPoolRef.current[direction] = nextIndex + 1;
    const player = pool[nextIndex];

    try {
      const variation = oneShotVariation(direction, shiftEvent.rpmBefore || rpm, throttle, shiftEvent.id + nextIndex);
      setPlayerRate(player, variation.rate);
      player.volume = clamp(volume * 0.78 * variation.gain * (0.65 + 0.25 * throttle), 0, 0.96);
      Promise.resolve(player.seekTo(0))
        .then(() => player.play())
        .catch(() => {});
    } catch (error) {
      // A missed one-shot is acceptable during fast refresh.
    }
  }, [enabled, shiftEvent, shiftUpA, shiftUpB, shiftDownA, shiftDownB, volume, throttle, rpm]);
}
