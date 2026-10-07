"""Soundtrack for the 40-second launch film, synthesized note by note.

No samples, no music models, no loops: every sound below is built from oscillators,
noise and filters in numpy. Run from the film directory:

    uv run --with numpy --with soundfile python music/score.py

Writes music/bgm.wav (40.0 s, 48 kHz, stereo, 24-bit), the three SFX files, and
../beats.json (relative to this file), which is the only timing source the visuals read.

Form (120 BPM, 4/4, bar = 2.0 s):
  bar 1        sub pulses on beats 1-3, impact on beat 4 (1.5 s)
  bars 2-3     kick + 8th hats, pad Am9 -> Fmaj7
  bars 4-5     16th hats, Cmaj7 -> G6
  bars 6-8     + Karplus-Strong pluck arpeggio; riser 15.0-15.75, silence 15.75-16.0
  bars 9-11    impact at 16.0, full groove, saw sub bass on the root
  bars 12-14   breakdown: Am9 pad opening up, heartbeat kick
  bars 15-16   lift to C major, C G Am F (two chords per bar), FM bell arpeggio
  bars 17-18   same, full energy, 16th hats, pluck back in
  bars 19-20   drums out, Am(add9) pedal + 4-note motif, final chord at 38.0,
               1.5 s fade, digital silence from 39.5
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf

FS = 48_000
BPM = 120
BEAT = 60.0 / BPM  # 0.5 s
BAR = 4 * BEAT  # 2.0 s
S16 = BEAT / 4  # 16th note, 0.125 s
LENGTH = 40.0
N_OUT = int(round(LENGTH * FS))
N_BUF = N_OUT + 4 * FS  # tail room while rendering; cut to 40.0 s at the end

HERE = Path(__file__).resolve().parent
FILM = HERE.parent

RNG = np.random.default_rng(20261007)

# ---------------------------------------------------------------- sync points
SCENES = {
    "teaser": 0.0,
    "bug": 2.0,
    "contract": 6.0,
    "columns": 10.0,
    "verdict": 16.0,
    "evidence": 22.0,
    "repair": 28.0,
    "ledger": 32.0,
    "end": 36.0,
}
HITS = {"teaserImpact": 1.5, "riser": 15.0, "verdictImpact": 16.0, "finalChord": 38.0}
RISER_END = 15.75
GAP_END = 16.0
FADE_START = 38.0
SILENCE = 39.5


# ---------------------------------------------------------------- utilities
def midi_hz(m: float) -> float:
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def n(name: str) -> float:
    """'A3' -> Hz."""
    pitch, octave = name[:-1], int(name[-1])
    return midi_hz(12 * (octave + 1) + NOTE[pitch])


def tsamp(t: float) -> int:
    return int(round(t * FS))


def fftconv(x: np.ndarray, h: np.ndarray) -> np.ndarray:
    """Linear convolution along the last axis, output trimmed to len(x)."""
    L = x.shape[-1] + h.shape[-1] - 1
    nfft = 1 << (L - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, nfft) * np.fft.rfft(h, nfft), nfft)
    return y[..., : x.shape[-1]]


def onepole_kernel(fc: float) -> np.ndarray:
    a = np.exp(-2 * np.pi * fc / FS)
    K = int(np.ceil(np.log(1e-6) / np.log(a))) + 1
    return (1 - a) * a ** np.arange(K)


def lowpass(x: np.ndarray, fc: float, poles: int = 1) -> np.ndarray:
    """Cascade of one-pole low-passes (6 dB/oct per pole), fixed cutoff."""
    h = onepole_kernel(fc)
    for _ in range(poles - 1):
        h = np.convolve(h, onepole_kernel(fc))
    return fftconv(x, h)


def highpass(x: np.ndarray, fc: float) -> np.ndarray:
    return x - lowpass(x, fc)


def spectral_band(x: np.ndarray, lo: float, hi: float, order: float = 4.0) -> np.ndarray:
    """Zero-phase smooth band-pass by spectral weighting (for short noise buffers)."""
    nfft = 1 << (len(x) - 1).bit_length()
    X = np.fft.rfft(x, nfft)
    f = np.fft.rfftfreq(nfft, 1 / FS)
    f[0] = 1e-3
    w = 1.0 / np.sqrt(1 + (lo / f) ** (2 * order)) / np.sqrt(1 + (f / hi) ** (2 * order))
    return np.fft.irfft(X * w, nfft)[: len(x)]


def fades(sig: np.ndarray, fin: float = 0.002, fout: float = 0.008) -> np.ndarray:
    """Raised-cosine fade in/out on the last axis, so no note starts or stops on a step."""
    m = sig.shape[-1]
    a = min(int(fin * FS), m // 2)
    b = min(int(fout * FS), m // 2)
    env = np.ones(m)
    if a > 0:
        env[:a] = 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    if b > 0:
        env[m - b :] = 0.5 + 0.5 * np.cos(np.pi * np.arange(1, b + 1) / b)
    return sig * env


def adsr(m: int, a: float, d: float, s: float, rel: float, hold: float) -> np.ndarray:
    """Envelope of length m samples: attack, decay to sustain, held until `hold` s, release."""
    t = np.arange(m) / FS
    env = np.where(t < a, 0.5 - 0.5 * np.cos(np.pi * np.clip(t / max(a, 1e-6), 0, 1)), 1.0)
    dec = s + (1 - s) * np.exp(-np.clip(t - a, 0, None) / max(d, 1e-6))
    env = np.where(t >= a, dec, env)
    rel_t = np.clip(t - hold, 0, None)
    level_at_hold = s + (1 - s) * np.exp(-max(hold - a, 0) / max(d, 1e-6))
    rel_curve = level_at_hold * np.cos(0.5 * np.pi * np.clip(rel_t / rel, 0, 1))
    env = np.where(t >= hold, np.minimum(env, rel_curve), env)
    return env


def pan(mono: np.ndarray, p: float) -> np.ndarray:
    """Equal-power pan, p in [-1, 1]."""
    th = (p + 1) * np.pi / 4
    return np.stack([np.cos(th) * mono, np.sin(th) * mono])


# ---------------------------------------------------------------- oscillators
def saw_blep(freq: float, m: int, phase0: float | None = None) -> np.ndarray:
    """Band-limited sawtooth (polyBLEP), amplitude +-1."""
    dt = freq / FS
    if phase0 is None:
        phase0 = RNG.random()
    t = (phase0 + dt * np.arange(m)) % 1.0
    y = 2 * t - 1
    lo = t < dt
    x = t[lo] / dt
    y[lo] -= x + x - x * x - 1
    hi = t > 1 - dt
    x = (t[hi] - 1) / dt
    y[hi] -= x * x + x + x + 1
    return y


def sine(freq: float, m: int, phase0: float = 0.0) -> np.ndarray:
    return np.sin(2 * np.pi * (phase0 + freq * np.arange(m) / FS))


# ---------------------------------------------------------------- voices
def kick(f0: float = 150, f1: float = 45, sweep: float = 0.045, decay: float = 0.30, dur: float = 0.5,
         click: float = 0.12, drive: float = 1.8) -> np.ndarray:
    m = int(dur * FS)
    t = np.arange(m) / FS
    f = f1 + (f0 - f1) * np.exp(-t / sweep)
    ph = 2 * np.pi * np.cumsum(f) / FS
    env = (1 - np.exp(-t / 0.0007)) * np.exp(-t / decay)
    body = np.sin(ph) * env
    body = np.tanh(drive * body) / np.tanh(drive)
    cl = spectral_band(RNG.standard_normal(m), 1500, 6000, 2) * np.exp(-t / 0.0025)
    cl /= np.max(np.abs(cl)) + 1e-12
    out = body + click * cl
    return fades(out, 0.0004, 0.02)


def heartbeat() -> np.ndarray:
    lub = kick(f0=110, f1=42, sweep=0.04, decay=0.16, dur=0.35, click=0.0, drive=1.2)
    dub = 0.6 * kick(f0=100, f1=40, sweep=0.035, decay=0.13, dur=0.3, click=0.0, drive=1.1)
    out = np.zeros(int(0.6 * FS))
    out[: len(lub)] += lub
    o = int(0.21 * FS)
    out[o : o + len(dub)] += dub
    return lowpass(out, 900, 2)


def hat(vel: float = 1.0) -> np.ndarray:
    m = int(0.06 * FS)
    t = np.arange(m) / FS
    x = spectral_band(RNG.standard_normal(m), 6500, 12500, 3)
    x /= np.max(np.abs(x)) + 1e-12
    env = (1 - np.exp(-t / 0.0004)) * np.exp(-t / 0.011)  # ~30 ms audible tail
    return fades(vel * x * env, 0.0003, 0.01)


def sub_pulse() -> np.ndarray:
    m = int(0.08 * FS)
    t = np.arange(m) / FS
    env = np.sin(np.pi * t / 0.08) ** 1.5  # 80 ms envelope, zero at both ends
    return sine(55.0, m) * env


def impact() -> np.ndarray:
    """Kick + 40 Hz boom + noise burst, 600 ms. Transient is at sample 0."""
    m = int(0.6 * FS)
    t = np.arange(m) / FS
    k = np.zeros(m)
    kk = kick(f0=170, f1=48, sweep=0.05, decay=0.22, dur=0.6, click=0.25, drive=2.4)
    k[: len(kk)] = kk
    fb = 40 + 14 * np.exp(-t / 0.08)
    boom = np.sin(2 * np.pi * np.cumsum(fb) / FS) * (1 - np.exp(-t / 0.003)) * np.exp(-t / 0.26)
    nz = RNG.standard_normal((2, m))
    nz = np.stack([spectral_band(c, 120, 5000, 2) for c in nz])
    nz /= np.max(np.abs(nz)) + 1e-12
    nz *= (1 - np.exp(-t / 0.0006)) * np.exp(-t / 0.07)
    mono = 0.9 * k + 0.75 * np.tanh(1.5 * boom)
    out = np.stack([mono, mono]) + 0.45 * nz
    env_tail = np.cos(0.5 * np.pi * np.clip((t - 0.45) / 0.15, 0, 1))
    return fades(out * env_tail, 0.0003, 0.01)


def riser(dur: float = 0.75, f_lo: float = 400, f_hi: float = 8000) -> np.ndarray:
    """White noise through a resonant state-variable filter sweeping f_lo -> f_hi."""
    m = int(round(dur * FS))
    t = np.arange(m) / FS
    fc = f_lo * (f_hi / f_lo) ** (t / dur)
    g = np.tan(np.pi * fc / FS)
    k = 1 / 2.2  # Q = 2.2
    a1 = 1 / (1 + g * (g + k))
    a2 = g * a1
    a3 = g * a2
    out = np.zeros((2, m))
    for c in range(2):
        x = RNG.standard_normal(m)
        ic1 = ic2 = 0.0
        y = np.empty(m)
        for i in range(m):
            v3 = x[i] - ic2
            v1 = a1[i] * ic1 + a2[i] * v3
            v2 = ic2 + a2[i] * ic1 + a3[i] * v3
            ic1 = 2 * v1 - ic1
            ic2 = 2 * v2 - ic2
            y[i] = 0.55 * v1 + 0.45 * v2  # band + low: airy whoosh with body
        out[c] = y
    out /= np.max(np.abs(out)) + 1e-12
    amp = (t / dur) ** 2.2
    return fades(out * amp, 0.005, 0.004)


def tick() -> np.ndarray:
    m = int(0.06 * FS)
    t = np.arange(m) / FS
    click = spectral_band(RNG.standard_normal(m), 2000, 9000, 2) * np.exp(-t / 0.0006)
    click *= t < 0.002
    click /= np.max(np.abs(click)) + 1e-12
    blip = sine(3000, m) * (1 - np.exp(-t / 0.0005)) * np.exp(-t / 0.012)
    mono = fades(0.5 * click + 0.8 * blip, 0.0002, 0.01)
    return np.stack([mono, mono])


def pad_note(freq: float, hold: float, rel: float = 0.6, att: float = 0.25, cutoff=(1800, 1800),
             detune_cents: float = 9.0) -> np.ndarray:
    """Three detuned polyBLEP saws, centre voice in both channels, outer voices split L/R,
    through a 2-pole low-pass whose cutoff glides from cutoff[0] to cutoff[1] (crossfade)."""
    m = int((hold + rel + 0.05) * FS)
    r = 2 ** (detune_cents / 1200)
    centre = saw_blep(freq, m)
    lo_v = saw_blep(freq / r, m)
    hi_v = saw_blep(freq * r, m)
    L = 0.6 * centre + lo_v + 0.25 * hi_v
    R = 0.6 * centre + hi_v + 0.25 * lo_v
    x = np.stack([L, R]) * 0.5
    if cutoff[0] == cutoff[1]:
        y = lowpass(x, cutoff[0], 2)
    else:
        a = lowpass(x, cutoff[0], 2)
        b = lowpass(x, cutoff[1], 2)
        w = np.clip(np.arange(m) / FS / max(hold, 1e-3), 0, 1) ** 1.5
        y = a * (1 - w) + b * w
    env = adsr(m, att, 0.8, 0.85, rel, hold)
    p = (RNG.random() * 2 - 1) * 0.25
    y = y * env * np.array([[np.cos((p + 1) * np.pi / 4) * np.sqrt(2)], [np.sin((p + 1) * np.pi / 4) * np.sqrt(2)]])
    return fades(y, 0.003, 0.01)


def bass_note(freq: float, hold: float) -> np.ndarray:
    m = int((hold + 0.03) * FS)
    x = 0.55 * saw_blep(freq, m) + 0.8 * sine(freq, m, RNG.random())
    x = lowpass(x, 260, 2)
    x = np.tanh(1.4 * x)
    env = adsr(m, 0.004, 0.25, 0.75, 0.025, hold)
    return fades(x * env, 0.002, 0.008)


def pluck(freq: float, dur: float = 1.4, bright: float = 0.6, damp: float = 0.996) -> np.ndarray:
    """Karplus-Strong with linear-interpolated fractional delay, so it stays in tune."""
    m = int(dur * FS)
    P = FS / freq - 0.5  # the two-point average adds half a sample
    N = int(np.floor(P))
    p = P - N
    y = np.zeros(m + N + 2)
    off = N + 2
    burst = RNG.standard_normal(N + 2)
    burst = lowpass(burst, 1500 + 6000 * bright, 1)
    burst -= burst.mean()
    y[: N + 2] = burst / (np.max(np.abs(burst)) + 1e-12)
    c0, c1, c2 = 0.5 * (1 - p) * damp, 0.5 * damp, 0.5 * p * damp
    pos = off
    end = len(y)
    while pos < end:
        stop = min(pos + N, end)  # chunk no longer than the delay keeps the recursion causal
        idx = np.arange(pos, stop)
        y[idx] = c0 * y[idx - N] + c1 * y[idx - N - 1] + c2 * y[idx - N - 2]
        pos = stop
    out = y[off:]
    out = highpass(out, 80)
    t = np.arange(m) / FS
    out *= np.exp(-t / (0.9 * dur))
    return fades(out, 0.001, 0.05)


def bell(freq: float, dur: float = 2.2, index: float = 2.2) -> np.ndarray:
    """Two-operator FM bell (mod ratio 3.5, decaying index) plus a soft octave-down sine body."""
    m = int(dur * FS)
    t = np.arange(m) / FS
    I = index * np.exp(-t / 0.18) + 0.25
    mod = np.sin(2 * np.pi * 3.5 * freq * t)
    car = np.sin(2 * np.pi * freq * t + I * mod)
    body = 0.35 * np.sin(2 * np.pi * freq * t + 0.6 * np.exp(-t / 0.08) * np.sin(2 * np.pi * 2 * freq * t))
    env = (1 - np.exp(-t / 0.0015)) * np.exp(-t / 0.75)
    return fades((car + body) * env, 0.001, 0.08)


# ---------------------------------------------------------------- harmony
CHORDS = {
    "Am9": ["A3", "C4", "E4", "G4", "B4"],
    "Fmaj7": ["F3", "A3", "C4", "E4", "G4"],  # G4 = the 9th kept as a common tone, voiced lightly
    "Cmaj7": ["G3", "C4", "E4", "B4"],
    "G6": ["G3", "B3", "D4", "E4"],
    "C": ["G3", "C4", "E4", "G4"],
    "G": ["G3", "B3", "D4", "G4"],
    "Am": ["A3", "C4", "E4", "A4"],
    "F": ["F3", "A3", "C4", "F4"],
    "Am(add9)": ["A3", "C4", "E4", "B4"],
}
ROOT = {"Am9": "A1", "Fmaj7": "F1", "Cmaj7": "C2", "G6": "G1", "C": "C2", "G": "G1", "Am": "A1", "F": "F1",
        "Am(add9)": "A1"}
ARP = {  # pluck / bell arpeggio tones, one octave up
    "Am9": ["A4", "C5", "E5", "G5", "B5"],
    "Fmaj7": ["F4", "A4", "C5", "E5", "G5"],
    "Cmaj7": ["E4", "G4", "B4", "C5", "E5"],
    "G6": ["D4", "G4", "B4", "D5", "E5"],
    "C": ["C5", "E5", "G5", "E5"],
    "G": ["B4", "D5", "G5", "D5"],
    "Am": ["C5", "E5", "A5", "E5"],
    "F": ["C5", "F5", "A5", "F5"],
}

# (start, duration, chord)
PROG: list[tuple[float, float, str]] = []
_cycle = ["Am9", "Fmaj7", "Cmaj7", "G6"]
for bar in range(2, 9):  # bars 2-8
    PROG.append(((bar - 1) * BAR, BAR, _cycle[(bar - 2) % 4]))
for i, bar in enumerate(range(9, 12)):  # bars 9-11: same cycle restarted on the verdict
    PROG.append(((bar - 1) * BAR, BAR, _cycle[i]))
PROG.append((22.0, 6.0, "Am9"))  # bars 12-14 held
for rep in range(2):  # bars 15-16, 17-18
    for j, ch in enumerate(["C", "G", "Am", "F"]):
        PROG.append((28.0 + rep * 4.0 + j * 1.0, 1.0, ch))
PROG.append((36.0, 2.0, "Am(add9)"))


def chord_at(t: float) -> str:
    for s, d, c in PROG:
        if s <= t < s + d:
            return c
    return "Am(add9)"


# ---------------------------------------------------------------- arrangement
STEMS = ["kick", "hat", "bass", "pad", "pluck", "bell", "fx"]


class Part:
    """Renders only events whose onset lies in [lo, hi). The film is rendered as two parts
    (before the 15.75 s gap and from 16.0 s), so delay and reverb tails of the first part can
    be cut for the gap without touching anything that starts on the verdict downbeat."""

    def __init__(self, lo: float, hi: float):
        self.lo, self.hi = lo, hi
        self.st = {k: np.zeros((2, N_BUF)) for k in STEMS}
        self.kicks: list[tuple[float, float]] = []  # (time, duck depth scale)

    def ok(self, t: float) -> bool:
        return self.lo <= t < self.hi

    def add(self, stem: str, t: float, sig: np.ndarray, gain: float = 1.0, p: float = 0.0) -> None:
        if not self.ok(t):
            return
        if sig.ndim == 1:
            sig = pan(sig, p)
        i = tsamp(t)
        j = min(i + sig.shape[1], N_BUF)
        self.st[stem][:, i:j] += gain * sig[:, : j - i]


def compose(part: Part) -> None:
    A = part.add

    # bar 1: sub pulses on beats 1-3, teaser impact on beat 4
    for b in range(3):
        A("kick", b * BEAT, sub_pulse(), 0.75)
    A("fx", HITS["teaserImpact"], impact(), 1.0)
    part.kicks.append((HITS["teaserImpact"], 1.0)) if part.ok(HITS["teaserImpact"]) else None

    # kicks: four on the floor bars 2-11 (none after 15.0 in bar 8: the riser owns that beat),
    # heartbeat in 12-14, back for 15-18, out at 36.0
    for i in range(int((22.0 - 2.0) / BEAT)):
        t = 2.0 + i * BEAT
        if 15.0 <= t < 16.0:
            continue
        if t == 16.0:
            continue  # the verdict impact carries its own kick
        A("kick", t, kick(), 0.95)
        if part.ok(t):
            part.kicks.append((t, 1.0))
    for bar_t in (22.0, 24.0, 26.0):
        for off in (0.0, 1.0):
            A("kick", bar_t + off, heartbeat(), 0.9)
            if part.ok(bar_t + off):
                part.kicks.append((bar_t + off, 0.45))
    for i in range(int((36.0 - 28.0) / BEAT)):
        t = 28.0 + i * BEAT
        A("kick", t, kick(), 0.95)
        if part.ok(t):
            part.kicks.append((t, 1.0))
    A("fx", HITS["verdictImpact"], impact(), 1.1)
    if part.ok(HITS["verdictImpact"]):
        part.kicks.append((HITS["verdictImpact"], 1.0))

    # hats
    def hats(t0: float, t1: float, step: float, base: float) -> None:
        k = 0
        t = t0
        while t < t1 - 1e-9:
            pos16 = int(round((t % BEAT) / S16))
            if step == 2 * S16:  # 8ths: offbeats louder, a lilt
                v = 1.0 if pos16 == 2 else 0.55
            else:
                v = {0: 0.75, 1: 0.45, 2: 1.0, 3: 0.55}[pos16]
            v *= 1.0 + 0.08 * (RNG.random() - 0.5)
            A("hat", t, hat(v), base, p=0.25 if k % 2 else -0.15)
            t += step
            k += 1

    hats(2.0, 6.0, 2 * S16, 0.32)
    hats(6.0, 15.0, S16, 0.30)
    hats(16.0, 22.0, S16, 0.32)
    hats(28.0, 32.0, 2 * S16, 0.32)
    hats(32.0, 36.0, S16, 0.34)

    # pad
    for s, d, ch in PROG:
        if s >= 36.0:
            continue
        if s == 22.0:  # breakdown: darker, opening across six seconds
            for f in CHORDS[ch]:
                A("pad", s, pad_note(n(f), d, rel=0.5, att=0.6, cutoff=(700, 2600)), 0.16)
            continue
        att = 0.8 if s == 2.0 else 0.18
        cut = 1500 if s < 16.0 else 2200
        if s >= 28.0:
            cut = 2600
        for f in CHORDS[ch]:
            g = 0.6 if (ch == "Fmaj7" and f == "G4") else 1.0
            A("pad", s, pad_note(n(f), d, rel=0.45, att=att, cutoff=(cut, cut)), 0.15 * g)
    # end: Am(add9) pedal 36-38, re-struck at 38.0
    for f in CHORDS["Am(add9)"]:
        A("pad", 36.0, pad_note(n(f), 2.0, rel=0.4, att=0.35, cutoff=(1800, 1800)), 0.21)
        A("pad", 38.0, pad_note(n(f), 1.6, rel=0.3, att=0.02, cutoff=(2400, 1600)), 0.23)
    A("pad", 38.0, pad_note(n("A2"), 1.6, rel=0.3, att=0.02, cutoff=(900, 900)), 0.14)

    # bass: 8th-note root pulse, bars 9-11 and 15-18 (the kick ducks it, so it breathes)
    for s, d, ch in PROG:
        if not ((16.0 <= s < 22.0) or (28.0 <= s < 36.0)):
            continue
        f = n(ROOT[ch])
        k = 0
        t = s
        while t < s + d - 1e-9:
            v = 1.0 if k % 2 == 0 else 0.8
            A("bass", t, bass_note(f, 2 * S16 * 0.82), 0.42 * v)
            t += 2 * S16
            k += 1
    # final low A under the last chord
    A("bass", 38.0, bass_note(n("A1"), 1.4), 0.32)

    # pluck arpeggio: bars 6-11 (minus the riser beat) and bars 17-18
    pattern = [0, 2, 4, 1, 3, 2, 4, 1, 0, 2, 4, 3, 2, 1, 4, 2]

    def arp(t0: float, t1: float, gain: float) -> None:
        t = t0
        while t < t1 - 1e-9:
            ch = chord_at(t)
            tones = ARP[ch]
            step = int(round((t - t0) / S16)) % 16
            f = n(tones[pattern[step] % len(tones)])
            accent = 1.0 if step % 4 == 0 else (0.75 if step % 2 == 0 else 0.55)
            A("pluck", t, pluck(f, 1.2, bright=0.35 + 0.4 * accent), gain * accent,
              p=0.35 * np.sin(step * 0.9))
            t += S16

    arp(10.0, 15.0, 0.30)
    arp(16.0, 22.0, 0.30)
    arp(32.0, 36.0, 0.26)

    # FM bell arpeggio, bars 15-18 (8th notes over C G Am F)
    t = 28.0
    while t < 36.0 - 1e-9:
        ch = chord_at(t)
        step = int(round((t - 28.0) / (2 * S16)))
        f = n(ARP[ch][step % 4])
        A("bell", t, bell(f, 1.6, 2.0), 0.13 * (1.0 if step % 2 == 0 else 0.7), p=0.4 if step % 2 else -0.4)
        t += 2 * S16

    # end card: 4-note motif over the pedal, resolving into the final chord
    for t, name in [(36.0, "E5"), (36.5, "C5"), (37.0, "D5"), (37.5, "B4")]:
        A("bell", t, bell(n(name), 2.0, 1.6), 0.24, p=-0.15 if name in ("C5", "B4") else 0.15)
    for name, p in [("A4", -0.3), ("E5", 0.3), ("B5", 0.0)]:
        A("bell", 38.0, bell(n(name), 1.5, 1.4), 0.14, p=p)
    A("pluck", 38.0, pluck(n("A3"), 1.5, 0.5), 0.25, p=-0.2)
    A("pluck", 38.03, pluck(n("E4"), 1.5, 0.5), 0.2, p=0.2)

    # risers
    A("fx", HITS["riser"], riser(0.75, 400, 8000), 0.8)
    A("fx", 27.0, riser(1.0, 300, 5000), 0.16)  # soft swell into the major lift


# ---------------------------------------------------------------- effects
def duck_env(kicks: list[tuple[float, float]], depth: float, release: float = 0.11) -> np.ndarray:
    g = np.zeros(N_BUF)
    m = int(0.5 * FS)
    t = np.arange(m) / FS
    shape = np.clip(t / 0.004, 0, 1) * np.exp(-np.clip(t - 0.004, 0, None) / release)
    for tk, s in kicks:
        i = tsamp(tk)
        j = min(i + m, N_BUF)
        g[i:j] = np.maximum(g[i:j], s * shape[: j - i])
    return 1.0 - depth * g


def pingpong(x: np.ndarray, delay: float = 0.375, fb: float = 0.42, taps: int = 6) -> np.ndarray:
    """Dotted-eighth ping-pong: echoes alternate L/R and darken as they repeat."""
    send = highpass(lowpass(x.mean(axis=0), 3200, 1), 250)
    out = np.zeros_like(x)
    d = tsamp(delay)
    src = send
    for k in range(1, taps + 1):
        src = lowpass(src, 4500, 1) if k > 1 else src
        ch = 0 if k % 2 else 1
        o = k * d
        if o >= N_BUF:
            break
        out[ch, o:] += (fb ** k) * src[: N_BUF - o]
    return out


def fdn_reverb(x: np.ndarray, t60: float = 2.3, predelay: float = 0.02, damp: float = 0.35) -> np.ndarray:
    """8-line feedback delay network, Householder feedback matrix, per-line gain for T60,
    a two-tap low-pass in each feedback path for high-frequency damping. Processed in blocks
    shorter than the shortest delay, so every read is of already-written samples."""
    delays = np.array([1123, 1361, 1597, 1847, 2083, 2297, 2539, 2789])
    Nl = len(delays)
    B = 512
    g = 10 ** (-3 * delays / (t60 * FS))
    H = np.eye(Nl) - (2.0 / Nl) * np.ones((Nl, Nl))
    mono = highpass(x.mean(axis=0), 180)
    pd = tsamp(predelay)
    inp = np.zeros(N_BUF)
    inp[pd:] = mono[: N_BUF - pd]
    sign_in = np.array([1, -1, 1, -1, 1, -1, 1, -1], dtype=float)
    cL = np.array([1, 1, -1, -1, 1, 1, -1, -1], dtype=float) / np.sqrt(Nl)
    cR = np.array([1, -1, 1, -1, -1, 1, -1, 1], dtype=float) / np.sqrt(Nl)
    lines = np.zeros((Nl, N_BUF))
    out = np.zeros((2, N_BUF))
    rows = np.arange(Nl)[:, None]
    for s in range(0, N_BUF, B):
        e = min(s + B, N_BUF)
        idx = np.arange(s, e)[None, :]
        r0 = idx - delays[:, None]
        r1 = r0 - 1
        o0 = np.where(r0 >= 0, lines[rows, np.clip(r0, 0, None)], 0.0)
        o1 = np.where(r1 >= 0, lines[rows, np.clip(r1, 0, None)], 0.0)
        damped = ((1 - damp) * o0 + damp * o1) * g[:, None]
        lines[:, s:e] = H @ damped + sign_in[:, None] * inp[None, s:e]
        out[0, s:e] = cL @ o0
        out[1, s:e] = cR @ o0
    return out


def process(part: Part) -> np.ndarray:
    st = part.st
    duck_pad = duck_env(part.kicks, 0.45)
    duck_bass = duck_env(part.kicks, 0.75, 0.09)
    duck_mel = duck_env(part.kicks, 0.25)
    pad = st["pad"] * duck_pad
    bass = st["bass"] * duck_bass
    pluck_b = st["pluck"] * duck_mel
    bell_b = st["bell"] * duck_mel
    delay = pingpong(pluck_b + 0.7 * bell_b)
    dry = st["kick"] + st["hat"] + bass + pad + pluck_b + bell_b + st["fx"] + 0.32 * delay
    send = (0.30 * pad + 0.35 * pluck_b + 0.45 * bell_b + 0.10 * st["hat"] + 0.04 * st["kick"]
            + 0.18 * st["fx"] + 0.25 * delay)
    wet = fdn_reverb(send)
    return dry + 0.55 * wet


def gain_curve(points: list[tuple[float, float]]) -> np.ndarray:
    t = np.arange(N_BUF) / FS
    xs, ys = zip(*points)
    return np.interp(t, xs, ys)


def soft_clip(x: np.ndarray, knee: float = 0.75) -> np.ndarray:
    """Linear below the knee, tanh above it; continuous slope at the knee."""
    a = np.abs(x)
    over = a > knee
    y = x.copy()
    y[over] = np.sign(x[over]) * (knee + (1 - knee) * np.tanh((a[over] - knee) / (1 - knee)))
    return y


def master(mix: np.ndarray) -> np.ndarray:
    mix = highpass(mix, 22)  # DC / sub-rumble guard
    # final fade: chord struck at 38.0, cosine fade to zero by 39.5, digital silence after
    t = np.arange(N_BUF) / FS
    fade = np.where(t < FADE_START, 1.0,
                    np.where(t < SILENCE, np.cos(0.5 * np.pi * np.clip((t - FADE_START) / (SILENCE - FADE_START), 0, 1)) ** 1.3, 0.0))
    mix = mix * fade
    peak = np.max(np.abs(mix))
    mix = mix / peak * 1.6  # drive the hottest transients ~4 dB into the soft clipper
    mix = soft_clip(mix)
    mix = mix[:, :N_OUT]
    target = 10 ** (-1.6 / 20)  # sample peak -1.6 dBFS leaves room for inter-sample overs
    mix *= target / np.max(np.abs(mix))
    mix[:, tsamp(SILENCE):] = 0.0
    return mix


def write(path: Path, x: np.ndarray, peak_db: float | None = None) -> None:
    if peak_db is not None:
        x = x * (10 ** (peak_db / 20) / np.max(np.abs(x)))
    sf.write(str(path), x.T, FS, subtype="PCM_24")


def main() -> None:
    a = Part(0.0, RISER_END)
    b = Part(GAP_END, 1e9)
    compose(a)
    compose(b)
    mix_a = process(a)
    mix_b = process(b)
    # everything begun before the gap (including its delay and reverb tails) is cut at 15.75
    gate_a = gain_curve([(0, 1), (RISER_END - 0.004, 1), (RISER_END, 0), (LENGTH + 10, 0)])
    mix = mix_a * gate_a + mix_b
    out = master(mix)
    write(HERE / "bgm.wav", out)

    write(HERE / "sfx_tick.wav", tick(), -3.0)
    write(HERE / "sfx_impact.wav", impact(), -1.0)
    write(HERE / "sfx_riser.wav", riser(0.75, 400, 8000), -3.0)

    beats = {
        "bpm": BPM,
        "beats": [round(i * BEAT, 3) for i in range(int(LENGTH / BEAT))],
        "bars": [round(i * BAR, 3) for i in range(int(LENGTH / BAR))],
        "scenes": SCENES,
        "hits": HITS,
    }
    (FILM / "beats.json").write_text(json.dumps(beats, indent=2) + "\n")
    print(f"bgm.wav {out.shape[1] / FS:.3f} s, peak {20 * np.log10(np.max(np.abs(out))):.2f} dBFS")


if __name__ == "__main__":
    main()
