#!/usr/bin/env bash
# Installa la voce di Aninux: Piper (parla) e Whisper (ascolta), tutto offline.
# Circa 1 GB tra programmi e modelli, in ~/.local/share/aninux-robottino/voce
set -euo pipefail

DIR="${XDG_DATA_HOME:-$HOME/.local/share}/aninux-robottino/voce"
HF="https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT"

errore() { echo "✗ $*" >&2; exit 1; }

# --- controlli prima di iniziare ---
command -v python3 >/dev/null || errore "Manca Python 3. Installalo, per esempio: sudo apt install python3"
command -v curl >/dev/null || errore "Manca curl. Installalo, per esempio: sudo apt install curl"
command -v pw-record >/dev/null || echo "⚠ Non trovo pw-record (PipeWire): senza, il robottino non potrà ascoltarti."
if ! python3 -c 'import venv, ensurepip' 2>/dev/null; then
    PYVER="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
    errore "Python non può creare ambienti virtuali (manca il modulo venv/ensurepip).
  Su Ubuntu/Debian installa: sudo apt install python3-venv   (oppure python${PYVER}-venv)
  Poi rilancia ./installa-voce.sh"
fi

mkdir -p "$DIR/voci"
cd "$DIR"

echo "→ Ambiente Python…"
# un tentativo precedente fallito può lasciare un venv a metà (python sì, pip no): lo rifaccio
if ! { [ -x venv/bin/python ] && venv/bin/python -m pip --version >/dev/null 2>&1; }; then
    [ -e venv ] && echo "  (ambiente incompleto da un tentativo precedente: lo ricreo)"
    python3 -m venv --clear venv
fi
venv/bin/python -m pip install -q --upgrade pip
venv/bin/python -m pip install -q faster-whisper piper-tts

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
