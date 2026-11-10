# Aninux – il robottino

Un piccolo robottino animato che vive nella barra in alto di GNOME e fa da assistente personale,
usando [Claude Code](https://claude.com/claude-code) come "cervello".

Gli scrivi (o gli parli) e lui:

- **cerca e legge i tuoi file** e risponde alle domande sul loro contenuto;
- **apre app, siti e file**: Firefox, Spotify (ricerche, "Brani che ti piacciono", play/pausa/avanti),
  Obsidian (apre un vault e cerca nelle note), qualsiasi file o cartella;
- **modifica i file solo con il tuo permesso**: ogni richiesta compare nel riquadro con i pulsanti
  *Accetta* / *Rifiuta*;
- **parla e ascolta**, tutto offline, con Piper (voce italiana) e Whisper (riconoscimento vocale).

Il robottino cammina, saluta, pensa mentre lavora e si addormenta quando non lo usi.

## Requisiti

- GNOME Shell **50**
- [Claude Code](https://claude.com/claude-code) installato e con accesso già fatto (`claude` nel `PATH`
  oppure in `~/.local/bin/claude`)
- Per la voce (facoltativa): Python 3 con `venv`, `curl`, PipeWire (`pw-record`) e circa 1 GB di spazio

## Installazione

```bash
git clone https://github.com/antix1999-del/aninux-robottino.git ~/.local/share/gnome-shell/extensions/robottino@aninux
cd ~/.local/share/gnome-shell/extensions/robottino@aninux
glib-compile-schemas schemas/
```

Poi esci e rientra nella sessione (su Wayland serve per caricare una nuova estensione) e abilitala:

```bash
gnome-extensions enable robottino@aninux
```

### Voce (facoltativa)

```bash
./installa-voce.sh
```

Scarica in `~/.local/share/aninux-robottino/voce` la voce italiana *Paola* di Piper e il modello
*small* di Whisper. Dopo l'installazione compare il pulsante 🎤 nel riquadro.

## Uso

| Scorciatoia | Azione |
| --- | --- |
| `Super` + `Spazio` | apre il riquadro di Aninux |
| `Ctrl` + `Super` + `Spazio` | apre il riquadro e accende il microfono |

Dalle impostazioni dell'estensione puoi cambiare le scorciatoie, il modello Claude
(sonnet, opus, haiku) e quando rispondere a voce (*solo se gli parli*, *sempre*, *mai*).

## Come funziona

- `extension.js` – l'indicatore nella barra, il riquadro della chat e le animazioni. Avvia
  `claude -p` in modalità `stream-json` e riprende la stessa sessione tra un messaggio e l'altro.
  Le azioni (aprire app, siti, file) arrivano da Claude come righe `[[AZIONE: {...}]]` in fondo alla risposta.
- `permission-bridge.py` – piccolo server MCP che inoltra a GNOME, via D-Bus, le richieste di permesso
  di Claude Code, così puoi accettarle o rifiutarle dal riquadro.
- `voce.py` – processo in background per parlare (Piper) e ascoltare (faster-whisper), comandato via stdin/stdout in JSON.
- `installa-voce.sh` – installa le dipendenze della voce.

La cronologia della chat viene salvata in `~/.local/share/aninux-robottino/chat.json`.
Aninux non può leggere né modificare file sensibili come le credenziali di Claude Code, le chiavi SSH e `/etc/shadow`.

## Licenza

[MIT](LICENSE)
