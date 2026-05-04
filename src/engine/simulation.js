export const MIN_RPM = 1000;
export const MAX_RPM = 11000;
export const MIN_GEAR = 1;
export const MAX_GEAR = 8;

const GEAR_UP_RPM = [0, 7200, 7900, 8600, 9300, 10000, 10600, 11000, 11000];
const GEAR_DOWN_RPM = [0, 2600, 3300, 4100, 4900, 5800, 6800, 7800, 8800];
const GEAR_RATIO = [0, 3.2, 2.55, 2.1, 1.8, 1.58, 1.4, 1.26, 1.14];

const ENGINE = {
  throttleAttackSec: 0.075,
  throttleReleaseSec: 0.24,
  accelBase: 7600,
  brakeBase: 8800,
  footBrakeBase: 14200,
  damping: 7.0,
  idleSpring: 3.8,
  idleOnlyBelowThrottle: 0.12,
  limiterStart: 0.982,
  limiterStrength: 1.4,
  limiterBounce: 0.24,
  maxRpmVel: 30000,
  shiftCooldownSec: 0.13,
  upshiftExtraDrop: 0.985,
  downshiftExtraBlipRpm: 220
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function expApproach(current, target, dt, tau) {
  const safeTau = Math.max(0.001, tau);
  const amount = 1 - Math.exp(-dt / safeTau);
  return current + (target - current) * amount;
}

function torqueCurve(rpmNorm) {
  return 0.34 + 0.66 * (1 - Math.pow(rpmNorm, 1.85));
}

function brakeCurve(rpmNorm) {
  return 0.25 + 0.75 * Math.pow(rpmNorm, 0.9);
}

function updateThrottle(state, input, dt) {
  const target = input.running && input.throttleHeld ? 1 : 0;
  const tau = target > state.throttle ? ENGINE.throttleAttackSec : ENGINE.throttleReleaseSec;
  return clamp(expApproach(state.throttle, target, dt, tau), 0, 1);
}

export function createInitialEngineState() {
  return {
    rpm: MIN_RPM,
    rpmVel: 0,
    throttle: 0,
    gear: MIN_GEAR,
    shiftCooldown: 0,
    shift: null
  };
}

export function shiftGear(state, direction) {
  const nextGear = direction === 'UP' ? state.gear + 1 : state.gear - 1;
  if (nextGear < MIN_GEAR || nextGear > MAX_GEAR) {
    return { ...state, shift: null };
  }

  const ratioFrom = GEAR_RATIO[state.gear] || 1;
  const ratioTo = GEAR_RATIO[nextGear] || 1;
  const ratio = ratioTo / ratioFrom;
  let rpm = clamp(state.rpm * ratio, MIN_RPM, MAX_RPM);
  let rpmVel = state.rpmVel * ratio;

  if (direction === 'UP') {
    rpm = clamp(rpm * ENGINE.upshiftExtraDrop, MIN_RPM, MAX_RPM);
    rpmVel -= 900;
  } else {
    rpm = clamp(rpm + ENGINE.downshiftExtraBlipRpm, MIN_RPM, MAX_RPM);
    rpmVel += 1100;
  }

  return {
    ...state,
    rpm,
    rpmVel,
    gear: nextGear,
    shiftCooldown: ENGINE.shiftCooldownSec,
    shift: direction
  };
}

function maybeAutoShift(state, input) {
  if (!input.autoShift || state.shiftCooldown > 0) return state;
  if (state.gear < MAX_GEAR && state.rpm >= GEAR_UP_RPM[state.gear] && state.throttle > 0.25) {
    return shiftGear(state, 'UP');
  }
  if (state.gear > MIN_GEAR && state.rpm <= GEAR_DOWN_RPM[state.gear] && state.throttle < 0.72) {
    return shiftGear(state, 'DOWN');
  }
  return state;
}

export function stepEngine(state, input, dt) {
  const safeDt = clamp(dt, 0, 0.25);
  const throttle = updateThrottle(state, input, safeDt);
  const gearFactor = GEAR_RATIO[state.gear] / GEAR_RATIO[MAX_GEAR];
  const rpmNorm = clamp((state.rpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);

  let rpmAccel = 0;
  rpmAccel += throttle * ENGINE.accelBase * gearFactor * torqueCurve(rpmNorm);
  rpmAccel -= (1 - throttle) * ENGINE.brakeBase * gearFactor * brakeCurve(rpmNorm);

  if (input.brakeHeld) {
    rpmAccel -= ENGINE.footBrakeBase * gearFactor * (0.38 + 0.62 * rpmNorm);
  }

  rpmAccel -= ENGINE.damping * state.rpmVel;

  if (!input.running) {
    rpmAccel -= ENGINE.brakeBase * 0.5;
  }

  if (throttle < ENGINE.idleOnlyBelowThrottle) {
    rpmAccel += (MIN_RPM - state.rpm) * ENGINE.idleSpring;
  }

  if (throttle > 0.2 && rpmNorm > ENGINE.limiterStart) {
    const over = (rpmNorm - ENGINE.limiterStart) / (1 - ENGINE.limiterStart);
    rpmAccel -= ENGINE.accelBase * ENGINE.limiterStrength * over * over;
  }

  let rpmVel = clamp(state.rpmVel + rpmAccel * safeDt, -ENGINE.maxRpmVel, ENGINE.maxRpmVel);
  let rpm = state.rpm + rpmVel * safeDt;

  if (rpm < MIN_RPM) {
    rpm = MIN_RPM;
    if (rpmVel < 0) rpmVel *= -0.15;
  }

  if (rpm > MAX_RPM) {
    rpm = MAX_RPM;
    if (rpmVel > 0) rpmVel *= -ENGINE.limiterBounce;
  }

  const stepped = {
    ...state,
    rpm,
    rpmVel,
    throttle,
    shiftCooldown: Math.max(0, state.shiftCooldown - safeDt),
    shift: null
  };

  return maybeAutoShift(stepped, input);
}
