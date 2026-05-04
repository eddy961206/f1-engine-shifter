import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'assets', 'audio');
const sampleRate = 44100;

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

function engineSample(phase, profile) {
  const p = phase * Math.PI * 2;
  const core =
    Math.sin(p) * 0.82 +
    Math.sin(p * 2) * 0.32 +
    Math.sin(p * 3) * 0.22 +
    Math.sin(p * 5) * 0.14 +
    Math.sin(p * 8) * 0.08;
  const exhaust = Math.sign(Math.sin(p * 0.5)) * Math.pow(Math.abs(Math.sin(p * 2.5)), 0.45);
  const rasp = cyclicNoise(p, profile.grit) * (0.25 + profile.rasp * 0.75);
  const whine = Math.sin(p * profile.whineMul + Math.sin(p * 0.25) * 0.08) * profile.whine;
  const mech = Math.sin(p * 13.7) * profile.mech + Math.sin(p * 17.4 + 0.4) * profile.mech * 0.55;
  return tanhDrive(core * profile.core + exhaust * profile.rasp + rasp + whine + mech, profile.drive);
}

function writeWav(name, samples) {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * channels * bytesPerSample;
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

  samples.forEach((sample, index) => {
    const value = clamp(sample, -1, 1);
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * bytesPerSample);
  });

  writeFileSync(join(outDir, name), buffer);
}

function generateLoop(name, rpm, durationSec, profile) {
  const total = Math.floor(sampleRate * durationSec);
  const firingHz = (rpm / 60) * 5;
  const samples = new Float32Array(total);

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const cyclePhase = (t * firingHz) % 1;
    const slowPhase = (i / total) * Math.PI * 2;
    const loadPulse = 0.88 + Math.sin(slowPhase * profile.loadRate) * 0.035;
    samples[i] = engineSample(cyclePhase, profile) * profile.amp * loadPulse;
  }

  writeWav(name, samples);
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

generateLoop('v10_idle.wav', 1500, 1.6, {
  amp: 0.54,
  core: 0.88,
  rasp: 0.12,
  grit: 0.08,
  whine: 0.02,
  whineMul: 9.0,
  mech: 0.03,
  drive: 1.8,
  loadRate: 2
});

generateLoop('v10_low.wav', 3600, 1.2, {
  amp: 0.55,
  core: 0.75,
  rasp: 0.24,
  grit: 0.13,
  whine: 0.04,
  whineMul: 10.5,
  mech: 0.04,
  drive: 2.25,
  loadRate: 3
});

generateLoop('v10_mid.wav', 6900, 1.0, {
  amp: 0.52,
  core: 0.58,
  rasp: 0.38,
  grit: 0.18,
  whine: 0.08,
  whineMul: 11.2,
  mech: 0.045,
  drive: 2.8,
  loadRate: 4
});

generateLoop('v10_high.wav', 10100, 0.8, {
  amp: 0.48,
  core: 0.42,
  rasp: 0.56,
  grit: 0.24,
  whine: 0.14,
  whineMul: 12.4,
  mech: 0.05,
  drive: 3.3,
  loadRate: 5
});

generateShiftUp();
generateShiftDown();

console.log(`Generated sound pack in ${outDir}`);
