/**
 * Built-in sound board effects, synthesised with Web Audio so they need no
 * downloads. Each one plays into the node it is given and stops by itself
 * after `durationSeconds`.
 */

export interface SoundEffect {
  id: string;
  name: string;
  icon: string;
  color: string;
  durationSeconds: number;
  play: (ctx: AudioContext, masterGain: AudioNode) => void;
}

function playApplause(ctx: AudioContext, masterGain: AudioNode) {
  const duration = 2.0;
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(2, bufferSize, ctx.sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < bufferSize; i++) {
      const t = i / ctx.sampleRate;
      // Envelope: ramp up then fade
      const env = Math.min(t / 0.15, 1) * Math.exp(-t / 1.4);
      // Shaped noise with random crackle bursts
      const crackle = Math.random() > 0.97 ? 2.5 : 1;
      data[i] = (Math.random() * 2 - 1) * env * 0.5 * crackle;
    }
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  // Band-pass to simulate clapping frequency
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2200;
  bp.Q.value = 0.6;

  src.connect(bp);
  bp.connect(masterGain);
  src.start();
}

function playDrumRoll(ctx: AudioContext, masterGain: AudioNode) {
  const duration = 1.5;
  const hits = 30;
  for (let i = 0; i < hits; i++) {
    const t = (i / hits) * duration;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 120 + Math.random() * 20;
    gain.gain.setValueAtTime(0.35, ctx.currentTime + t);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.06);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(ctx.currentTime + t);
    osc.stop(ctx.currentTime + t + 0.06);
  }
  // Final crash
  const noise = ctx.createBufferSource();
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.12));
  }
  noise.buffer = buf;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.4, ctx.currentTime + duration);
  ng.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration + 0.4);
  noise.connect(ng);
  ng.connect(masterGain);
  noise.start(ctx.currentTime + duration);
}

function playAirHorn(ctx: AudioContext, masterGain: AudioNode) {
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gain = ctx.createGain();

  osc1.type = 'sawtooth';
  osc2.type = 'sawtooth';

  osc1.frequency.setValueAtTime(300, ctx.currentTime);
  osc1.frequency.linearRampToValueAtTime(580, ctx.currentTime + 0.08);
  osc1.frequency.setValueAtTime(580, ctx.currentTime + 0.08);
  osc1.frequency.linearRampToValueAtTime(560, ctx.currentTime + 1.2);

  osc2.frequency.setValueAtTime(302, ctx.currentTime);
  osc2.frequency.linearRampToValueAtTime(584, ctx.currentTime + 0.08);
  osc2.frequency.setValueAtTime(584, ctx.currentTime + 0.08);
  osc2.frequency.linearRampToValueAtTime(564, ctx.currentTime + 1.2);

  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.05);
  gain.gain.setValueAtTime(0.3, ctx.currentTime + 0.9);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);

  const dist = ctx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i * 2) / 256 - 1;
    curve[i] = Math.tanh(x * 2);
  }
  dist.curve = curve;

  osc1.connect(dist);
  osc2.connect(dist);
  dist.connect(gain);
  gain.connect(masterGain);

  osc1.start();
  osc2.start();
  osc1.stop(ctx.currentTime + 1.3);
  osc2.stop(ctx.currentTime + 1.3);
}

function playRimShot(ctx: AudioContext, masterGain: AudioNode) {
  const now = ctx.currentTime;

  // "Ba"
  const bass1 = ctx.createOscillator();
  const g1 = ctx.createGain();
  bass1.frequency.setValueAtTime(180, now);
  bass1.frequency.exponentialRampToValueAtTime(80, now + 0.12);
  g1.gain.setValueAtTime(0.4, now);
  g1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  bass1.connect(g1);
  g1.connect(masterGain);
  bass1.start(now);
  bass1.stop(now + 0.15);

  // "dum"
  const bass2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  bass2.frequency.setValueAtTime(160, now + 0.25);
  bass2.frequency.exponentialRampToValueAtTime(70, now + 0.37);
  g2.gain.setValueAtTime(0.4, now + 0.25);
  g2.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
  bass2.connect(g2);
  g2.connect(masterGain);
  bass2.start(now + 0.25);
  bass2.stop(now + 0.4);

  // "tss" (hi-hat)
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
  const noiseData = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) {
    noiseData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.04));
  }
  const noiseSrc = ctx.createBufferSource();
  noiseSrc.buffer = noiseBuf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7000;
  const g3 = ctx.createGain();
  g3.gain.setValueAtTime(0.5, now + 0.5);
  g3.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
  noiseSrc.connect(hp);
  hp.connect(g3);
  g3.connect(masterGain);
  noiseSrc.start(now + 0.5);
}

function playCrickets(ctx: AudioContext, masterGain: AudioNode) {
  const duration = 2.0;
  // Multiple chirps
  for (let c = 0; c < 6; c++) {
    const startTime = ctx.currentTime + c * 0.3 + Math.random() * 0.05;
    const chirpDur = 0.12 + Math.random() * 0.05;

    const osc = ctx.createOscillator();
    const modOsc = ctx.createOscillator();
    const modGain = ctx.createGain();
    const envGain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = 4200 + Math.random() * 600;

    modOsc.type = 'sine';
    modOsc.frequency.value = 55 + Math.random() * 15;
    modGain.gain.value = 1800;

    modOsc.connect(modGain);
    modGain.connect(osc.frequency);

    envGain.gain.setValueAtTime(0.0001, startTime);
    envGain.gain.exponentialRampToValueAtTime(0.15, startTime + 0.005);
    envGain.gain.setValueAtTime(0.15, startTime + chirpDur * 0.7);
    envGain.gain.exponentialRampToValueAtTime(0.0001, startTime + chirpDur);

    osc.connect(envGain);
    envGain.connect(masterGain);

    osc.start(startTime);
    osc.stop(startTime + chirpDur + 0.01);
    modOsc.start(startTime);
    modOsc.stop(startTime + chirpDur + 0.01);
  }

  // Fade envelope for the whole thing
  const envAll = ctx.createGain();
  envAll.gain.setValueAtTime(1, ctx.currentTime);
  envAll.gain.setValueAtTime(1, ctx.currentTime + duration * 0.7);
  envAll.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);
}

function playSadTrombone(ctx: AudioContext, masterGain: AudioNode) {
  const notes = [
    { freq: 370, start: 0, dur: 0.35 },
    { freq: 349, start: 0.35, dur: 0.35 },
    { freq: 330, start: 0.7, dur: 0.35 },
    { freq: 311, start: 1.05, dur: 0.7 },
  ];

  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const vibrato = ctx.createOscillator();
    const vibGain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.value = note.freq;

    // Add vibrato on last note
    vibrato.frequency.value = 5;
    vibGain.gain.value = note === notes[notes.length - 1] ? 8 : 2;
    vibrato.connect(vibGain);
    vibGain.connect(osc.frequency);

    gain.gain.setValueAtTime(0.0001, ctx.currentTime + note.start);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + note.start + 0.04);
    gain.gain.setValueAtTime(0.15, ctx.currentTime + note.start + note.dur * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + note.start + note.dur);

    // Low pass for trombone tone
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;

    osc.connect(lp);
    lp.connect(gain);
    gain.connect(masterGain);

    osc.start(ctx.currentTime + note.start);
    osc.stop(ctx.currentTime + note.start + note.dur + 0.05);
    vibrato.start(ctx.currentTime + note.start);
    vibrato.stop(ctx.currentTime + note.start + note.dur + 0.05);
  }
}

function playDing(ctx: AudioContext, masterGain: AudioNode) {
  const freqs = [880, 1760, 2640];

  for (const freq of freqs) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;

    const amp = freq === 880 ? 0.3 : freq === 1760 ? 0.15 : 0.08;
    gain.gain.setValueAtTime(amp, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);

    osc.connect(gain);
    gain.connect(masterGain);
    osc.start();
    osc.stop(ctx.currentTime + 1.6);
  }
}

function playWhoosh(ctx: AudioContext, masterGain: AudioNode) {
  const duration = 0.6;
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 3;
  bp.frequency.setValueAtTime(200, ctx.currentTime);
  bp.frequency.exponentialRampToValueAtTime(4000, ctx.currentTime + duration * 0.4);
  bp.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + duration);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + duration * 0.25);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

  src.connect(bp);
  bp.connect(gain);
  gain.connect(masterGain);
  src.start();
}

export const BUILT_IN_SOUND_EFFECTS: SoundEffect[] = [
  { id: 'applause', name: 'Applause', icon: '\uD83D\uDC4F', color: '#f59e0b', durationSeconds: 2.0, play: playApplause },
  { id: 'drumroll', name: 'Drum Roll', icon: '\uD83E\uDD41', color: '#ef4444', durationSeconds: 1.9, play: playDrumRoll },
  { id: 'airhorn', name: 'Air Horn', icon: '\uD83D\uDCE2', color: '#f97316', durationSeconds: 1.3, play: playAirHorn },
  { id: 'rimshot', name: 'Ba-dum-tss', icon: '\uD83E\uDD39', color: '#8b5cf6', durationSeconds: 0.5, play: playRimShot },
  { id: 'crickets', name: 'Crickets', icon: '\uD83E\uDDA0', color: '#22c55e', durationSeconds: 2.0, play: playCrickets },
  { id: 'sadtrombone', name: 'Sad Trombone', icon: '\uD83C\uDFBA', color: '#3b82f6', durationSeconds: 1.8, play: playSadTrombone },
  { id: 'ding', name: 'Ding', icon: '\uD83D\uDD14', color: '#eab308', durationSeconds: 1.6, play: playDing },
  { id: 'whoosh', name: 'Whoosh', icon: '\uD83D\uDCA8', color: '#06b6d4', durationSeconds: 0.6, play: playWhoosh },
];
