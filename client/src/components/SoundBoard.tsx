import { useState, useRef, useCallback, useEffect } from 'react';

interface SoundBoardProps {
  onClose: () => void;
}

interface SoundEffect {
  id: string;
  name: string;
  icon: string;
  color: string;
  play: (ctx: AudioContext, masterGain: GainNode) => void;
}

// ---------------------------------------------------------------------------
// Synthesised sound effects using Web Audio API
// ---------------------------------------------------------------------------

function playApplause(ctx: AudioContext, masterGain: GainNode) {
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

function playDrumRoll(ctx: AudioContext, masterGain: GainNode) {
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

function playAirHorn(ctx: AudioContext, masterGain: GainNode) {
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

function playRimShot(ctx: AudioContext, masterGain: GainNode) {
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

function playCrickets(ctx: AudioContext, masterGain: GainNode) {
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

function playSadTrombone(ctx: AudioContext, masterGain: GainNode) {
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

function playDing(ctx: AudioContext, masterGain: GainNode) {
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

function playWhoosh(ctx: AudioContext, masterGain: GainNode) {
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

// ---------------------------------------------------------------------------
// Effects list
// ---------------------------------------------------------------------------

const effects: SoundEffect[] = [
  { id: 'applause', name: 'Applause', icon: '\uD83D\uDC4F', color: '#f59e0b', play: playApplause },
  { id: 'drumroll', name: 'Drum Roll', icon: '\uD83E\uDD41', color: '#ef4444', play: playDrumRoll },
  { id: 'airhorn', name: 'Air Horn', icon: '\uD83D\uDCE2', color: '#f97316', play: playAirHorn },
  { id: 'rimshot', name: 'Ba-dum-tss', icon: '\uD83E\uDD39', color: '#8b5cf6', play: playRimShot },
  { id: 'crickets', name: 'Crickets', icon: '\uD83E\uDDA0', color: '#22c55e', play: playCrickets },
  { id: 'sadtrombone', name: 'Sad Trombone', icon: '\uD83C\uDFBA', color: '#3b82f6', play: playSadTrombone },
  { id: 'ding', name: 'Ding', icon: '\uD83D\uDD14', color: '#eab308', play: playDing },
  { id: 'whoosh', name: 'Whoosh', icon: '\uD83D\uDCA8', color: '#06b6d4', play: playWhoosh },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CustomSound {
  id: string;
  name: string;
  buffer: AudioBuffer;
}

export function SoundBoard({ onClose }: SoundBoardProps) {
  const [volume, setVolume] = useState(0.7);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [customSounds, setCustomSounds] = useState<CustomSound[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Close AudioContext on unmount
  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
      masterGainRef.current = audioCtxRef.current.createGain();
      masterGainRef.current.gain.value = volume;
      masterGainRef.current.connect(audioCtxRef.current.destination);
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    masterGainRef.current!.gain.value = volume;
    return { ctx: audioCtxRef.current, masterGain: masterGainRef.current! };
  }, [volume]);

  const handlePlay = useCallback((effect: SoundEffect) => {
    const { ctx, masterGain } = getAudioContext();
    setPlayingId(effect.id);
    effect.play(ctx, masterGain);
    setTimeout(() => setPlayingId(null), 300);
  }, [getAudioContext]);

  const handlePlayCustom = useCallback((sound: CustomSound) => {
    const { ctx, masterGain } = getAudioContext();
    setPlayingId(sound.id);
    const src = ctx.createBufferSource();
    src.buffer = sound.buffer;
    src.connect(masterGain);
    src.start();
    setTimeout(() => setPlayingId(null), 300);
  }, [getAudioContext]);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = v;
    }
  }, []);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const { ctx } = getAudioContext();
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const id = `custom-${Date.now()}`;
      const name = file.name.replace(/\.[^/.]+$/, '');
      setCustomSounds((prev) => [...prev, { id, name, buffer: audioBuffer }]);
    } catch {
      // Could not decode audio file
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [getAudioContext]);

  const handleRemoveCustom = useCallback((id: string) => {
    setCustomSounds((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div style={styles.overlay} onClick={handleOverlayClick}>
      <div style={styles.panel}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
            <span style={styles.headerTitle}>Sound Board</span>
          </div>
          <button style={styles.closeBtn} onClick={onClose} title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Volume */}
        <div style={styles.volumeRow}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          </svg>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={handleVolumeChange}
            style={styles.volumeSlider}
          />
          <span style={styles.volumeLabel}>{Math.round(volume * 100)}%</span>
        </div>

        {/* Effects grid */}
        <div style={styles.grid}>
          {effects.map((effect) => (
            <button
              key={effect.id}
              style={{
                ...styles.effectBtn,
                borderColor: playingId === effect.id ? effect.color : 'var(--border)',
                boxShadow: playingId === effect.id
                  ? `0 0 12px ${effect.color}44, inset 0 0 20px ${effect.color}11`
                  : 'none',
                transform: playingId === effect.id ? 'scale(0.95)' : 'scale(1)',
              }}
              onClick={() => handlePlay(effect)}
            >
              <span style={styles.effectIcon}>{effect.icon}</span>
              <span style={styles.effectName}>{effect.name}</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="var(--text-muted)"
                style={styles.playIcon}
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </button>
          ))}
        </div>

        {/* Custom sounds */}
        {customSounds.length > 0 && (
          <>
            <div style={styles.divider} />
            <div style={styles.customSection}>
              <span style={styles.sectionLabel}>Custom Sounds</span>
              <div style={styles.customGrid}>
                {customSounds.map((sound) => (
                  <div key={sound.id} style={styles.customItem}>
                    <button
                      style={{
                        ...styles.customPlayBtn,
                        borderColor: playingId === sound.id ? 'var(--accent)' : 'var(--border)',
                      }}
                      onClick={() => handlePlayCustom(sound)}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--text-muted)">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      <span style={styles.customName}>{sound.name}</span>
                    </button>
                    <button
                      style={styles.removeBtn}
                      onClick={() => handleRemoveCustom(sound.id)}
                      title="Remove"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Upload section */}
        <div style={styles.divider} />
        <div style={styles.uploadSection}>
          {showUpload ? (
            <div style={styles.uploadArea}>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                onChange={handleFileUpload}
                style={styles.fileInput}
                id="sound-upload"
              />
              <label htmlFor="sound-upload" style={styles.uploadLabel}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>Choose audio file</span>
              </label>
              <button
                style={styles.cancelUploadBtn}
                onClick={() => setShowUpload(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              style={styles.addSoundBtn}
              onClick={() => setShowUpload(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Upload Custom Sound
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    backdropFilter: 'blur(4px)',
  },
  panel: {
    width: 420,
    maxWidth: '92vw',
    maxHeight: '85vh',
    overflowY: 'auto',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text-primary)',
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  volumeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-muted)',
  },
  volumeSlider: {
    flex: 1,
    height: 4,
    cursor: 'pointer',
    accentColor: 'var(--accent)',
  },
  volumeLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    minWidth: 32,
    textAlign: 'right',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8,
    padding: 16,
  },
  effectBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '14px 4px 10px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'all 0.1s ease',
    position: 'relative',
    color: 'var(--text-primary)',
  },
  effectIcon: {
    fontSize: 22,
    lineHeight: 1,
  },
  effectName: {
    fontSize: 10,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    textAlign: 'center',
    lineHeight: 1.2,
  },
  playIcon: {
    position: 'absolute',
    top: 4,
    right: 4,
    opacity: 0.4,
  },
  divider: {
    height: 1,
    background: 'var(--border)',
    margin: '0 16px',
  },
  customSection: {
    padding: '12px 16px',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 8,
    display: 'block',
  },
  customGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  customItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  customPlayBtn: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: 'pointer',
    color: 'var(--text-primary)',
    fontSize: 12,
    transition: 'all 0.1s ease',
  },
  customName: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  removeBtn: {
    width: 24,
    height: 24,
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  uploadSection: {
    padding: '12px 16px 16px',
  },
  uploadArea: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  fileInput: {
    display: 'none',
  },
  uploadLabel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '12px',
    borderRadius: 8,
    border: '1px dashed var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  cancelUploadBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: 11,
    cursor: 'pointer',
    padding: '4px 8px',
  },
  addSoundBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    width: '100%',
    padding: '8px',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
};
