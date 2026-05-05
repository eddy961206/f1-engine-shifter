import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'assets', 'audio');
const sampleRate = 44100;
const soundReport = [];

mkdirSync(outDir, { recursive: true });

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function tanhDrive(value, amount) {
  return Math.tanh(value * amount) / Math.tanh(amount);
}

function cyclicNoise(phase, grit) {
  return (
    Math.sin(phase * 19.0 + Math.sin(phase * 3.0) * 0.4) * 0.55 +
    Math.sin(phase * 41.0 + 1.7) * 0.28 +
    Math.sin(phase * 73.0 + 0.2) * 0.17
  ) * grit;
}

function targetPeakFor(name) {
  if (name.startsWith('v10_')) return 0.72;
  if (name === 'gear_whine.wav') return 0.42;
  if (name === 'airbox_scream.wav') return 0.34;
  if (name === 'lift_off.wav') return 0.52;
  if (name === 'throttle_on.wav') return 0.46;
  if (name.startsWith('overrun_')) return 0.48;
  if (name.startsWith('shift_')) return 0.64;
  return 0.58;
}

function measureSamples(samples) {
  const stereo = samples.left && samples.right;
  let peak = 0;
  let monoPeak = 0;
  let sumSquares = 0;
  let count = 0;

  if (stereo) {
    const sampleCount = Math.min(samples.left.length, samples.right.length);
    for (let index = 0; index < sampleCount; index += 1) {
      const left = samples.left[index];
      const right = samples.right[index];
      const mono = (left + right) * 0.5;
      peak = Math.max(peak, Math.abs(left), Math.abs(right));
      monoPeak = Math.max(monoPeak, Math.abs(mono));
      sumSquares += left * left + right * right;
      count += 2;
    }
  } else {
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index];
      peak = Math.max(peak, Math.abs(value));
      sumSquares += value * value;
      count += 1;
    }
    monoPeak = peak;
  }

  return {
    peak,
    rms: count > 0 ? Math.sqrt(sumSquares / count) : 0,
    monoPeak
  };
}

function scaleSamples(samples, gain) {
  if (samples.left && samples.right) {
    const sampleCount = Math.min(samples.left.length, samples.right.length);
    const left = new Float32Array(sampleCount);
    const right = new Float32Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      left[index] = samples.left[index] * gain;
      right[index] = samples.right[index] * gain;
    }
    return { left, right };
  }

  const rendered = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    rendered[index] = samples[index] * gain;
  }
  return rendered;
}

function normalizeSamples(name, samples) {
  const before = measureSamples(samples);
  const targetPeak = targetPeakFor(name);
  const gain = before.peak > 0 ? Math.min(targetPeak / before.peak, 1.8) : 1;
  const normalized = scaleSamples(samples, gain);
  const after = measureSamples(normalized);

  soundReport.push({
    name,
    targetPeak,
    gain,
    peak: after.peak,
    rms: after.rms,
    monoPeak: after.monoPeak,
    monoRatio: after.peak > 0 ? after.monoPeak / after.peak : 0
  });

  return normalized;
}

const V10_TEXTURE = [
  { gain: 1.04, rasp: 1.09, phase: 0.006, bank: -1 },
  { gain: 0.97, rasp: 0.94, phase: -0.004, bank: 1 },
  { gain: 1.02, rasp: 1.02, phase: 0.002, bank: -1 },
  { gain: 1.08, rasp: 1.14, phase: -0.007, bank: 1 },
  { gain: 0.95, rasp: 0.9, phase: 0.005, bank: -1 },
  { gain: 1.01, rasp: 1.05, phase: -0.002, bank: 1 },
  { gain: 0.98, rasp: 0.96, phase: 0.007, bank: -1 },
  { gain: 1.06, rasp: 1.11, phase: -0.005, bank: 1 },
  { gain: 0.96, rasp: 0.92, phase: 0.003, bank: -1 },
  { gain: 1.03, rasp: 1.07, phase: -0.006, bank: 1 }
];

function engineSample(phase, profile, cylinder) {
  const texture = V10_TEXTURE[cylinder % V10_TEXTURE.length];
  const texturedPhase = (phase + texture.phase + 1) % 1;
  const p = texturedPhase * Math.PI * 2;
  const core =
    Math.sin(p) * 0.82 +
    Math.sin(p * 2) * 0.32 +
    Math.sin(p * 3) * 0.22 +
    Math.sin(p * 5) * 0.14 +
    Math.sin(p * 8) * 0.08;
  const exhaust = Math.sign(Math.sin(p * 0.5)) * Math.pow(Math.abs(Math.sin(p * 2.5)), 0.45);
  const bankRasp = Math.sin(p * 0.5 + texture.bank * profile.bankColor) * profile.bankColor * 0.12;
  const rasp = cyclicNoise(p + texture.bank * profile.bankColor, profile.grit) * (0.25 + profile.rasp * texture.rasp * 0.75);
  const whine = Math.sin(p * profile.whineMul + Math.sin(p * 0.25) * 0.08) * profile.whine;
  const mech = Math.sin(p * 13.7) * profile.mech + Math.sin(p * 17.4 + 0.4) * profile.mech * 0.55;
  return tanhDrive((core * profile.core + exhaust * profile.rasp + rasp + bankRasp + whine + mech) * texture.gain, profile.drive);
}

function writeWav(name, samples) {
  const normalizedSamples = normalizeSamples(name, samples);
  const stereo = normalizedSamples.left && normalizedSamples.right;
  const channels = stereo ? 2 : 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = stereo ? Math.min(normalizedSamples.left.length, normalizedSamples.right.length) : normalizedSamples.length;
  const dataSize = sampleCount * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    if (stereo) {
      const left = clamp(normalizedSamples.left[index], -1, 1);
      const right = clamp(normalizedSamples.right[index], -1, 1);
      const offset = 44 + index * channels * bytesPerSample;
      buffer.writeInt16LE(Math.round(left * 32767), offset);
      buffer.writeInt16LE(Math.round(right * 32767), offset + bytesPerSample);
    } else {
      const value = clamp(normalizedSamples[index], -1, 1);
      buffer.writeInt16LE(Math.round(value * 32767), 44 + index * bytesPerSample);
    }
  }

  writeFileSync(join(outDir, name), buffer);
}

function equalPowerPan(sample, pan) {
  const angle = (clamp(pan, -1, 1) + 1) * Math.PI * 0.25;
  return {
    left: sample * Math.cos(angle) * Math.SQRT2,
    right: sample * Math.sin(angle) * Math.SQRT2
  };
}

function generateLoop(name, rpm, cycles, profile) {
  const firingHz = (rpm / 60) * 5;
  const durationSec = cycles / firingHz;
  const total = Math.round(sampleRate * durationSec);
  const left = new Float32Array(total);
  const right = new Float32Array(total);

  for (let i = 0; i < total; i += 1) {
    const loopPhase = i / total;
    const cyclePosition = loopPhase * cycles;
    const cyclePhase = cyclePosition % 1;
    const cylinder = Math.floor(cyclePosition) % V10_TEXTURE.length;
    const texture = V10_TEXTURE[cylinder];
    const slowPhase = (i / total) * Math.PI * 2;
    const loadPulse = 0.88 + Math.sin(slowPhase * profile.loadRate) * 0.035;
    const sample = engineSample(cyclePhase, profile, cylinder) * profile.amp * loadPulse;
    const rendered = equalPowerPan(sample, texture.bank * profile.stereoWidth);
    left[i] = rendered.left;
    right[i] = rendered.right;
  }

  writeWav(name, { left, right });
}

function generateShiftUp() {
  const total = Math.floor(sampleRate * 0.16);
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 24) * Math.min(1, t * 180);
    const chirpHz = 2100 * Math.pow(0.46, t / 0.16);
    const phase = Math.PI * 2 * chirpHz * t;
    const noise = cyclicNoise(phase, 0.5);
    samples[i] = tanhDrive((Math.sin(phase) * 0.5 + noise * 0.35) * env, 2.7) * 0.72;
  }
  writeWav('shift_up.wav', samples);
}

function generateShiftDown() {
  const total = Math.floor(sampleRate * 0.22);
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 14) * Math.min(1, t * 90);
    const sweepHz = 520 + 860 * Math.exp(-t * 10);
    const phase = Math.PI * 2 * sweepHz * t;
    const pop = t > 0.045 && t < 0.075 ? cyclicNoise(phase, 0.4) * 0.5 : 0;
    samples[i] = tanhDrive((Math.sin(phase) * 0.62 + pop) * env, 3.0) * 0.78;
  }
  writeWav('shift_down.wav', samples);
}

function generateGearWhine() {
  const total = Math.floor(sampleRate * 1.1);
  const samples = new Float32Array(total);
  const cycles = 820;

  for (let i = 0; i < total; i += 1) {
    const loopPhase = i / total;
    const phase = Math.PI * 2 * cycles * loopPhase;
    const shimmer = Math.sin(Math.PI * 2 * 17 * loopPhase) * 0.035;
    const whine =
      Math.sin(phase + shimmer) * 0.62 +
      Math.sin(phase * 2.01 + 0.3) * 0.22 +
      Math.sin(phase * 3.02 + 1.2) * 0.08;
    samples[i] = tanhDrive(whine, 1.6) * 0.38;
  }

  writeWav('gear_whine.wav', samples);
}

function generateLiftOff() {
  const total = Math.floor(sampleRate * 0.18);
  const samples = new Float32Array(total);

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 22) * Math.min(1, t * 150);
    const raspPhase = Math.PI * 2 * (780 + 540 * Math.exp(-t * 18)) * t;
    const bark = Math.sin(raspPhase) * 0.38 + cyclicNoise(raspPhase, 0.62) * 0.55;
    const pop = t > 0.03 && t < 0.065 ? cyclicNoise(raspPhase * 1.4, 0.7) * 0.5 : 0;
    samples[i] = tanhDrive((bark + pop) * env, 3.1) * 0.52;
  }

  writeWav('lift_off.wav', samples);
}

function generateThrottleOn() {
  const total = Math.floor(sampleRate * 0.12);
  const samples = new Float32Array(total);

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const attack = Math.min(1, t * 260);
    const env = attack * Math.exp(-t * 32);
    const chirpHz = 1100 + 1750 * Math.exp(-t * 26);
    const phase = Math.PI * 2 * chirpHz * t;
    const intake = Math.sin(phase) * 0.34 + Math.sin(phase * 1.54 + 0.8) * 0.18;
    const rasp = cyclicNoise(phase * 0.8 + 2.3, 0.58) * 0.42;
    samples[i] = tanhDrive((intake + rasp) * env, 2.9) * 0.44;
  }

  writeWav('throttle_on.wav', samples);
}

function generateOverrunPop(name, seed, brightness) {
  const total = Math.floor(sampleRate * 0.11);
  const samples = new Float32Array(total);

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const env = Math.exp(-t * (36 + seed * 3)) * Math.min(1, t * 240);
    const crackPhase = Math.PI * 2 * (520 + brightness * 760 * Math.exp(-t * 28)) * t;
    const snap = t < 0.026 ? cyclicNoise(crackPhase * (1.3 + seed * 0.08), 0.9) * 0.55 : 0;
    const tail = Math.sin(crackPhase + seed) * 0.28 + cyclicNoise(crackPhase * 0.7 + seed, 0.46) * 0.35;
    samples[i] = tanhDrive((snap + tail) * env, 3.7) * 0.48;
  }

  writeWav(name, samples);
}

function generateAirboxScream() {
  const total = Math.floor(sampleRate * 1.0);
  const samples = new Float32Array(total);
  const cycles = 510;

  for (let i = 0; i < total; i += 1) {
    const loopPhase = i / total;
    const phase = Math.PI * 2 * cycles * loopPhase;
    const flutter = Math.sin(Math.PI * 2 * 11 * loopPhase) * 0.04 + Math.sin(Math.PI * 2 * 23 * loopPhase + 0.6) * 0.018;
    const scream =
      Math.sin(phase + flutter) * 0.44 +
      Math.sin(phase * 1.5 + 1.1) * 0.24 +
      Math.sin(phase * 2.02 + 0.4) * 0.12 +
      cyclicNoise(phase * 0.23, 0.12);
    samples[i] = tanhDrive(scream, 1.9) * 0.34;
  }

  writeWav('airbox_scream.wav', samples);
}

generateLoop('v10_idle.wav', 1500, 200, {
  amp: 0.54,
  core: 0.88,
  rasp: 0.12,
  grit: 0.08,
  whine: 0.02,
  whineMul: 9.0,
  mech: 0.03,
  bankColor: 0.04,
  stereoWidth: 0.18,
  drive: 1.8,
  loadRate: 2
});

generateLoop('v10_low.wav', 3600, 360, {
  amp: 0.55,
  core: 0.75,
  rasp: 0.24,
  grit: 0.13,
  whine: 0.04,
  whineMul: 10.5,
  mech: 0.04,
  bankColor: 0.06,
  stereoWidth: 0.24,
  drive: 2.25,
  loadRate: 3
});

generateLoop('v10_mid.wav', 6900, 580, {
  amp: 0.52,
  core: 0.58,
  rasp: 0.38,
  grit: 0.18,
  whine: 0.08,
  whineMul: 11.2,
  mech: 0.045,
  bankColor: 0.09,
  stereoWidth: 0.3,
  drive: 2.8,
  loadRate: 4
});

generateLoop('v10_high.wav', 10100, 670, {
  amp: 0.48,
  core: 0.42,
  rasp: 0.56,
  grit: 0.24,
  whine: 0.14,
  whineMul: 12.4,
  mech: 0.05,
  bankColor: 0.12,
  stereoWidth: 0.36,
  drive: 3.3,
  loadRate: 5
});

generateShiftUp();
generateShiftDown();
generateGearWhine();
generateLiftOff();
generateThrottleOn();
generateOverrunPop('overrun_a.wav', 1, 0.74);
generateOverrunPop('overrun_b.wav', 2, 0.92);
generateAirboxScream();

console.log(`Generated sound pack in ${outDir}`);
console.log('Sound pack level report:');
soundReport.forEach(({ name, targetPeak, gain, peak, rms, monoRatio }) => {
  const monoNote = name.startsWith('v10_') ? ` mono=${monoRatio.toFixed(2)}` : '';
  console.log(
    `- ${name}: target=${targetPeak.toFixed(2)} gain=${gain.toFixed(2)} peak=${peak.toFixed(2)} rms=${rms.toFixed(3)}${monoNote}`
  );
});
