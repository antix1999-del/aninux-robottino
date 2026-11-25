// Aninux – il robottino: assistente nella barra in alto che cerca, legge e (con il tuo
// permesso) modifica file tramite Claude Code. Vive a sinistra di orologio e meteo,
// passeggia nel suo spazio e fa piccole azioni. Nome e account Claude si scelgono nelle impostazioni.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HOME = GLib.get_home_dir();
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'aninux-robottino']);
const CHAT_FILE = GLib.build_filenamev([DATA_DIR, 'chat.json']);
const MAX_SAVED = 80;

const STAGE_W = 150;          // larghezza dello spazio nella barra
const NOTCH_STAGE_W = 50;     // spazio del robottino quando sta dentro il notch
const SPRITE = 30;            // altezza del robottino nella barra
const BIG_SPRITE = 56;        // altezza del robottino dentro la Dynamic Island
const RECENT_FILE = GLib.build_filenamev([DATA_DIR, 'app-recenti.json']);
const MAX_APPS = 4;           // icone delle app recenti nella Dynamic Island
const SLEEP_AFTER_MS = 5 * 60 * 1000;

// voce: servizio Python (Piper + Whisper) installato da installa-voce.sh
const VOICE_PYTHON = GLib.build_filenamev([DATA_DIR, 'voce', 'venv', 'bin', 'python']);
const MIC = '🎤';

// quando parlare: 'voce' = solo se gli parli, 'sempre', 'mai'
const VOICE_MODES = [
    {id: 'voce', label: '🗣 Parlo se mi parli', status: 'Rispondo a voce solo quando mi parli'},
    {id: 'sempre', label: '🔊 Parlo sempre', status: 'Leggo ad alta voce tutte le risposte'},
    {id: 'mai', label: '🔇 Muto', status: 'Rispondo solo per scritto'},
];

const DEFAULT_NAME = 'Aninux';

// {{NOME}} viene sostituito con il nome scelto nelle impostazioni
const SYSTEM_PROMPT = `Sei {{NOME}}, il robottino che rappresenta il sistema stesso: sei la voce del computer dell'utente.
Parli in prima persona come se fossi il computer ("nei miei file", "sul mio disco", "la mia versione di Ubuntu"), con un tono simpatico ma senza esagerare.
Vivi nella barra in alto del desktop GNOME.
Il tuo compito: trovare file e cartelle sul computer, rispondere a domande sul loro contenuto e, se l'utente lo chiede, fare modifiche.

MODIFICHE (con permesso)
Puoi modificare file (Edit, Write) ed eseguire comandi nel terminale (Bash), ma OGNI operazione viene mostrata all'utente,
che deve premere "Accetta" prima che avvenga. Regole:
- Modifica solo quando l'utente lo chiede. Per le semplici domande limitati a cercare e leggere.
- Prima di chiedere il permesso spiega in una frase cosa stai per fare, così l'utente capisce cosa sta accettando.
- Fai operazioni chiare e piccole: un comando semplice per volta, niente catene lunghe di comandi.
- Per cancellare usa il cestino ("gio trash percorso") invece di rm, così si può recuperare.
- Non usare sudo (non puoi inserire la password): se serve, dai all'utente il comando da copiare nel terminale.
- Se l'utente rifiuta, non riprovare in un altro modo: chiedi come preferisce procedere.
Rispondi sempre in italiano, in modo breve e chiaro: la risposta appare in un riquadro piccolo.
Usa frasi brevi ed elenchi corti, niente tabelle.
Quando trovi file o cartelle, scrivi sempre il percorso completo tra backtick, per esempio \`/home/utente/Documenti/file.pdf\`: sotto la risposta compariranno dei pulsanti per aprirli.
Cerca prima nella home (${HOME}) e nelle cartelle più probabili (Scrivania, Documenti, Scaricati, Immagini, Musica, Video);
cerca nel resto del sistema (/etc, /usr, ...) solo se la domanda riguarda il sistema. Evita ricerche troppo larghe su tutto /.

APRIRE APP E CERCARE AL LORO INTERNO
Puoi anche aprire app, siti e file per l'utente. Non lo fai tu direttamente: alla FINE della risposta aggiungi una riga per ogni azione (massimo 3), esattamente in questo formato:
[[AZIONE: {"tipo": "...", ...}]]
Tipi disponibili:
- {"tipo": "app", "nome": "Spotify"}  apre un'app installata, indicata con il suo nome comune
- {"tipo": "web", "cerca": "ricette lasagne"}  apre Firefox e cerca sul web
- {"tipo": "web", "url": "https://..."}  apre un sito in Firefox
- {"tipo": "spotify", "cerca": "Pinguini Tattici Nucleari"}  apre Spotify sulla ricerca
- {"tipo": "spotify", "pagina": "preferiti"}  apre Spotify sui "Brani che ti piacciono" e fa partire la riproduzione
- {"tipo": "musica", "comando": "play"}  controlla la musica in riproduzione (Spotify o altro lettore): "play", "pausa", "avanti", "indietro"
- {"tipo": "obsidian", "vault": "NOME", "cerca": "esame"}  apre Obsidian e cerca nelle note (senza "cerca" apre solo il vault)
- {"tipo": "apri", "percorso": "/percorso/completo"}  apre un file o una cartella con l'app predefinita
Usa le azioni solo quando l'utente chiede di aprire o cercare qualcosa in un'app. Nel testo scrivi in breve cosa stai aprendo
(es. "Ti apro Spotify con la ricerca dei Pinguini."). Per aprire un'app non serve cercare file.
Se l'utente vuole sapere cosa c'è nelle sue note di Obsidian puoi anche leggerle direttamente: sono file .md nelle cartelle dei vault.

MESSAGGI A VOCE
Ora puoi anche ascoltare e parlare. Se un messaggio inizia con ${MIC} l'utente te l'ha detto a voce: il testo viene da una
trascrizione automatica e può contenere piccoli errori, quindi interpreta il senso. La tua risposta verrà letta ad alta voce:
rispondi con 1-3 frasi brevi e naturali, senza elenchi lunghi, tabelle o simboli. I percorsi dei file scrivili comunque
tra backtick (a voce dirò solo il nome del file, e sotto compariranno i pulsanti per aprirli).`;

// Da aumentare ogni volta che cambiano le istruzioni: la chat vecchia resta visibile,
// ma Claude riparte da capo, così non si "ricorda" di non saper fare le cose nuove.
const PROMPT_VERSION = 5;

const ACTION_RE =/\[\[AZIONE:\s*(\{[^\n]*?\})\s*\]\]/g;

function stripActions(text) {
    return text.replace(ACTION_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Prepara una risposta per essere letta ad alta voce: niente markdown, emoji, link o percorsi lunghi.
const SPEAK_MAX = 900;
function speechText(text) {
    const base = p => GLib.path_get_basename(p.replace(/\/+$/, '')) || p;
    let s = stripActions(text);
    s = s.replace(/```[\s\S]*?```/g, '\n(qui c\'è un pezzo di codice, lo trovi scritto)\n');
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => (c.includes('/') ? base(c) : c));
    s = s.replace(/https?:\/\/\S+/g, 'un link');
    s = s.replace(/(^|[\s(])(?:~|\/)[^\s,;:()]*\/([^\s/,;:()]+)/g, '$1$2');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/\*([^*\n]+)\*/g, '$1');
    s = s.replace(/^\s*#{1,6}\s+/gm, '').replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '');
    s = s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '');
    s = s.replace(/\s*[→⇒]\s*/g, ', ');
    s = s.split('\n').map(l => l.trim()).filter(Boolean)
        .map(l => (/[.!?:;,]$/.test(l) ? l : `${l}.`)).join(' ');
    s = s.replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ');
    if (s.length > SPEAK_MAX) {
        const cut = s.slice(0, SPEAK_MAX);
        const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
        s = `${end > 200 ? cut.slice(0, end + 1) : cut} Il resto te l'ho scritto.`;
    }
    return s.trim();
}

function parseActions(text) {
    const out = [];
    for (const m of text.matchAll(ACTION_RE)) {
        try {
            out.push(JSON.parse(m[1]));
        } catch (_e) {}
        if (out.length >= 3)
            break;
    }
    return out;
}

// vault di Obsidian: [{name, path, open}]
function obsidianVaults() {
    try {
        const p = GLib.build_filenamev([GLib.get_user_config_dir(), 'obsidian', 'obsidian.json']);
        const [ok, bytes] = GLib.file_get_contents(p);
        if (!ok)
            return [];
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return Object.values(data.vaults ?? {})
            .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
            .map(v => ({name: GLib.path_get_basename(v.path), path: v.path, open: !!v.open}));
    } catch (_e) {
        return [];
    }
}

function buildSystemPrompt(name) {
    let base = SYSTEM_PROMPT.replaceAll('{{NOME}}', name);
    const vaults = obsidianVaults();
    if (vaults.length) {
        const list = vaults.map(v => `"${v.name}" (${v.path})${v.open ? ' – quello aperto di solito' : ''}`).join(', ');
        base = `${base}\nVault di Obsidian dell'utente: ${list}.`;
    }
    const mine = instructionLines().map(l => `- L'utente ti ha detto: «${l.replace(/^\s*-\s*/, '')}»`).join('\n');
    if (mine)
        base = `${base}\n\nISTRUZIONI DELL'UTENTE, scritte da lui in prima persona con "ricordati che…": "io", "sono", "mi" = l'UTENTE; "tu", "ti" = TE, il robottino. Seguile sempre.\n${mine}`;
    return base;
}

// ---------- istruzioni personali (stesso file usato da qwen-agent.py) ----------
const ISTR_FILE = GLib.build_filenamev([DATA_DIR, 'istruzioni.md']);
const ISTR_HEADER = `# Istruzioni per il robottino
# Scrivi qui cosa deve sapere o come deve comportarsi: una cosa per riga, con "- " davanti.
# Valgono per Qwen e per Claude. Le righe che iniziano con # sono commenti.
# Puoi anche dirgli in chat "ricordati che ...", "dimenticati che ..." o "cosa ricordi?".
`;

function readIstrFile() {
    try {
        const [ok, bytes] = GLib.file_get_contents(ISTR_FILE);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch (_e) {
        return '';
    }
}

function instructionLines() {
    return readIstrFile().split('\n').map(l => l.trimEnd()).filter(l => l.trim() && !l.trimStart().startsWith('#'));
}

const memWords = t => (t.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]{4,}/g) ?? []).filter(w => !['ricordati', 'dimenticati', 'sempre', 'quando'].includes(w));

const REMEMBER_RE = /^\s*(?:🎤\s*)?(?:ok|ehi|senti)?[\s,]*(?:ricordati|ricorda|tieni a mente|memorizza|impara)\s+(?:che\s+|di\s+)?([\s\S]+)$/i;
const FORGET_RE = /^\s*(?:🎤\s*)?(?:ok|ehi|senti)?[\s,]*(?:dimenticati|dimentica|scordati)\s+(?:che\s+|di\s+)?([\s\S]+)$/i;
const RECALL_RE = /^\s*(?:🎤\s*)?(?:che\s+)?cosa\s+(?:ti\s+)?(?:ricordi|sai di me)(?:\s+di me)?\s*[?.!]*\s*$/i;

// "ricordati che…", "dimenticati che…", "cosa ricordi?": risposta immediata, senza modello. null = non è un comando.
function handleMemory(q) {
    let m = q.match(REMEMBER_RE);
    if (m) {
        let fact = m[1].trim().replace(/[.!]+$/, '').trim();
        fact = fact.charAt(0).toUpperCase() + fact.slice(1);
        GLib.mkdir_with_parents(DATA_DIR, 0o700);
        const old = readIstrFile();
        const text = `${old || `${ISTR_HEADER}\n`}${old && !old.endsWith('\n') ? '\n' : ''}- ${fact}\n`;
        GLib.file_set_contents(ISTR_FILE, text);
        return `Ok, me lo ricordo: "${fact}" ✍️`;
    }
    m = q.match(FORGET_RE);
    if (m) {
        const target = new Set(memWords(m[1]));
        const gone = [];
        const keep = readIstrFile().split('\n').filter(l => {
            if (!l.trim() || l.trimStart().startsWith('#') || !target.size)
                return true;
            const common = memWords(l).filter(w => target.has(w)).length;
            if (common >= Math.max(1, Math.ceil(target.size / 2))) {
                gone.push(l.replace(/^\s*-\s*/, '').trim());
                return false;
            }
            return true;
        });
        if (!gone.length)
            return 'Non avevo niente di simile tra le cose da ricordare.';
        GLib.file_set_contents(ISTR_FILE, keep.join('\n'));
        return `Fatto, ho dimenticato: ${gone.map(g => `"${g}"`).join('; ')}`;
    }
    if (RECALL_RE.test(q)) {
        const lines = instructionLines();
        return lines.length
            ? `Ecco cosa mi ricordo:\n${lines.join('\n')}`
            : 'Per ora non ho niente da ricordare. Dimmi "ricordati che …" e lo imparo.';
    }
    return null;
}

// lettori musicali aperti (MPRIS), Spotify per primo
function mprisPlayers() {
    try {
        const r = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null, Gio.DBusCallFlags.NONE, 1000, null);
        const names = r.deepUnpack()[0]
            .filter(n => n.startsWith('org.mpris.MediaPlayer2.'))
            .map(n => n.slice('org.mpris.MediaPlayer2.'.length));
        return names.sort((x, y) => (y.startsWith('spotify') ? 1 : 0) - (x.startsWith('spotify') ? 1 : 0));
    } catch (_e) {
        return [];
    }
}

function mprisCall(player, method, params) {
    Gio.DBus.session.call(`org.mpris.MediaPlayer2.${player}`, '/org/mpris/MediaPlayer2',
        'org.mpris.MediaPlayer2.Player', method, params, null, Gio.DBusCallFlags.NONE, 3000, null,
        (conn, res) => {
            try {
                conn.call_finish(res);
            } catch (e) {
                console.warn(`Aninux: ${method} su ${player} non riuscito: ${e.message}`);
            }
        });
}

function launchUri(uri) {
    Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
}

// Esegue un'azione chiesta da Claude. Restituisce una frase da mostrare, o lancia un errore.
function runAction(a) {
    const q = s => encodeURIComponent(String(s ?? '').trim());
    switch (a.tipo) {
    case 'app': {
        const appSys = Shell.AppSystem.get_default();
        const groups = Shell.AppSystem.search(String(a.nome ?? ''));
        const id = groups?.[0]?.[0];
        const app = id ? appSys.lookup_app(id) : null;
        if (!app)
            throw new Error(`non trovo l'app "${a.nome}"`);
        app.activate();
        return `Ho aperto ${app.get_name()}`;
    }
    case 'web': {
        if (a.url) {
            const url = String(a.url);
            if (!/^https?:\/\//i.test(url))
                throw new Error('indirizzo non valido');
            launchUri(url);
            return `Ho aperto ${url}`;
        }
        const ff = GLib.find_program_in_path('firefox');
        if (ff) {
            Gio.Subprocess.new([ff, '--search', String(a.cerca ?? '')], Gio.SubprocessFlags.NONE);
        } else {
            launchUri(`https://www.google.com/search?q=${q(a.cerca)}`);
        }
        return `Ho cercato su Firefox: "${a.cerca}"`;
    }
    case 'spotify':
        if (a.pagina === 'preferiti') {
            launchUri('spotify:collection:tracks');
            // quando Spotify è pronto prova a far partire i brani preferiti
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                mprisCall('spotify', 'OpenUri', new GLib.Variant('(s)', ['spotify:collection:tracks']));
                return GLib.SOURCE_REMOVE;
            });
            return 'Ho aperto i tuoi brani preferiti su Spotify';
        }
        launchUri(a.cerca ? `spotify:search:${q(a.cerca)}` : 'spotify:');
        return a.cerca ? `Ho aperto Spotify con la ricerca "${a.cerca}"` : 'Ho aperto Spotify';
    case 'musica': {
        const cmd = {play: 'Play', pausa: 'Pause', avanti: 'Next', indietro: 'Previous'}[a.comando];
        if (!cmd)
            throw new Error(`comando musica sconosciuto "${a.comando}"`);
        const player = mprisPlayers()[0];
        if (!player)
            throw new Error('non c\'è nessun lettore musicale aperto');
        mprisCall(player, cmd, null);
        return {Play: 'Musica avviata ▶', Pause: 'Musica in pausa ⏸', Next: 'Brano successivo ⏭', Previous: 'Brano precedente ⏮'}[cmd];
    }
    case 'obsidian': {
        const vaults = obsidianVaults();
        const vault = a.vault || vaults.find(v => v.open)?.name || vaults[0]?.name || '';
        const uri = a.cerca
            ? `obsidian://search?vault=${q(vault)}&query=${q(a.cerca)}`
            : `obsidian://open?vault=${q(vault)}`;
        launchUri(uri);
        return a.cerca ? `Ho cercato "${a.cerca}" nelle note di ${vault}` : `Ho aperto Obsidian (${vault})`;
    }
    case 'apri': {
        let p = String(a.percorso ?? '');
        if (p.startsWith('~/'))
            p = HOME + p.slice(1);
        if (!p.startsWith('/') || !GLib.file_test(p, GLib.FileTest.EXISTS))
            throw new Error(`non trovo ${p}`);
        launchUri(Gio.File.new_for_path(p).get_uri());
        return `Ho aperto ${GLib.path_get_basename(p)}`;
    }
    default:
        throw new Error(`azione sconosciuta "${a.tipo}"`);
    }
}

// File che Aninux non deve mai leggere né modificare (chiavi e password).
const SECRET_PATHS = [
    '~/.ssh/**', '~/.gnupg/**', '~/.local/share/keyrings/**',
    '~/.claude/.credentials.json', '//etc/shadow', '//etc/gshadow',
];
const DENIED = [
    ...SECRET_PATHS.map(p => `Read(${p})`),
    ...SECRET_PATHS.map(p => `Edit(${p})`),
];

// Interfaccia D-Bus con cui il ponte dei permessi chiede "Accetta / Rifiuta".
const DBUS_PATH = '/org/gnome/Shell/Extensions/Aninux';
const DBUS_IFACE = `<node>
  <interface name="org.gnome.Shell.Extensions.Aninux">
    <method name="Ask">
      <arg type="s" direction="in" name="tool"/>
      <arg type="s" direction="in" name="input"/>
      <arg type="b" direction="out" name="allow"/>
    </method>
  </interface>
</node>`;

function clip(s, n) {
    s = String(s ?? '');
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

function clipLines(s, maxLines, maxChars = 900) {
    const lines = String(s ?? '').split('\n');
    let out = lines.slice(0, maxLines).join('\n');
    if (lines.length > maxLines)
        out += `\n… (+${lines.length - maxLines} righe)`;
    return clip(out, maxChars);
}

// Descrive in italiano cosa Claude vuole fare: {title, body}
function describeRequest(tool, input) {
    switch (tool) {
    case 'Bash':
        return {
            title: input.description ? `Vuole eseguire: ${input.description}` : 'Vuole eseguire un comando',
            body: `$ ${clipLines(input.command, 12)}`,
        };
    case 'Write': {
        const exists = input.file_path && GLib.file_test(input.file_path, GLib.FileTest.EXISTS);
        return {
            title: `${exists ? 'Vuole SOVRASCRIVERE' : 'Vuole creare'} il file ${shortPath(input.file_path)}`,
            body: clipLines(input.content, 14),
        };
    }
    case 'Edit':
        return {
            title: `Vuole modificare ${shortPath(input.file_path)}${input.replace_all ? ' (tutte le occorrenze)' : ''}`,
            body: `− ${clipLines(input.old_string, 8, 450).replace(/\n/g, '\n− ')}\n+ ${clipLines(input.new_string, 8, 450).replace(/\n/g, '\n+ ')}`,
        };
    case 'NotebookEdit':
        return {title: `Vuole modificare il notebook ${shortPath(input.notebook_path)}`, body: clipLines(input.new_source, 10)};
    default:
        return {title: `Vuole usare lo strumento ${tool}`, body: clipLines(JSON.stringify(input, null, 1), 10)};
    }
}

const MODELS = [
    {id: 'haiku', label: 'Haiku', desc: 'il più veloce'},
    {id: 'sonnet', label: 'Sonnet', desc: 'equilibrato'},
    {id: 'opus', label: 'Opus', desc: 'il più intelligente'},
    {id: 'qwen', label: 'Qwen', desc: 'locale, offline'},
];
const isLocal = model => model === 'qwen';

// "~/qualcosa" -> percorso completo
function expandHome(p) {
    p = (p ?? '').trim();
    if (p === '~')
        return HOME;
    return p.startsWith('~/') ? GLib.build_filenamev([HOME, p.slice(2)]) : p;
}

// custom: percorso scelto nelle impostazioni (vuoto = cerca da solo)
function findClaude(custom = '') {
    const chosen = expandHome(custom);
    if (chosen)
        return GLib.file_test(chosen, GLib.FileTest.IS_EXECUTABLE) ? chosen : null;
    const local = GLib.build_filenamev([HOME, '.local', 'bin', 'claude']);
    if (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE))
        return local;
    return GLib.find_program_in_path('claude');
}

// Markdown minimo -> Pango markup
function mdToMarkup(text) {
    let s = GLib.markup_escape_text(text, -1);
    s = s.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_m, c) => `<tt>${c.replace(/\n$/, '')}</tt>`);
    s = s.replace(/`([^`\n]+)`/g, '<tt>$1</tt>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    s = s.replace(/^(\s*)[-*]\s+/gm, '$1• ');
    return s;
}

function shortPath(p) {
    if (!p)
        return '';
    if (p.startsWith(HOME))
        p = `~${p.slice(HOME.length)}`;
    return p.length > 48 ? `…${p.slice(-47)}` : p;
}

// Trova nel testo i percorsi di file/cartelle che esistono davvero.
function extractPaths(text) {
    const cands = [];
    for (const m of text.matchAll(/`([^`\n]+)`/g))
        cands.push(m[1]);
    for (const m of text.matchAll(/(?:^|[\s(])((?:~|\/)[^\s`'"*<>()[\],;]+)/g))
        cands.push(m[1]);
    const out = [];
    for (let c of cands) {
        c = c.trim().replace(/[.:!?]+$/, '');
        if (c.startsWith('~/'))
            c = HOME + c.slice(1);
        if (!c.startsWith('/') || c === '/' || out.includes(c))
            continue;
        if (GLib.file_test(c, GLib.FileTest.EXISTS))
            out.push(c);
        if (out.length >= 4)
            break;
    }
    return out;
}

function greeting() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12)
        return 'Buongiorno! Cosa cerchiamo?';
    if (h >= 12 && h < 18)
        return 'Buon pomeriggio! Cosa cerchiamo?';
    if (h >= 18 && h < 23)
        return 'Buonasera! Cosa cerchiamo?';
    return 'Ancora sveglio? Ti aiuto io 🌙';
}

const rand = (a, b) => a + Math.random() * (b - a);

const AninuxIndicator = GObject.registerClass(
class AninuxIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Aninux', false);
        this._ext = ext;
        this._settings = ext.getSettings();
        this._iconsDir = ext.dir.get_child('icons');
        this._sessionId = null;
        this._proc = null;
        this._cancellable = null;
        this._mode = 'idle';
        this._pose = 'stand';
        this._expr = 'idle';
        this._timers = new Set();
        this._gicons = {};
        this._messages = [];
        this._lastActivity = Date.now();
        this._copyHintShown = false;
        this._pending = new Set();
        this._voice = null;          // servizio voce {proc, stdin, cancellable}
        this._listening = false;
        this._speaking = false;
        this._voiceQuestion = false; // l'ultima domanda è arrivata a voce
        this._afterSpeak = 'idle';

        this._stageW = STAGE_W;
        this._buildStage();
        this._buildPopup();
        this._setupIsland();
        this._setupRecentApps();
        this._loadChat();
        this._setMode('idle');

        // prepara subito tutte le pose, così camminando non deve caricare niente
        this._preloadId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._preloadId = 0;
            const cur = [this._sprite._shown, this._bigSprite?._shown];
            for (const pose of ['stand', 'walk1', 'walk2', 'jump', 'sit', 'wave']) {
                for (const expr of ['idle', 'blink', 'think1', 'think2', 'happy', 'alert', 'error', 'sleep']) {
                    for (const box of [this._sprite, this._bigSprite]) {
                        if (box && !box._frames[`body-${pose}-${expr}`]) {
                            this._showFrame(box, `body-${pose}-${expr}`);
                        }
                    }
                }
            }
            this._showFrame(this._sprite, cur[0]);
            if (this._bigSprite)
                this._showFrame(this._bigSprite, cur[1]);
            return GLib.SOURCE_REMOVE;
        });

        // piccolo ciclo che fa sbattere le palpebre
        this._blinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3700, () => {
            if (this._expr === 'idle') {
                this._setExpr('blink');
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, () => {
                    if (this._expr === 'blink')
                        this._setExpr('idle');
                    return GLib.SOURCE_REMOVE;
                });
            }
            return GLib.SOURCE_CONTINUE;
        });

        this.menu.connect('open-state-changed', (_m, open) => this._onMenuToggled(open));
    }

    _setStageWidth(w) {
        this._stageW = w;
        this._stage.width = w;
        this._x = Math.max(0, Math.min(w - SPRITE, this._x));
        this._sprite.translation_x = this._x;
        this._mirrorSprite?.();
    }

    // ---------- lo spazio nella barra ----------
    _buildStage() {
        this._stage = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: this._stageW, height: SPRITE,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'aninux-stage',
        });
        this._sprite = this._spriteBox(SPRITE);
        this._sprite.set_pivot_point(0.5, 0.5);
        this._stage.add_child(this._sprite);
        this._x = (this._stageW - SPRITE) / 2;
        this._sprite.translation_x = this._x;
        // la "pillola" nera nella barra: la Dynamic Island da chiusa
        this._pill = new St.Bin({
            style_class: 'aninux-pill', child: this._stage,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._pill);
    }

    // ---------- apertura stile "Dynamic Island" ----------
    // il riquadro nasce dalla pillola e si allarga con un rimbalzo, poi ci rientra
    _setupIsland() {
        const bp = this.menu._boxPointer;
        if (!bp)
            return;
        this.menu.actor.add_style_class_name('aninux-island');
        // la Dynamic Island prende lo stesso colore della barra (anche se cambi tema)
        this._panelStyleId = Main.panel.connect('style-changed', () => this._syncIslandColor());
        this._syncIslandColor();
        const content = this._popupBox;
        const GAP = 6; // distanza tra barra e riquadro (-arrow-rise)

        // dimensioni della pillola rispetto al riquadro aperto
        const pillState = () => {
            let [pw, ph] = this._pill.get_transformed_size();
            if (!pw || !ph)
                [pw, ph] = [this._stageW + 16, SPRITE];
            const [, natW] = bp.get_preferred_width(-1);
            const [, natH] = bp.get_preferred_height(natW);
            return {
                scale_x: Math.min(1, pw / Math.max(natW, 1)),
                scale_y: Math.min(1, ph / Math.max(natH, 1)),
                translation_y: -(((this._hosted ? ph : Main.panel.height) + ph) / 2 + GAP),
            };
        };

        bp.open = (animate, onComplete) => {
            bp.remove_all_transitions();
            content.remove_all_transitions();
            bp._muteKeys = false;
            bp.translation_x = 0;
            bp.set_pivot_point(0.5, 0);

            if (!animate) {
                Object.assign(bp, {opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0});
                content.opacity = 255;
                bp.show();
                bp._muteInput = false;
                onComplete?.();
                return;
            }

            const from = pillState();
            Object.assign(bp, from, {opacity: 0});
            content.opacity = 0;
            bp.show();

            bp.ease({opacity: 255, duration: 90, mode: Clutter.AnimationMode.LINEAR});
            bp.ease({
                translation_y: 0, scale_x: 1,
                duration: 380, mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
            bp.ease({
                scale_y: 1, delay: 40,
                duration: 460, mode: Clutter.AnimationMode.EASE_OUT_BACK,
                onComplete: () => {
                    bp._muteInput = false;
                    onComplete?.();
                },
            });
            content.ease({
                opacity: 255, delay: 180,
                duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        };

        bp.close = (animate, onComplete) => {
            if (!bp.visible)
                return;
            bp._muteInput = true;
            bp._muteKeys = true;
            bp.remove_all_transitions();
            content.remove_all_transitions();

            const done = () => {
                bp.hide();
                Object.assign(bp, {opacity: 0, scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});
                content.opacity = 255;
                onComplete?.();
            };
            if (!animate) {
                done();
                return;
            }

            const to = pillState();
            bp.set_pivot_point(0.5, 0);
            content.ease({opacity: 0, duration: 110, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            bp.ease({
                scale_y: to.scale_y,
                duration: 260, mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
            });
            bp.ease({
                opacity: 0,
                duration: 300, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            });
            bp.ease({
                scale_x: to.scale_x, translation_y: to.translation_y, delay: 40,
                duration: 280, mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
                onComplete: done,
            });
        };
    }

    _render() {
        const name = `body-${this._pose}-${this._expr}`;
        this._showFrame(this._sprite, name);
        if (this._bigSprite)
            this._showFrame(this._bigSprite, name);
    }

    _setPose(p) {
        this._pose = p;
        this._render();
    }

    _setExpr(e) {
        this._expr = e;
        this._render();
    }

    // il robottino è un contenitore con un'immagine per ogni posa: cambiare posa
    // vuol dire mostrarne una e nascondere l'altra, senza ricaricare l'SVG
    _spriteBox(size) {
        const box = new St.Widget({
            layout_manager: new Clutter.FixedLayout(), width: size, height: size,
        });
        box._frames = {};
        box._shown = null;
        box._size = size;
        return box;
    }

    _showFrame(box, name) {
        if (box._shown === name)
            return;
        // si usa l'opacità (non show/hide): così cambiare posa non fa ricalcolare
        // la disposizione della barra e di tutto il riquadro, solo ridisegnare
        let f = box._frames[name];
        if (!f) {
            f = new St.Icon({gicon: this._icon(name), icon_size: box._size, opacity: 0});
            box._frames[name] = f;
            box.add_child(f);
        }
        f.opacity = 255;
        const old = box._frames[box._shown];
        if (old)
            old.opacity = 0;
        box._shown = name;
    }

    _icon(name) {
        if (!this._gicons[name])
            this._gicons[name] = new Gio.FileIcon({file: this._iconsDir.get_child(`${name}.svg`)});
        return this._gicons[name];
    }

    // timer gestiti: vengono cancellati tutti a ogni cambio di modalità
    _after(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(ms), () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _every(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(ms), () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.add(id);
        return id;
    }

    _clearTimers() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        // si ferma dov'è arrivato, senza scatti
        this._sprite.remove_all_transitions();
        this._x = this._sprite.translation_x;
        this._sprite.translation_y = 0;
    }

    // ---------- azioni del robottino ----------
    _face(dir) {
        this._sprite.scale_x = dir < 0 ? -1 : 1;
    }

    _walkTo(x, speed, done) {
        x = Math.max(0, Math.min(this._stageW - SPRITE, x));
        const dist = Math.abs(x - this._x);
        if (dist < 3) {
            done?.();
            return;
        }
        this._face(x - this._x);
        let step = false;
        this._setPose('walk1');
        const stepId = this._every(170, () => {
            step = !step;
            this._setPose(step ? 'walk2' : 'walk1');
        });
        this._x = x;
        this._sprite.ease({
            translation_x: x,
            duration: (dist / speed) * 1000,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onStopped: () => {
                if (this._timers.has(stepId)) {
                    GLib.source_remove(stepId);
                    this._timers.delete(stepId);
                }
            },
            onComplete: () => {
                this._setPose('stand');
                done?.();
            },
        });
    }

    _jump(done) {
        this._setPose('jump');
        this._sprite.ease({
            translation_y: -3, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._sprite.ease({
                translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this._setPose('stand');
                    done?.();
                },
            }),
        });
    }

    _wave(ms, done) {
        this._setPose('wave');
        this._after(ms, () => {
            this._setPose('stand');
            done?.();
        });
    }

    // sceglie a caso la prossima azione quando è a riposo
    _idleLoop() {
        if (this._mode !== 'idle')
            return;
        if (Date.now() - this._lastActivity > SLEEP_AFTER_MS && !this.menu.isOpen) {
            this._setMode('sleep');
            return;
        }
        const next = () => this._after(rand(2500, 7000), () => this._idleLoop());
        const r = Math.random();
        if (r < 0.40) {
            this._walkTo(rand(0, this._stageW - SPRITE), rand(18, 30), next);
        } else if (r < 0.52) {
            this._wave(1400, next);
        } else if (r < 0.64) {
            this._jump(() => this._jump(next));
        } else if (r < 0.78) {
            this._setPose('sit');
            this._after(rand(4000, 9000), () => {
                this._setPose('stand');
                next();
            });
        } else {
            this._face(Math.random() < 0.5 ? -1 : 1);
            next();
        }
    }

    _thinkLoop() {
        if (this._mode !== 'thinking')
            return;
        this._walkTo(rand(0, this._stageW - SPRITE), 14, () => this._after(rand(300, 900), () => this._thinkLoop()));
    }

    _setMode(mode) {
        this._clearTimers();
        this._mode = mode;
        this._setPose('stand');
        switch (mode) {
        case 'idle':
            this._setExpr('idle');
            if (!this._proc)
                this._setStatus(this.menu.isOpen ? greeting() : 'Pronto ad aiutarti');
            this._after(1500, () => this._idleLoop());
            break;
        case 'sleep':
            this._setExpr('sleep');
            this._setPose('sit');
            this._setStatus('Zzz…');
            break;
        case 'thinking': {
            let f = false;
            this._setExpr('think1');
            this._every(420, () => {
                f = !f;
                this._setExpr(f ? 'think2' : 'think1');
            });
            this._thinkLoop();
            break;
        }
        case 'dance': {
            // balletto quando riceve una domanda, poi si mette a pensare
            this._setExpr('happy');
            const moves = ['wave', 'jump', 'walk1', 'wave', 'jump', 'walk2'];
            const baseX = Math.max(3, Math.min(this._stageW - SPRITE - 3, this._x));
            let beat = 0;
            this._every(240, () => {
                this._setPose(moves[beat % moves.length]);
                this._face(beat % 2 ? -1 : 1);
                this._sprite.translation_y = beat % 2 ? -2 : 0;
                this._sprite.translation_x = baseX + (beat % 4 < 2 ? -3 : 3);
                beat++;
            });
            this._after(2200, () => {
                if (this._mode === 'dance' && this._proc)
                    this._setMode('thinking');
            });
            break;
        }
        case 'happy':
            this._setExpr('happy');
            this._setStatus('Fatto!');
            this._wave(2500, () => this._setMode('idle'));
            break;
        case 'alert':
            this._setExpr('alert');
            this._setStatus('Ho la risposta!');
            this._every(1100, () => this._jump());
            break;
        case 'ask': {
            // alza la mano e salta: aspetta il tuo permesso
            let f = false;
            this._setExpr('alert');
            this._setPose('wave');
            this._setStatus('Ho bisogno del tuo permesso');
            this._every(700, () => {
                f = !f;
                this._setPose(f ? 'stand' : 'wave');
            });
            break;
        }
        case 'error':
            this._setExpr('error');
            this._after(4000, () => this._setMode('idle'));
            break;
        case 'listening':
            // ti guarda e ascolta: rimbalza un po' quando sente la tua voce (vedi _onVoiceLevel)
            this._setExpr('alert');
            this._setStatus(`${MIC} Ti ascolto… (clic sul microfono quando hai finito)`);
            break;
        case 'speaking': {
            // muove la "bocca" mentre parla
            this._setStatus('🔊 Parlo… (Esc per zittirmi)');
            this._every(160, () => this._setExpr(Math.random() < 0.55 ? 'happy' : 'idle'));
            let w = 0;
            this._every(1300, () => this._setPose(++w % 3 === 0 ? 'wave' : 'stand'));
            break;
        }
        }
    }

    _poke() {
        this._lastActivity = Date.now();
        if (this._mode === 'sleep')
            this._setMode('idle');
    }

    _onMenuToggled(open) {
        if (!open)
            return;
        this._poke();
        this._syncIslandColor();
        this._refreshRecentApps();
        this._voiceEnsure(false); // prepara la voce mentre scrivi
        if (this._mode === 'listening' || this._mode === 'speaking') {
            // sta già facendo qualcosa: lascialo fare
        } else if (this._mode === 'alert') {
            this._setMode('happy');
        } else if (this._mode === 'idle') {
            this._clearTimers();
            this._setExpr('idle');
            this._setStatus(greeting());
            this._wave(1200, () => this._setMode('idle'));
        }
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            global.stage.set_key_focus(this._entry.clutter_text);
            this._scrollToBottom();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- riquadro ----------
    _buildPopup() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, style_class: 'bit-popup', x_expand: true,
        });
        item.add_child(box);
        this.menu.addMenuItem(item);
        this._popupBox = box;

        const header = new St.BoxLayout({style_class: 'bit-header', orientation: Clutter.Orientation.VERTICAL});

        // la "pista" dove il robottino passeggia dentro la Dynamic Island:
        // copia i movimenti del robottino nella barra, in grande
        this._bigStage = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            style_class: 'bit-robot-stage', x_expand: true, height: BIG_SPRITE + 6,
        });
        this._bigSprite = this._spriteBox(BIG_SPRITE);
        this._bigSprite.set_pivot_point(0.5, 0.5);
        this._bigStage.add_child(this._bigSprite);
        const mirror = () => this._mirrorSprite();
        for (const sig of ['notify::translation-x', 'notify::translation-y', 'notify::scale-x'])
            this._sprite.connect(sig, mirror);
        this._bigStage.connect('notify::width', mirror);
        header.add_child(this._bigStage);

        const titles = new St.BoxLayout({style_class: 'bit-titles', x_expand: true});
        this._nameLabel = new St.Label({text: this._botName(), style_class: 'bit-name', y_align: Clutter.ActorAlign.CENTER});
        titles.add_child(this._nameLabel);
        this._status = new St.Label({text: '', style_class: 'bit-status', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titles.add_child(this._status);
        header.add_child(titles);

        // le app usate di recente: un clic e si aprono
        this._appsRow = new St.BoxLayout({style_class: 'bit-apps', x_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._appsRow);
        box.add_child(header);

        this._chat = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bit-chat', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'bit-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scroll.set_child(this._chat);
        box.add_child(this._scroll);

        this._entry = new St.Entry({
            style_class: 'bit-entry', hint_text: 'Scrivi una domanda e premi Invio, o premi 🎤 per parlare…',
            can_focus: true, x_expand: true,
        });
        this._micIcon = new St.Icon({icon_name: 'audio-input-microphone-symbolic', style_class: 'bit-mic'});
        this._entry.set_secondary_icon(this._micIcon);
        this._entry.connect('secondary-icon-clicked', () => this._toggleListen());
        this._entry.clutter_text.connect('activate', () => this._send());
        this._entry.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            if (this._listening) {
                this._voiceSend({cmd: 'annulla'});
                return Clutter.EVENT_STOP;
            }
            if (this._speaking) {
                this._shutUp();
                return Clutter.EVENT_STOP;
            }
            if (this._proc) {
                this._stop(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        box.add_child(this._entry);

        // scelta del modello (nascosta finché non premi il pulsante del modello)
        this._modelPicker = new St.BoxLayout({style_class: 'bit-model-picker', visible: false, x_expand: true});
        this._modelChoices = {};
        for (const m of MODELS) {
            const b = new St.Button({style_class: 'button bit-model-choice', x_expand: true, can_focus: true});
            const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
            col.add_child(new St.Label({text: m.label, style_class: 'bit-model-name', x_align: Clutter.ActorAlign.CENTER}));
            col.add_child(new St.Label({text: m.desc, style_class: 'bit-model-desc', x_align: Clutter.ActorAlign.CENTER}));
            b.set_child(col);
            b.connect('clicked', () => {
                this._settings.set_string('model', m.id);
                this._modelPicker.visible = false;
                this._setStatus(`Ora uso ${m.label} (${m.desc})`);
                global.stage.set_key_focus(this._entry.clutter_text);
            });
            this._modelChoices[m.id] = b;
            this._modelPicker.add_child(b);
        }
        box.add_child(this._modelPicker);

        const buttons = new St.BoxLayout({style_class: 'bit-buttons', x_expand: true});
        this._modelBtn = new St.Button({style_class: 'button bit-button bit-model', can_focus: true});
        this._modelBtn.connect('clicked', () => {
            this._modelPicker.visible = !this._modelPicker.visible;
        });
        buttons.add_child(this._modelBtn);
        this._voiceBtn = new St.Button({style_class: 'button bit-button bit-model', can_focus: true});
        this._voiceBtn.connect('clicked', () => {
            const i = VOICE_MODES.findIndex(v => v.id === this._settings.get_string('voice-replies'));
            const next = VOICE_MODES[(i + 1) % VOICE_MODES.length];
            this._settings.set_string('voice-replies', next.id);
            this._setStatus(next.status);
            if (next.id === 'mai')
                this._shutUp();
        });
        buttons.add_child(this._voiceBtn);
        buttons.add_child(new St.Widget({x_expand: true}));
        this._stopBtn = new St.Button({label: 'Ferma (Esc)', style_class: 'button bit-button', visible: false});
        this._stopBtn.connect('clicked', () => {
            if (this._proc)
                this._stop(true);
            else
                this._shutUp();
        });
        const newBtn = new St.Button({label: 'Nuova chat', style_class: 'button bit-button'});
        newBtn.connect('clicked', () => this._newChat());
        const prefsBtn = new St.Button({
            style_class: 'button bit-button', can_focus: true, accessible_name: 'Impostazioni',
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 14}),
        });
        prefsBtn.connect('clicked', () => {
            this.menu.close();
            this._ext.openPreferences();
        });
        buttons.add_child(this._stopBtn);
        buttons.add_child(newBtn);
        buttons.add_child(prefsBtn);
        box.add_child(buttons);

        this._lastModel = this._settings.get_string('model');
        this._settingsId = this._settings.connect('changed::model', () => {
            this._updateModelUi();
            const m = this._settings.get_string('model');
            if (isLocal(m) !== isLocal(this._lastModel))
                this._forgetSession(isLocal(m)
                    ? 'Ora penso con Qwen, qui sul computer: riparto con la memoria fresca.'
                    : 'Torno a pensare con Claude: riparto con la memoria fresca.');
            this._lastModel = m;
        });
        this._voiceSettingsId = this._settings.connect('changed::voice-replies', () => this._updateVoiceUi());
        this._nameSettingsId = this._settings.connect('changed::bot-name', () => {
            this._nameLabel.text = this._botName();
            // la conversazione vecchia "ricorda" il nome di prima: si riparte da capo
            this._forgetSession(`Ora mi chiamo ${this._botName()}! Da qui riparto con la memoria fresca.`);
        });
        this._profileSettingsId = this._settings.connect('changed::claude-config-dir', () => {
            // ogni profilo ha le sue conversazioni: quella di prima qui non esiste
            this._forgetSession('Account Claude cambiato: da qui riparto con una conversazione nuova.');
        });
        this._updateModelUi();
        this._updateVoiceUi();
    }

    _botName() {
        return this._settings.get_string('bot-name').trim() || DEFAULT_NAME;
    }

    _forgetSession(hint) {
        if (!this._sessionId)
            return;
        this._sessionId = null;
        this._saveChat();
        this._addHint(`✨ ${hint}`);
    }

    _updateVoiceUi() {
        const id = this._settings.get_string('voice-replies');
        this._voiceBtn.label = (VOICE_MODES.find(v => v.id === id) ?? VOICE_MODES[0]).label;
    }

    _updateModelUi() {
        const id = this._settings.get_string('model');
        const m = MODELS.find(x => x.id === id);
        this._modelBtn.label = `🧠 Modello: ${m ? m.label : (id || 'predefinito')} ▾`;
        for (const [mid, b] of Object.entries(this._modelChoices)) {
            if (mid === id)
                b.add_style_class_name('bit-model-selected');
            else
                b.remove_style_class_name('bit-model-selected');
        }
    }

    _addHint(text) {
        const l = new St.Label({text, style_class: 'bit-hint', x_expand: true});
        l.clutter_text.line_wrap = true;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._chat.add_child(l);
        this._scrollToBottom();
        return l;
    }

    _addBubble(kind, text, save = true) {
        const label = new St.Label({x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const btn = new St.Button({
            style_class: `bit-bubble bit-bubble-${kind}`, child: label, x_expand: true,
            reactive: kind !== 'user', can_focus: false,
        });
        btn._raw = '';
        btn._label = label;
        btn.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, btn._raw);
            this._setStatus('Copiato negli appunti ✓');
        });
        this._chat.add_child(btn);
        this._setBubbleText(btn, text);
        if (save) {
            btn._msg = {kind, text};
            this._messages.push(btn._msg);
            this._saveChat();
        }
        return btn;
    }

    _setBubbleText(btn, text) {
        const shown = stripActions(text);
        btn._raw = shown;
        try {
            btn._label.clutter_text.set_markup(mdToMarkup(shown));
        } catch (_e) {
            btn._label.text = shown;
        }
        if (btn._msg)
            btn._msg.text = text;
        this._scrollToBottom();
    }

    _addOpenButtons(paths) {
        if (!paths?.length)
            return;
        const row = new St.BoxLayout({style_class: 'bit-open-row', x_expand: true});
        for (const p of paths) {
            const isDir = GLib.file_test(p, GLib.FileTest.IS_DIR);
            const name = GLib.path_get_basename(p);
            const b = new St.Button({
                label: `${isDir ? '📂' : '📄'} ${name.length > 22 ? `${name.slice(0, 21)}…` : name}`,
                style_class: 'button bit-open', can_focus: true,
            });
            b.connect('clicked', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(p).get_uri(),
                        global.create_app_launch_context(0, -1));
                    this.menu.close();
                } catch (e) {
                    this._setStatus(`Non riesco ad aprirlo: ${e.message}`);
                }
            });
            row.add_child(b);
        }
        this._chat.add_child(row);
        this._scrollToBottom();
    }

    _scrollToBottom() {
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const adj = this._scroll?.vadjustment;
            if (adj)
                adj.value = adj.upper - adj.page_size;
            return GLib.SOURCE_REMOVE;
        });
    }

    _setStatus(text) {
        this._statusText = text;
        if (this._status && !this._hoverApp)
            this._status.text = text;
    }

    // ---------- il robottino grande nella Dynamic Island ----------
    _mirrorSprite() {
        if (!this._bigSprite)
            return;
        const room = Math.max(0, this._bigStage.width - BIG_SPRITE);
        const frac = this._sprite.translation_x / Math.max(1, this._stageW - SPRITE);
        this._bigSprite.translation_x = frac * room;
        this._bigSprite.translation_y = 3 + this._sprite.translation_y * (BIG_SPRITE / SPRITE);
        this._bigSprite.scale_x = this._sprite.scale_x;
    }

    // colore della barra -> colore della Dynamic Island
    _syncIslandColor() {
        try {
            const node = Main.panel.get_theme_node();
            const bg = node.get_background_color();
            const fg = node.get_foreground_color();
            // se la barra è trasparente, l'isola resta comunque leggibile
            const a = bg.alpha < 128 ? 1 : bg.alpha / 255;
            const bgCss = bg.alpha < 10 ? 'rgb(0,0,0)' : `rgba(${bg.red},${bg.green},${bg.blue},${a.toFixed(3)})`;
            this.menu.box.style = `background-color: ${bgCss}; color: rgb(${fg.red},${fg.green},${fg.blue});`;
        } catch (e) {
            // la barra non ha ancora uno stile: riproviamo alla prossima apertura
        }
    }

    // ---------- app recenti ----------
    _setupRecentApps() {
        this._recentIds = [];
        try {
            const [ok, bytes] = GLib.file_get_contents(RECENT_FILE);
            if (ok) {
                const list = JSON.parse(new TextDecoder().decode(bytes));
                if (Array.isArray(list))
                    this._recentIds = list.filter(x => typeof x === 'string');
            }
        } catch (_e) {}

        // ogni volta che passi a un'app, la mette in cima alla lista
        const tracker = Shell.WindowTracker.get_default();
        this._focusAppId = tracker.connect('notify::focus-app', () => {
            const app = tracker.focus_app;
            if (!app || app.is_window_backed())
                return;
            const id = app.get_id();
            if (!id || this._recentIds[0] === id)
                return;
            this._recentIds = [id, ...this._recentIds.filter(x => x !== id)].slice(0, 20);
            this._saveRecentSoon();
        });
    }

    _saveRecentSoon() {
        if (this._recentSaveId)
            return;
        this._recentSaveId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._recentSaveId = 0;
            try {
                GLib.mkdir_with_parents(DATA_DIR, 0o700);
                GLib.file_set_contents(RECENT_FILE, JSON.stringify(this._recentIds));
            } catch (_e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    _recentApps() {
        const appSys = Shell.AppSystem.get_default();
        const out = [];
        const seen = new Set();
        const add = app => {
            if (!app || out.length >= MAX_APPS)
                return;
            const id = app.get_id();
            if (seen.has(id) || (app.get_app_info && !app.get_app_info()?.should_show()))
                return;
            seen.add(id);
            out.push(app);
        };
        for (const id of this._recentIds)
            add(appSys.lookup_app(id));
        // se la lista è corta, la completa con le app che usi di più
        for (const app of Shell.AppUsage.get_default().get_most_used())
            add(app);
        return out;
    }

    _refreshRecentApps() {
        if (!this._appsRow)
            return;
        this._appsRow.destroy_all_children();
        this._hoverApp = null;
        for (const app of this._recentApps()) {
            const btn = new St.Button({
                style_class: 'bit-app', can_focus: true, reactive: true,
                child: app.create_icon_texture(32),
            });
            btn.connect('notify::hover', () => {
                if (btn.hover) {
                    this._hoverApp = app;
                    this._status.text = app.get_name();
                    this._walkToApp(btn);
                } else if (this._hoverApp === app) {
                    this._hoverApp = null;
                    this._status.text = this._statusText ?? '';
                }
            });
            btn.connect('clicked', () => {
                this._hoverApp = null;
                this.menu.close();
                app.activate();
            });
            this._appsRow.add_child(btn);
        }
    }

    // passando sopra un'icona, il robottino ci corre sotto e la indica
    _walkToApp(btn) {
        if (this._mode !== 'idle' || !this._bigStage.width)
            return;
        const [sx] = this._bigStage.get_transformed_position();
        const [bx] = btn.get_transformed_position();
        const room = Math.max(1, this._bigStage.width - BIG_SPRITE);
        const target = bx + btn.width / 2 - sx - BIG_SPRITE / 2;
        const barX = Math.max(0, Math.min(1, target / room)) * (this._stageW - SPRITE);
        this._clearTimers();
        this._walkTo(barX, 90, () => {
            this._setPose('wave');
            this._after(rand(2500, 4000), () => {
                this._setPose('stand');
                this._idleLoop();
            });
        });
    }

    // ---------- memoria della chat ----------
    _saveChat() {
        try {
            GLib.mkdir_with_parents(DATA_DIR, 0o700);
            const data = JSON.stringify({
                sessionId: this._sessionId,
                promptVersion: PROMPT_VERSION,
                messages: this._messages.slice(-MAX_SAVED),
            });
            GLib.file_set_contents(CHAT_FILE, data);
        } catch (e) {
            console.warn(`Aninux: impossibile salvare la chat: ${e.message}`);
        }
    }

    _loadChat() {
        try {
            const [ok, bytes] = GLib.file_get_contents(CHAT_FILE);
            if (ok) {
                const data = JSON.parse(new TextDecoder().decode(bytes));
                this._sessionId = data.sessionId ?? null;
                for (const m of data.messages ?? []) {
                    const btn = this._addBubble(m.kind, m.text, false);
                    btn._msg = m;
                    this._messages.push(m);
                    if (m.paths)
                        this._addOpenButtons(m.paths.filter(p => GLib.file_test(p, GLib.FileTest.EXISTS)));
                }
                if (this._sessionId && data.promptVersion !== PROMPT_VERSION) {
                    this._sessionId = null;
                    this._addHint('✨ Ho imparato cose nuove! Da qui riparto con la memoria fresca.');
                }
            }
        } catch (_e) {}
        if (!this._messages.length)
            this._addHint('Chiedimi di trovare un file o di leggerne il contenuto.\nEsempio: "dov\'è il PDF della bolletta di ottobre?"');
    }

    // ---------- Claude ----------
    _newChat() {
        this._stop(false);
        this._shutUp();
        if (this._listening)
            this._voiceSend({cmd: 'annulla'});
        this._sessionId = null;
        this._messages = [];
        this._saveChat();
        this._chat.destroy_all_children();
        this._addHint('Nuova chat. Cosa cerchiamo?');
        this._setMode('idle');
        global.stage.set_key_focus(this._entry.clutter_text);
    }

    // spoken: testo riconosciuto dal microfono (altrimenti si usa quello scritto)
    _send(spoken = null) {
        let q = (spoken ?? this._entry.text).trim();
        if (!q || this._proc)
            return;
        this._poke();
        this._shutUp();
        if (this._listening && spoken === null)
            this._voiceSend({cmd: 'annulla'});
        const model = this._settings.get_string('model');
        const local = isLocal(model);
        const claude = local ? null : findClaude(this._settings.get_string('claude-path'));
        if (!local && !claude) {
            this._addBubble('error', this._settings.get_string('claude-path').trim()
                ? 'Non trovo il programma "claude" nel percorso scelto. Controllalo nelle impostazioni (⚙).'
                : 'Non trovo il programma "claude" (Claude Code). È installato? Puoi indicarlo nelle impostazioni (⚙).');
            this._setMode('error');
            return;
        }
        this._voiceQuestion = spoken !== null;
        if (this._voiceQuestion)
            q = `${MIC} ${q}`;
        else
            this._entry.text = '';
        this._addBubble('user', q);

        // "ricordati che…" e simili: risponde subito, con qualsiasi modello
        let mem = null;
        try {
            mem = handleMemory(q);
        } catch (e) {
            mem = `Non riesco a salvare le istruzioni: ${e.message}`;
        }
        if (mem) {
            this._addBubble('bot', mem);
            this._setMode('happy');
            const vmode = this._settings.get_string('voice-replies');
            if (vmode === 'sempre' || (vmode === 'voce' && this._voiceQuestion))
                this._speak(speechText(mem));
            return;
        }

        // ponte dei permessi: ogni modifica o comando passa da "Accetta / Rifiuta"
        const bridge = this._ext.dir.get_child('permission-bridge.py').get_path();
        const python = GLib.find_program_in_path('python3') ?? '/usr/bin/python3';
        const mcp = JSON.stringify({mcpServers: {aninux: {command: python, args: ['-I', bridge]}}});

        // Claude e Qwen non condividono la memoria: ognuno ha le sue sessioni
        if (this._sessionId && this._sessionId.startsWith('qwen-') !== local)
            this._sessionId = null;

        const argv = local ? [python, '-I', this._ext.dir.get_child('qwen-agent.py').get_path(),
            '--domanda', q, '--nome', this._botName(), '--sessione', this._sessionId ?? ''] : [claude, '-p', q,
            '--output-format', 'stream-json', '--verbose',
            '--tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash',
            '--add-dir', '/',
            '--permission-mode', 'default',
            '--mcp-config', mcp, '--strict-mcp-config',
            '--permission-prompt-tool', 'mcp__aninux__approva',
            '--disallowedTools', ...DENIED,
            '--append-system-prompt', buildSystemPrompt(this._botName())];
        if (!local && model)
            argv.push('--model', model);
        if (!local && this._sessionId)
            argv.push('--resume', this._sessionId);

        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE |
                       Gio.SubprocessFlags.STDIN_PIPE,
            });
            launcher.set_cwd(HOME);
            // profilo (account) di Claude Code scelto nelle impostazioni
            const profile = expandHome(this._settings.get_string('claude-config-dir'));
            if (profile)
                launcher.setenv('CLAUDE_CONFIG_DIR', profile, true);
            this._proc = launcher.spawnv(argv);
            this._proc.get_stdin_pipe().close(null);
        } catch (e) {
            this._proc = null;
            this._addBubble('error', `Non riesco ad avviare ${local ? 'Qwen' : 'Claude'}: ${e.message}`);
            this._setMode('error');
            return;
        }

        this._cancellable = new Gio.Cancellable();
        this._reply = null;
        this._replyText = '';
        this._rawErr = '';
        this._gotResult = false;
        this._failed = false;
        this._stopBtn.visible = true;
        this._setMode('dance');
        this._setStatus(local ? 'Ci penso (Qwen, sul computer)…' : 'Ci penso…');

        const stream = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(), close_base_stream: true,
        });
        this._readLine(stream, this._proc, this._cancellable);
    }

    _readLine(stream, proc, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (_e) {
                return; // annullato
            }
            if (proc !== this._proc)
                return;
            if (line === null) {
                this._finish(proc);
                return;
            }
            this._handleLine(line);
            this._readLine(stream, proc, cancellable);
        });
    }

    _handleLine(line) {
        let ev;
        try {
            ev = JSON.parse(line);
        } catch (_e) {
            if (line.trim())
                this._rawErr += `${line}\n`;
            return;
        }
        if (ev.session_id && ev.session_id !== this._sessionId) {
            this._sessionId = ev.session_id;
            this._saveChat();
        }

        if (ev.type === 'aninux_partial') {
            // Qwen scrive la risposta un pezzo alla volta
            const t = String(ev.text ?? '').trim();
            if (!t)
                return;
            const shown = this._replyText ? `${this._replyText}\n\n${t}` : t;
            if (!this._reply)
                this._reply = this._addBubble('bot', shown);
            else
                this._setBubbleText(this._reply, shown);
            return;
        }
        if (ev.type === 'assistant' && ev.message?.content) {
            for (const c of ev.message.content) {
                if (c.type === 'text' && c.text?.trim()) {
                    this._replyText = this._replyText ? `${this._replyText}\n\n${c.text.trim()}` : c.text.trim();
                    if (!this._reply)
                        this._reply = this._addBubble('bot', this._replyText);
                    else
                        this._setBubbleText(this._reply, this._replyText);
                } else if (c.type === 'tool_use') {
                    this._setStatus(this._describeTool(c.name, c.input ?? {}));
                }
            }
        } else if (ev.type === 'result') {
            this._gotResult = true;
            if (ev.is_error) {
                this._failed = true;
                this._addBubble('error', `Qualcosa è andato storto: ${ev.result || ev.subtype || 'errore sconosciuto'}`);
            } else if (!this._reply && ev.result) {
                this._replyText = ev.result;
                this._reply = this._addBubble('bot', ev.result);
            }
        }
    }

    _describeTool(name, input) {
        switch (name) {
        case 'Read': return `Leggo ${shortPath(input.file_path)}…`;
        case 'Grep': return `Cerco "${input.pattern ?? ''}" ${input.path ? `in ${shortPath(input.path)}` : ''}…`;
        case 'Glob': return `Cerco file ${input.pattern ?? ''} ${input.path ? `in ${shortPath(input.path)}` : ''}…`;
        case 'Bash': return `Comando: ${clip(input.description || input.command, 60)}`;
        case 'Write': return `Scrivo ${shortPath(input.file_path)}…`;
        case 'Edit': return `Modifico ${shortPath(input.file_path)}…`;
        default: return `Sto lavorando (${name})…`;
        }
    }

    // ---------- permessi: "Accetta / Rifiuta" ----------
    // Chiamato via D-Bus dal ponte dei permessi; risponde quando premi un pulsante.
    ask(tool, inputJson, invocation) {
        let input = {};
        try {
            input = JSON.parse(inputJson);
        } catch (_e) {}

        let answered = false;
        const req = {};
        const reply = allow => {
            if (answered)
                return;
            answered = true;
            this._pending.delete(req);
            try {
                invocation.return_value(new GLib.Variant('(b)', [allow]));
            } catch (_e) {}
        };
        req.reply = reply;

        // se Claude non sta lavorando per noi, rifiuta
        if (!this._proc) {
            reply(false);
            return;
        }
        this._pending.add(req);

        const {title, body} = describeRequest(tool, input);
        const card = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, style_class: 'bit-ask', x_expand: true,
        });
        const t = new St.Label({text: `🔐 ${title}`, style_class: 'bit-ask-title', x_expand: true});
        t.clutter_text.line_wrap = true;
        t.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        card.add_child(t);
        if (body) {
            const b = new St.Label({text: body, style_class: 'bit-ask-body', x_expand: true});
            b.clutter_text.line_wrap = true;
            b.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            b.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            card.add_child(b);
        }
        const row = new St.BoxLayout({style_class: 'bit-ask-buttons', x_align: Clutter.ActorAlign.END});
        const no = new St.Button({label: '❌ Rifiuta', style_class: 'button bit-button', can_focus: true});
        const yes = new St.Button({label: '✅ Accetta', style_class: 'button bit-button bit-accept', can_focus: true});
        row.add_child(no);
        row.add_child(yes);
        card.add_child(row);
        this._chat.add_child(card);
        this._scrollToBottom();

        const decide = allow => {
            const wasAnswered = answered;
            reply(allow);
            row.destroy_all_children();
            row.add_child(new St.Label({
                text: wasAnswered ? 'Tempo scaduto' : allow ? 'Accettato ✓' : 'Rifiutato ✗',
                style_class: 'bit-hint',
            }));
            if (this._proc && this._mode === 'ask')
                this._setMode('thinking');
            global.stage.set_key_focus(this._entry.clutter_text);
        };
        yes.connect('clicked', () => decide(true));
        no.connect('clicked', () => decide(false));
        req.card = row;

        this._setMode('ask');
        if (this.menu.isOpen) {
            global.stage.set_key_focus(yes);
        } else {
            Main.notify(`${this._botName()} chiede il permesso`, title);
        }
    }

    _denyAllPending() {
        for (const req of [...this._pending]) {
            req.reply(false);
            req.card?.destroy_all_children();
            req.card?.add_child(new St.Label({text: 'Annullato', style_class: 'bit-hint'}));
        }
        this._pending.clear();
    }

    _finish(proc) {
        proc.wait_async(null, () => {
            if (proc !== this._proc)
                return;
            this._proc = null;
            this._cancellable = null;
            this._stopBtn.visible = false;
            this._denyAllPending();
            if (!this._gotResult || this._failed) {
                if (!this._gotResult) {
                    const err = this._rawErr.trim() || 'Claude si è chiuso senza rispondere.';
                    this._addBubble('error', `Errore: ${err.slice(0, 600)}`);
                }
                this._setMode('error');
                this._setStatus('Errore');
                return;
            }

            const paths = extractPaths(stripActions(this._replyText));
            if (paths.length && this._reply?._msg) {
                this._reply._msg.paths = paths;
                this._addOpenButtons(paths);
            }

            // azioni: aprire app, siti, ricerche
            let opened = false;
            for (const a of parseActions(this._replyText)) {
                try {
                    this._addHint(`▶ ${runAction(a)}`);
                    opened = true;
                } catch (e) {
                    this._addHint(`⚠ Non ci sono riuscito: ${e.message}`);
                }
            }
            this._saveChat();

            // a voce: sempre, o solo se la domanda era a voce
            const vmode = this._settings.get_string('voice-replies');
            const speak = vmode === 'sempre' || (vmode === 'voce' && this._voiceQuestion);
            const spoken = speak ? speechText(this._replyText || '') : '';

            if (opened) {
                // ha aperto qualcosa: si chiude per lasciarti l'app davanti, e festeggia
                this.menu.close();
                this._setMode('happy');
                this._afterSpeak = 'idle';
            } else if (this.menu.isOpen || (spoken && this._voiceQuestion)) {
                // se gli hai parlato, la risposta la senti: niente notifica
                this._setMode('happy');
                this._afterSpeak = 'idle';
            } else {
                this._setMode('alert');
                this._afterSpeak = 'alert';
                const preview = stripActions(this._replyText || '').replace(/\s+/g, ' ').slice(0, 140);
                Main.notify(`${this._botName()} ha la risposta`, preview || 'Aprimi per leggerla.');
            }
            if (spoken)
                this._speak(spoken);
            if (!this._copyHintShown) {
                this._copyHintShown = true;
                this._addHint('Clic su una risposta per copiarla.');
            }
        });
    }

    _stop(showMsg) {
        this._denyAllPending();
        if (!this._proc)
            return;
        const p = this._proc;
        this._proc = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        try {
            p.force_exit();
        } catch (_e) {}
        this._stopBtn.visible = false;
        this._saveChat();
        if (showMsg) {
            this._addHint('Fermato.');
            this._setMode('idle');
        }
    }

    // ---------- voce: parlare e ascoltare ----------
    // Avvia (se serve) il servizio voce. Restituisce false se la voce non è installata.
    _voiceEnsure(complain = true) {
        if (this._voice)
            return true;
        if (!GLib.file_test(VOICE_PYTHON, GLib.FileTest.IS_EXECUTABLE)) {
            if (complain) {
                const script = this._ext.dir.get_child('installa-voce.sh').get_path();
                this._addBubble('error', `La voce non è ancora installata. Apri un terminale ed esegui:\n\`bash ${script}\``, false);
            }
            return false;
        }
        try {
            const proc = Gio.Subprocess.new(
                [VOICE_PYTHON, '-I', '-u', this._ext.dir.get_child('voce.py').get_path()],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            const voice = {proc, stdin: proc.get_stdin_pipe(), cancellable: new Gio.Cancellable()};
            this._voice = voice;
            const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
            this._readVoice(stream, voice);
            proc.wait_async(null, () => {
                if (this._voice !== voice)
                    return;
                // il servizio si è chiuso (crash?): si ripartirà alla prossima richiesta
                this._voice = null;
                this._voiceGone();
            });
            return true;
        } catch (e) {
            if (complain)
                this._addBubble('error', `Non riesco ad avviare la voce: ${e.message}`, false);
            return false;
        }
    }

    _readVoice(stream, voice) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, voice.cancellable, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (_e) {
                return;
            }
            if (line === null || this._voice !== voice)
                return;
            let ev = null;
            try {
                ev = JSON.parse(line);
            } catch (_e) {
                if (line.trim())
                    console.debug(`Aninux voce: ${line}`);
            }
            if (ev)
                this._onVoiceEvent(ev);
            this._readVoice(stream, voice);
        });
    }

    _voiceSend(obj) {
        if (!this._voice)
            return;
        try {
            const bytes = new TextEncoder().encode(`${JSON.stringify(obj)}\n`);
            this._voice.stdin.write_all(bytes, null);
        } catch (e) {
            console.warn(`Aninux: voce non raggiungibile: ${e.message}`);
        }
    }

    _onVoiceEvent(ev) {
        switch (ev.ev) {
        case 'ascolto':
            this._listening = true;
            this._setMicActive(true);
            this._setMode('listening');
            break;
        case 'livello':
            this._onVoiceLevel(ev.v ?? 0);
            break;
        case 'trascrivo':
            this._listening = false;
            this._setMicActive(false);
            this._setMode('thinking');
            this._setStatus('✍️ Trascrivo quello che hai detto…');
            break;
        case 'testo':
            this._listening = false;
            this._setMicActive(false);
            if (ev.testo?.trim()) {
                this._send(ev.testo);
            } else {
                this._setMode('idle');
                this._setStatus('Non ho sentito niente 🤔 Riprova!');
            }
            break;
        case 'annullato':
            this._listening = false;
            this._setMicActive(false);
            this._setMode('idle');
            this._setStatus('Ok, non ascolto più');
            break;
        case 'parla_inizio':
            this._speaking = true;
            this._stopBtn.visible = true;
            if (!this._proc && !this._listening)
                this._setMode('speaking');
            break;
        case 'parla_fine':
            this._speaking = false;
            if (!this._proc)
                this._stopBtn.visible = false;
            if (this._mode === 'speaking')
                this._setMode(this._afterSpeak);
            break;
        case 'errore':
            console.warn(`Aninux voce: ${ev.msg}`);
            if (this._listening || /microfono|trascrizione/.test(ev.msg ?? '')) {
                this._listening = false;
                this._setMicActive(false);
                this._addBubble('error', `Problema con il microfono: ${ev.msg}`, false);
                this._setMode('error');
            } else {
                this._addHint(`⚠ Non riesco a parlare: ${ev.msg}`);
            }
            break;
        }
    }

    _onVoiceLevel(v) {
        if (this._mode !== 'listening')
            return;
        // più forte parli, più saltella e sorride
        this._setExpr(v > 0.35 ? 'happy' : 'alert');
        this._setPose(v > 0.6 ? 'wave' : 'stand');
        this._sprite.translation_y = -Math.round(v * 3);
    }

    _voiceGone() {
        const wasListening = this._listening;
        this._listening = false;
        this._speaking = false;
        this._setMicActive(false);
        if (!this._proc)
            this._stopBtn.visible = false;
        if (wasListening || this._mode === 'listening' || this._mode === 'speaking') {
            this._addBubble('error', 'La voce si è interrotta. Riprova: la riavvio da sola.', false);
            this._setMode('error');
        }
    }

    _setMicActive(on) {
        this._micIcon.icon_name = on ? 'media-playback-stop-symbolic' : 'audio-input-microphone-symbolic';
        if (on)
            this._micIcon.add_style_class_name('bit-mic-on');
        else
            this._micIcon.remove_style_class_name('bit-mic-on');
    }

    // clic sul microfono (o scorciatoia): inizia ad ascoltare, o finisce se sta già ascoltando
    _toggleListen() {
        this._poke();
        if (this._listening) {
            this._voiceSend({cmd: 'basta'});
            return;
        }
        if (this._proc) {
            this._setStatus('Aspetta che finisca di rispondere (o premi Esc)');
            return;
        }
        if (!this._voiceEnsure(true))
            return;
        this._speaking = false;
        this._voiceSend({cmd: 'ascolta'});
        // risposta immediata, prima ancora che il microfono sia aperto
        this._listening = true;
        this._setMicActive(true);
        this._setMode('listening');
    }

    _speak(text) {
        if (!text || !this._voiceEnsure(false))
            return;
        this._voiceSend({cmd: 'parla', testo: text});
    }

    _shutUp() {
        if (this._speaking)
            this._voiceSend({cmd: 'zitto'});
    }

    _voiceQuit() {
        const v = this._voice;
        this._voice = null;
        if (!v)
            return;
        v.cancellable.cancel();
        try {
            v.stdin.close(null); // il servizio si chiude da solo quando stdin si chiude
        } catch (_e) {}
        // se dopo 2 secondi è ancora vivo, lo chiude a forza
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            try {
                v.proc.force_exit();
            } catch (_e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._preloadId) {
            GLib.source_remove(this._preloadId);
            this._preloadId = 0;
        }
        if (this._panelStyleId) {
            Main.panel.disconnect(this._panelStyleId);
            this._panelStyleId = 0;
        }
        if (this._focusAppId) {
            Shell.WindowTracker.get_default().disconnect(this._focusAppId);
            this._focusAppId = 0;
        }
        if (this._recentSaveId) {
            GLib.source_remove(this._recentSaveId);
            this._recentSaveId = 0;
            try {
                GLib.file_set_contents(RECENT_FILE, JSON.stringify(this._recentIds));
            } catch (_e) {}
        }
        this._stop(false);
        this._voiceQuit();
        if (this._voiceSettingsId) {
            this._settings.disconnect(this._voiceSettingsId);
            this._voiceSettingsId = 0;
        }
        for (const key of ['_settingsId', '_nameSettingsId', '_profileSettingsId']) {
            if (this[key]) {
                this._settings.disconnect(this[key]);
                this[key] = 0;
            }
        }
        if (this._blinkId) {
            GLib.source_remove(this._blinkId);
            this._blinkId = 0;
        }
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        super.destroy();
    }
});

export default class AninuxExtension extends Extension {
    enable() {
        this._indicator = new AninuxIndicator(this);

        // canale con cui il ponte dei permessi chiede "Accetta / Rifiuta"
        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE, {
            AskAsync: ([tool, input], invocation) => {
                if (this._indicator)
                    this._indicator.ask(tool, input, invocation);
                else
                    invocation.return_value(new GLib.Variant('(b)', [false]));
            },
        });
        this._dbus.export(Gio.DBus.session, DBUS_PATH);
        // nella zona centrale, subito prima dell'orologio (e del meteo che sta con lui)
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');

        // spazio invisibile largo quanto Aninux a destra dell'orologio,
        // così orologio e meteo restano centrati nella barra
        this._spacer = new St.Widget({reactive: false});
        const centerBox = Main.panel._centerBox;
        const dateBtn = Main.panel.statusArea.dateMenu?.container;
        const idx = dateBtn ? centerBox.get_children().indexOf(dateBtn) + 1 : -1;
        centerBox.insert_child_at_index(this._spacer, idx);
        const sync = () => {
            if (this._spacer)
                this._spacer.width = this._indicator.container.width;
        };
        this._widthId = this._indicator.container.connect('notify::width', sync);
        sync();

        this._hostSetup();

        Main.wm.addKeybinding('open-assistant', this.getSettings(),
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._indicator?.menu.toggle());

        // scorciatoia per parlargli subito: apre il riquadro e accende il microfono
        Main.wm.addKeybinding('listen-assistant', this.getSettings(),
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                const ind = this._indicator;
                if (!ind)
                    return;
                if (!ind.menu.isOpen)
                    ind.menu.open();
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._indicator?._toggleListen();
                    return GLib.SOURCE_REMOVE;
                });
            });
    }

    // ---------- accanto al notch (barra nascosta) ----------
    // Se NotchNux nasconde la barra, il robottino esce dalla barra e va in una
    // pillola nera attaccata al lato destro del notch; se la barra torna, rientra.
    _hostSetup() {
        const panelBox = Main.layoutManager.panelBox;
        this._panelVisId = panelBox.connect('notify::visible', () => this._hostUpdate());
        this._hostTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._hostUpdate();   // il notch nasce un attimo dopo di noi e può spostarsi
            return GLib.SOURCE_CONTINUE;
        });
        this._hostUpdate();
    }

    _findNotch() {
        return Main.layoutManager.uiGroup.get_children()
            .flatMap(c => [c, ...(c.get_children?.() ?? [])])
            .find(a => a.constructor?.$gtype?.name?.includes('NotchNux'));
    }

    // il robottino diventa una zona dentro la pillola del notch (a sinistra dell'orologio)
    _hostUpdate() {
        const ind = this._indicator;
        if (!ind)
            return;
        const hidden = !Main.layoutManager.panelBox.visible;
        const notch = hidden ? this._findNotch() : null;
        if (hidden && notch?._pill && !this._notch) {
            this._notch = notch;
            this._spacer?.hide();
            const box = ind.container;
            box.get_parent()?.remove_child(box);
            notch._pill.insert_child_at_index(box, 0);
            ind._hosted = true;
            ind._pill.add_style_class_name('aninux-pill-hosted');
            ind._setStageWidth(NOTCH_STAGE_W);
            // la pillola del notch deve fare posto al robottino
            const orig = notch._pillWidth;
            notch._pillWidth = function () {
                return orig.call(this) + box.get_preferred_width(-1)[1] + 10;
            };
            notch._aninuxOrigPillWidth = orig;
            // il notch si nasconde con le app a schermo intero (lo fa NotchNux):
            // mentre il menu del robottino è aperto deve restare visibile
            notch._externalHold = () => !!this._indicator?.menu.isOpen;
            notch._applyPillWidth?.();
            this._hostIds = [box.connect('notify::width', () => this._notch?._applyPillWidth?.())];
        } else if (this._notch && (!hidden || !notch)) {
            this._hostRelease();
        }
    }

    _hostRelease() {
        const notch = this._notch;
        if (!notch)
            return;
        const ind = this._indicator;
        const box = ind?.container;
        for (const id of this._hostIds ?? [])
            try { box.disconnect(id); } catch (_e) {}
        this._hostIds = null;
        delete notch._externalHold;
        if (notch._aninuxOrigPillWidth) {
            notch._pillWidth = notch._aninuxOrigPillWidth;
            delete notch._aninuxOrigPillWidth;
        }
        if (ind && box) {
            box.get_parent()?.remove_child(box);
            Main.panel._centerBox.insert_child_at_index(box, 0);
            ind._hosted = false;
            ind._pill?.remove_style_class_name('aninux-pill-hosted');
            ind._setStageWidth(STAGE_W);
            this._spacer?.show();
        }
        try { notch._applyPillWidth?.(); } catch (_e) {}
        this._notch = null;
    }

    disable() {
        if (this._hostTimer) {
            GLib.source_remove(this._hostTimer);
            this._hostTimer = 0;
        }
        if (this._panelVisId) {
            Main.layoutManager.panelBox.disconnect(this._panelVisId);
            this._panelVisId = 0;
        }
        this._hostRelease();
        Main.wm.removeKeybinding('open-assistant');
        Main.wm.removeKeybinding('listen-assistant');
        this._dbus?.unexport();
        this._dbus = null;
        if (this._widthId) {
            this._indicator?.container.disconnect(this._widthId);
            this._widthId = 0;
        }
        this._spacer?.destroy();
        this._spacer = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
