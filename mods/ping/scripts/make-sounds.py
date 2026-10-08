#!/usr/bin/env python3
"""Regenerates ping's chimes in ../sounds (44.1 kHz mono 16-bit WAV, stdlib only).

    python3 scripts/make-sounds.py
"""
import math
import os
import struct
import wave

RATE = 44100
PEAK = 10 ** (-7 / 20)  # -7 dBFS, under the -6 dBFS ceiling
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sounds')


def note(freq, dur, start, total, decay=6.0):
    """A bell-ish tone (fundamental + soft octave partial) with its own exponential decay."""
    out = [0.0] * total
    first = int(start * RATE)
    for i in range(int(dur * RATE)):
        t = i / RATE
        env = math.exp(-decay * t)
        attack = min(1.0, t / 0.008)  # 8 ms attack, no click
        s = math.sin(2 * math.pi * freq * t) + 0.25 * math.sin(2 * math.pi * 2 * freq * t)
        if first + i < total:
            out[first + i] += attack * env * s
    return out


def render(name, notes, length):
    total = int(length * RATE)
    mix = [0.0] * total
    for freq, dur, start in notes:
        for i, v in enumerate(note(freq, dur, start, total)):
            mix[i] += v
    fade = int(0.04 * RATE)  # 40 ms fade out at the tail
    for i in range(fade):
        mix[total - 1 - i] *= i / fade
    top = max(abs(v) for v in mix) or 1.0
    frames = b''.join(struct.pack('<h', int(v / top * PEAK * 32767)) for v in mix)
    path = os.path.join(OUT, name)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(frames)
    print(f'{name}: {os.path.getsize(path)} bytes, {length:.2f}s')


os.makedirs(OUT, exist_ok=True)
E6, A6 = 1318.51, 1760.0
A4, E4 = 440.0, 329.63
C6 = 1046.5
render('done.wav', [(E6, 0.45, 0.0), (A6, 0.42, 0.13)], 0.55)
render('error.wav', [(A4, 0.4, 0.0), (E4, 0.4, 0.17)], 0.6)
render('attention.wav', [(C6, 0.38, 0.0)], 0.4)
