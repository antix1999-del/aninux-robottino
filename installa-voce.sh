#!/usr/bin/env bash
# Installa la voce di Aninux: Piper (parla) e Whisper (ascolta), tutto offline.
# Circa 1 GB tra programmi e modelli, in ~/.local/share/aninux-robottino/voce
set -euo pipefail

DIR="${XDG_DATA_HOME:-$HOME/.local/share}/aninux-robottino/voce"
HF="https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT"
mkdir -p "$DIR/voci"
cd "$DIR"

echo "→ Ambiente Python…"
[ -x venv/bin/python ] || python3 -m venv venv
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q faster-whisper piper-tts

echo "→ Voce italiana (Paola)…"
for ext in onnx onnx.json; do
    f="voci/it_IT-paola-medium.$ext"
    [ -s "$f" ] || curl -fL --progress-bar -o "$f" "$HF/paola/medium/it_IT-paola-medium.$ext"
done

echo "→ Modello di ascolto (Whisper small, ~460 MB)…"
HF_HOME="$DIR/hf" venv/bin/python -I -c "
from faster_whisper import WhisperModel
WhisperModel('small', device='cpu', compute_type='int8')
"

echo "✓ Fatto! Clicca sul 🎤 nel riquadro di Aninux, oppure premi Ctrl+Super+Spazio."
