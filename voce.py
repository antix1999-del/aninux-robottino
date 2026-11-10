#!/usr/bin/env python3
"""Voce di Aninux: parla (Piper) e ascolta (Whisper), tutto offline.

Resta acceso finché l'estensione è attiva. Comandi su stdin, una riga JSON per volta:
  {"cmd": "parla", "testo": "..."}   legge il testo ad alta voce
  {"cmd": "zitto"}                   smette di parlare
  {"cmd": "ascolta"}                 registra dal microfono finché non smetti di parlare
  {"cmd": "basta"}                   finisce subito di ascoltare e trascrive
  {"cmd": "annulla"}                 smette di ascoltare senza trascrivere
Eventi su stdout, una riga JSON per volta: {"ev": "...", ...}
"""
import json
import os
import re
import subprocess
import sys
import threading
import time

DATA = os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'),
                    'aninux-robottino', 'voce')
os.environ.setdefault('HF_HOME', os.path.join(DATA, 'hf'))
os.environ.setdefault('HF_HUB_OFFLINE', '1')

import numpy as np  # noqa: E402

VOICE = os.environ.get('ANINUX_VOCE', 'it_IT-paola-medium')
WHISPER = os.environ.get('ANINUX_WHISPER', 'small')
RATE = 16000
CHUNK = 1600                     # 100 ms
START_TIMEOUT = 8.0              # se non parli entro 8 s, lascia perdere
END_SILENCE = 1.3                # dopo 1,3 s di silenzio hai finito
MAX_SECONDS = 40.0
UNLOAD_AFTER = 10 * 60           # libera Whisper dalla memoria dopo 10 minuti

# frasi che Whisper "inventa" quando sente solo rumore
HALLUCINATIONS = re.compile(
    r'sottotitol|amara\.org|grazie (a tutti )?per (la visione|l\'ascolto|aver guardato)|iscriviti al canale',
    re.I)

_out_lock = threading.Lock()


def emit(ev, **kw):
    with _out_lock:
        sys.stdout.write(json.dumps({'ev': ev, **kw}, ensure_ascii=False) + '\n')
        sys.stdout.flush()


# ---------------- parlare ----------------
class Speaker:
    def __init__(self):
        self.voice = None
        self.lock = threading.Lock()
        self.gen = 0
        self.player = None

    def load(self):
        if self.voice is None:
            from piper import PiperVoice
            self.voice = PiperVoice.load(os.path.join(DATA, 'voci', f'{VOICE}.onnx'))
        return self.voice

    def stop(self):
        self.gen += 1
        p = self.player
        if p and p.poll() is None:
            p.kill()

    def say(self, text):
        self.stop()
        gen = self.gen
        threading.Thread(target=self._run, args=(text, gen), daemon=True).start()

    def _run(self, text, gen):
        with self.lock:
            if gen != self.gen:
                return
            try:
                voice = self.load()
                rate = voice.config.sample_rate
                self.player = subprocess.Popen(
                    ['pw-play', '--rate', str(rate), '--channels', '1', '--format', 's16', '--raw',
                     '--media-role', 'Communication', '-'],
                    stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
                emit('parla_inizio')
                # una frase alla volta: la prima parte subito, le altre mentre suona
                for chunk in voice.synthesize(text):
                    if gen != self.gen:
                        break
                    self.player.stdin.write(chunk.audio_int16_bytes)
                    self.player.stdin.flush()
                self.player.stdin.close()
                self.player.wait()
            except (BrokenPipeError, ValueError):
                pass
            except Exception as e:  # noqa: BLE001
                emit('errore', msg=f'voce: {e}')
            finally:
                p = self.player
                self.player = None
                if p:
                    try:
                        p.stdin.close()
                    except (BrokenPipeError, OSError, ValueError):
                        pass
                    if p.poll() is None:
                        p.kill()
                emit('parla_fine')


# ---------------- ascoltare ----------------
class Listener:
    def __init__(self):
        self.model = None
        self.model_lock = threading.Lock()
        self.last_used = time.time()
        self.rec = None
        self.mode = None          # None | 'ascolta' | 'basta' | 'annulla'
        threading.Thread(target=self._janitor, daemon=True).start()

    def _load_model(self):
        with self.model_lock:
            if self.model is None:
                from faster_whisper import WhisperModel
                self.model = WhisperModel(WHISPER, device='cpu', compute_type='int8',
                                          cpu_threads=max(1, (os.cpu_count() or 4) // 2))
            self.last_used = time.time()
            return self.model

    def _janitor(self):
        while True:
            time.sleep(60)
            with self.model_lock:
                if self.model is not None and self.mode is None and time.time() - self.last_used > UNLOAD_AFTER:
                    self.model = None

    def start(self):
        if self.mode == 'ascolta':
            return
        self.mode = 'ascolta'
        threading.Thread(target=self._run, daemon=True).start()
        # carica Whisper mentre parli, così è pronto quando hai finito
        threading.Thread(target=self._load_model, daemon=True).start()

    def finish(self, how):
        if self.mode == 'ascolta':
            self.mode = how
            r = self.rec
            if r and r.poll() is None:
                r.terminate()

    def _run(self):
        try:
            self.rec = subprocess.Popen(
                ['pw-record', '--rate', str(RATE), '--channels', '1', '--format', 's16', '--raw',
                 '--media-role', 'Communication', '-'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except Exception as e:  # noqa: BLE001
            self.mode = None
            emit('errore', msg=f'microfono: {e}')
            return
        emit('ascolto')
        chunks = []
        noise = []
        started = False
        speech_end = None
        t0 = time.time()
        last_level = 0.0
        try:
            while self.mode == 'ascolta':
                data = self.rec.stdout.read(CHUNK * 2)
                if not data:
                    break
                a = np.frombuffer(data, np.int16).astype(np.float32) / 32768.0
                chunks.append(a)
                rms = float(np.sqrt(np.mean(a * a))) if len(a) else 0.0
                elapsed = time.time() - t0
                # i primi 300 ms servono a misurare il rumore di fondo
                if len(noise) < 3:
                    noise.append(rms)
                    continue
                floor = max(float(np.median(noise)), 0.002)
                thresh = max(floor * 3.0, 0.012)
                loud = rms > thresh
                if not loud and not started:
                    noise = (noise + [rms])[-30:]
                if time.time() - last_level > 0.12:
                    last_level = time.time()
                    emit('livello', v=round(min(1.0, rms / (thresh * 3)), 2))
                if loud:
                    started = True
                    speech_end = None
                elif started:
                    speech_end = speech_end or time.time()
                    if time.time() - speech_end > END_SILENCE:
                        break
                if not started and elapsed > START_TIMEOUT:
                    break
                if elapsed > MAX_SECONDS:
                    break
        finally:
            r = self.rec
            self.rec = None
            if r and r.poll() is None:
                r.terminate()
            try:
                r and r.wait(2)
            except Exception:  # noqa: BLE001
                r.kill()

        how = self.mode
        self.mode = None
        if how == 'annulla':
            emit('annullato')
            return
        if not started and how != 'basta':
            emit('testo', testo='')
            return
        audio = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
        if len(audio) < RATE * 0.3:
            emit('testo', testo='')
            return
        emit('trascrivo')
        try:
            model = self._load_model()
            segs, _info = model.transcribe(audio, language='it', beam_size=1, vad_filter=True,
                                           condition_on_previous_text=False)
            text = ' '.join(s.text.strip() for s in segs).strip()
            self.last_used = time.time()
        except Exception as e:  # noqa: BLE001
            emit('errore', msg=f'trascrizione: {e}')
            return
        if HALLUCINATIONS.search(text) and len(text) < 80:
            text = ''
        emit('testo', testo=text)


def main():
    speaker = Speaker()
    listener = Listener()
    # carica la voce subito, così la prima risposta non aspetta
    threading.Thread(target=lambda: _safe(speaker.load), daemon=True).start()
    emit('pronto')
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        cmd = msg.get('cmd')
        if cmd == 'parla':
            speaker.say(str(msg.get('testo', '')))
        elif cmd == 'zitto':
            speaker.stop()
        elif cmd == 'ascolta':
            speaker.stop()
            listener.start()
        elif cmd in ('basta', 'annulla'):
            listener.finish(cmd)
    # stdin chiuso: l'estensione è stata disattivata
    speaker.stop()
    listener.finish('annulla')


def _safe(fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        emit('errore', msg=f'voce: {e}')


if __name__ == '__main__':
    main()
