// Every sound is synthesised in WebAudio: no audio files.

let ctx: AudioContext | null = null;
let muted = false;
const ac = (): AudioContext | null => {
  if (muted) return null;
  try { ctx ??= new AudioContext(); if (ctx.state === 'suspended') void ctx.resume(); return ctx; } catch { return null; }
};
export const setMuted = (m: boolean): void => { muted = m; };
export const isMuted = (): boolean => muted;

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.15, slide = 0): void {
  const a = ac(); if (!a) return;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.value = freq;
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), a.currentTime + dur);
  g.gain.setValueAtTime(vol, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + dur);
}
function noise(dur: number, vol = 0.12, hp = 1200): void {
  const a = ac(); if (!a) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = a.createBufferSource(); s.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
  const g = a.createGain(); g.gain.value = vol;
  s.connect(f).connect(g).connect(a.destination); s.start();
}

export const sfx = {
  chop: (): void => { noise(0.05, 0.2, 2500); tone(180, 0.05, 'square', 0.05); },
  pick: (): void => tone(660, 0.07, 'triangle', 0.08, 200),
  place: (): void => tone(330, 0.08, 'triangle', 0.08, -80),
  trash: (): void => noise(0.18, 0.1, 400),
  deliver: (): void => { tone(880, 0.12, 'sine', 0.15); setTimeout(() => tone(1320, 0.25, 'sine', 0.15), 110); },
  wrong: (): void => tone(160, 0.3, 'sawtooth', 0.1, -60),
  burn: (): void => { noise(0.4, 0.12, 800); tone(120, 0.4, 'sawtooth', 0.06); },
  cooked: (): void => tone(1046, 0.1, 'sine', 0.1),
  sabotaged: (): void => { tone(300, 0.15, 'square', 0.1, -200); setTimeout(() => tone(200, 0.2, 'square', 0.08, -100), 120); },
  cast: (): void => tone(500, 0.2, 'triangle', 0.1, 600),
  order: (): void => tone(740, 0.08, 'sine', 0.06),
  tick: (): void => tone(1000, 0.04, 'square', 0.04),
  go: (): void => { tone(523, 0.12); setTimeout(() => tone(784, 0.3), 120); },
};
