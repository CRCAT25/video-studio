"""Giọng đọc miễn phí VieNeu (chạy trên máy): python vieneu_tts.py --in file.txt --out file.mp3 [--voice "Ngọc Linh"]
Đọc từng câu (VieNeu bỏ qua "..." nên tách câu để có khoảng nghỉ thật), nối bằng khoảng lặng ngắn, ghi wav/mp3 qua ffmpeg."""
import argparse, os, re, shutil, subprocess, sys, tempfile
import numpy as np, soundfile as sf
from vieneu import Vieneu

ap = argparse.ArgumentParser()
ap.add_argument("--in", dest="inp", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--voice", default="")
a = ap.parse_args()

text = open(a.inp, encoding="utf-8").read().replace("\r\n", "\n").strip()
# Câu kết thúc bằng . ! ? … hoặc "..." → nghỉ dài; xuống dòng trống (hết đoạn) → nghỉ dài hơn.
paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
tts = Vieneu()
sr = tts.sample_rate
name = a.voice or "Thiện Minh"
voice = tts.get_preset_voice(name)
gap = lambda s: np.zeros(int(sr * s), np.float32)
chunks = []
for pi, para in enumerate(paras):
    for sent in [s.strip() for s in re.split(r"(?<=[.!?…])\s+|\n+", para) if s.strip()]:
        sent = re.sub(r"\.{3,}|…", ",", sent).strip(" ,")
        if not re.search(r"\w", sent):
            continue
        wav = np.asarray(tts.infer(sent, voice=voice, temperature=0.7), np.float32)
        chunks += [wav, gap(0.35)]
    chunks.append(gap(0.4))
if not chunks:
    sys.exit("Văn bản trống.")
tmp = tempfile.mkdtemp(prefix="vieneu-")
raw = os.path.join(tmp, "raw.wav")
sf.write(raw, np.concatenate(chunks), sr)
ff = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
codec = ["-c:a", "libmp3lame", "-b:a", "192k"] if a.out.lower().endswith(".mp3") else []
subprocess.run([ff, "-y", "-loglevel", "error", "-i", raw, "-ar", "48000", "-ac", "1", *codec, a.out], check=True)
shutil.rmtree(tmp, ignore_errors=True)
print(f"VieNeu ({name}): {sum(len(c) for c in chunks) / sr:.1f}s", flush=True)
