"""Giọng đọc miễn phí VieNeu (chạy trên máy): python vieneu_tts.py --in file.txt --out file.mp3 [--voice "Ngọc Linh"]
Đọc từng câu (VieNeu bỏ qua "..." nên tách câu để có khoảng nghỉ thật), nối bằng khoảng lặng ngắn, ghi wav/mp3 qua ffmpeg.
--serve: nạp model một lần rồi nhận việc theo dòng JSON trên stdin {"text","out","voice"} → trả 1 dòng JSON {"ok",...} trên stdout."""
import argparse, json, os, re, shutil, subprocess, sys, tempfile
import numpy as np, soundfile as sf

ap = argparse.ArgumentParser()
ap.add_argument("--in", dest="inp")
ap.add_argument("--out")
ap.add_argument("--voice", default="")
ap.add_argument("--serve", action="store_true")
a = ap.parse_args()

# Chế độ phục vụ: stdout chỉ dành cho giao thức — mọi thứ thư viện in ra dồn sang stderr.
proto = None
if a.serve:
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

from vieneu import Vieneu

voices = {}


def speak(tts, text, out, name):
    """Đọc `text` bằng giọng `name`, ghi ra `out`; trả số giây âm thanh."""
    text = text.replace("\r\n", "\n").strip()
    # Câu kết thúc bằng . ! ? … hoặc "..." → nghỉ dài; xuống dòng trống (hết đoạn) → nghỉ dài hơn.
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    sr = tts.sample_rate
    if name not in voices:
        voices[name] = tts.get_preset_voice(name)
    voice = voices[name]
    gap = lambda s: np.zeros(int(sr * s), np.float32)
    chunks = []
    for para in paras:
        for sent in [s.strip() for s in re.split(r"(?<=[.!?…])\s+|\n+", para) if s.strip()]:
            sent = re.sub(r"\.{3,}|…", ",", sent).strip(" ,")
            if not re.search(r"\w", sent):
                continue
            wav = np.asarray(tts.infer(sent, voice=voice, temperature=0.7), np.float32)
            chunks += [wav, gap(0.35)]
        chunks.append(gap(0.4))
    if not chunks:
        raise ValueError("Văn bản trống.")
    tmp = tempfile.mkdtemp(prefix="vieneu-")
    try:
        raw = os.path.join(tmp, "raw.wav")
        sf.write(raw, np.concatenate(chunks), sr)
        ff = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
        codec = ["-c:a", "libmp3lame", "-b:a", "192k"] if out.lower().endswith(".mp3") else []
        subprocess.run([ff, "-y", "-loglevel", "error", "-i", raw, "-ar", "48000", "-ac", "1", *codec, out], check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return sum(len(c) for c in chunks) / sr


def send(o):
    proto.write(json.dumps(o, ensure_ascii=False) + "\n")
    proto.flush()


tts = Vieneu()
if a.serve:
    send({"ready": True})
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            j = json.loads(line)
            send({"ok": True, "secs": round(speak(tts, j["text"], j["out"], j.get("voice") or "Thiện Minh"), 1)})
        except Exception as e:
            send({"ok": False, "error": str(e)[-300:]})
else:
    if not a.inp or not a.out:
        sys.exit("Cần --in và --out (hoặc --serve).")
    name = a.voice or "Thiện Minh"
    try:
        secs = speak(tts, open(a.inp, encoding="utf-8").read(), a.out, name)
    except ValueError as e:
        sys.exit(str(e))
    print(f"VieNeu ({name}): {secs:.1f}s", flush=True)
