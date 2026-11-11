/** The sounds of the canvas: short soft sine plucks on a pentatonic scale, so any run of them is in tune. No audio files. */
export type Sound = 'unfold' | 'fold' | 'added' | 'changed';

const KEY = 'appling.canvas.sound';
const SCALE = [0, 2, 4, 7, 9];
let context: AudioContext | undefined;

export function soundOn(): boolean {
    try {
        return localStorage.getItem(KEY) !== 'off';
    } catch {
        return true;
    }
}

export function setSound(on: boolean): void {
    try {
        localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch { /* a host without storage keeps the choice for this page only */ }
}

/** One note `step` steps up the scale from middle C, `at` seconds from now, sliding in from `glide` times its pitch. */
function pluck(audio: AudioContext, step: number, at: number, glide: number, volume = 0.05): void {
    const start = audio.currentTime + at;
    const pitch = 261.63 * 2 ** ((SCALE[step % 5] + 12 * Math.floor(step / 5)) / 12);
    const [oscillator, gain] = [audio.createOscillator(), audio.createGain()];
    oscillator.frequency.setValueAtTime(pitch * glide, start);
    oscillator.frequency.exponentialRampToValueAtTime(pitch, start + 0.07);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.35);
}

/**
 * Plays a sound when they are on. Browsers allow audio only after a press, so only a call with `gesture` starts it;
 * the sounds of model changes stay silent until then. An unfold plays one rising note per new shoot (`count`), higher
 * the further up the plant (`depth`).
 */
export function play(sound: Sound, { count = 1, depth = 0, gesture = false } = {}): void {
    if (!soundOn() || typeof AudioContext === 'undefined') return;
    if (!context && !gesture) return;
    const audio = context ??= new AudioContext();
    const base = 5 + Math.min(depth, 4);
    if (sound === 'unfold') for (let i = 0; i < Math.min(count, 5); i++) pluck(audio, base + i, i * 0.06, 0.75);
    if (sound === 'fold') [base + 2, base].forEach((step, i) => pluck(audio, step, i * 0.07, 1.3, 0.04));
    if (sound === 'added') [7, 9, 12].forEach((step, i) => pluck(audio, step, i * 0.09, 1, 0.04));
    if (sound === 'changed') [11, 13].forEach((step, i) => pluck(audio, step, i * 0.08, 0.6, 0.035));
}
