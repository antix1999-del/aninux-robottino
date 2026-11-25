#!/usr/bin/env python3
"""Cervello locale di Aninux: Qwen tramite Ollama.

Riceve una domanda, la manda a Qwen (Ollama, http://127.0.0.1:11434) con alcuni
strumenti (cercare e leggere file, aprire app, eseguire comandi) e scrive su stdout
gli stessi eventi JSON di `claude -p --output-format stream-json`, così l'estensione
li mostra come fa con Claude.

Comandi e scritture passano dallo stesso "Accetta / Rifiuta" di Claude (D-Bus).
La conversazione si salva in ~/.local/share/aninux-robottino/qwen/<sessione>.json.
"""
import argparse
import datetime
import difflib
import re
import unicodedata
import fnmatch
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

OLLAMA = os.environ.get('ANINUX_OLLAMA', 'http://127.0.0.1:11434')
MODEL = os.environ.get('ANINUX_QWEN_MODEL', 'qwen3:4b-instruct')
HOME = os.path.expanduser('~')
DATA_DIR = os.path.join(os.environ.get('XDG_DATA_HOME', os.path.join(HOME, '.local', 'share')), 'aninux-robottino')
SESS_DIR = os.path.join(DATA_DIR, 'qwen')
KEEP_MESSAGES = 16      # messaggi ricordati tra una domanda e l'altra
MAX_ROUNDS = 6          # giri di strumenti per domanda
TOOL_OUT = 2500         # caratteri massimi del risultato di uno strumento
NUM_CTX = 4096          # contesto: più grande = più RAM (6144 occupava 3,6 GB)

SECRETS = [os.path.join(HOME, p) for p in ('.ssh', '.gnupg', '.local/share/keyrings', '.claude/.credentials.json')]
SECRETS += ['/etc/shadow', '/etc/gshadow']

MIC = '\U0001F3A4'


# ---------- uscita nello stesso formato di Claude Code ----------
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def emit_text(text):
    emit({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': text}]}})


def emit_tool(name, inp):
    emit({'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'name': name, 'input': inp}]}})


def emit_result(session, text='', error=None):
    emit({'type': 'result', 'is_error': bool(error), 'result': error or text,
          'subtype': 'error' if error else 'success', 'session_id': session})


# ---------- permessi (stesso canale del ponte di Claude) ----------
def ask(tool, tool_input):
    try:
        import gi
        gi.require_version('Gio', '2.0')
        from gi.repository import Gio, GLib
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        res = bus.call_sync(
            'org.gnome.Shell', '/org/gnome/Shell/Extensions/Aninux',
            'org.gnome.Shell.Extensions.Aninux', 'Ask',
            GLib.Variant('(ss)', (tool, json.dumps(tool_input, ensure_ascii=False))),
            GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, 15 * 60 * 1000, None)
        return bool(res.unpack()[0])
    except Exception as e:
        sys.stderr.write(f'aninux qwen: permesso non chiesto: {e}\n')
        return False


DENIED = "L'utente ha rifiutato. Non riprovare in un altro modo: chiedi all'utente come preferisce procedere."


# ---------- strumenti ----------
APPS = []     # app trovate dalla ricerca automatica per questa domanda
RESULTS = []  # file trovati dalla ricerca automatica, numerati da 1: Qwen può dire "1" invece del percorso


def simple(p):
    return re.sub(r'[\W_]+', '', unicodedata.normalize('NFKD', p.lower()))


def repair(p):
    """Qwen a volte ricopia male i percorsi (salta emoji e simboli): cerca quello vero più simile."""
    if os.path.exists(p) or not RESULTS:
        return p
    sp = simple(p)
    for r in RESULTS:
        if simple(r) == sp:
            return r
    best, score = p, 0.0
    for r in RESULTS:
        sc = difflib.SequenceMatcher(None, sp, simple(r)).ratio()
        if sc > score:
            best, score = r, sc
    return best if score >= 0.85 else p


def full(p):
    p = str(p or '').strip().strip('`"\'') or HOME
    m = re.fullmatch(r'\[?#?(\d{1,2})\]?', p)
    if m and 1 <= int(m.group(1)) <= len(RESULTS):
        return RESULTS[int(m.group(1)) - 1]
    if p == '~' or p.startswith('~/'):
        p = HOME + p[1:]
    if not p.startswith('/'):
        p = os.path.join(HOME, p)
    return repair(os.path.realpath(p))


def secret(p):
    return any(p == s or p.startswith(s + '/') for s in SECRETS)


def clip(s, n=TOOL_OUT):
    s = s or ''
    return s if len(s) <= n else s[:n] + f'\n… (tagliato, {len(s) - n} caratteri in più)'


def human_size(n):
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024:
            return f'{n:.0f} {u}'
        n /= 1024
    return f'{n:.1f} TB'


def t_cerca_file(nome='', cartella='', giorni=None, **_):
    base = full(cartella)
    if not os.path.isdir(base):
        return f'La cartella {base} non esiste.'
    pat = (nome or '*').strip()
    if '*' not in pat and '?' not in pat:
        pat = f'*{pat}*'
    cmd = ['find', base, '-xdev', '(', '-name', '.*', '-prune', ')', '-o', '-iname', pat]
    try:
        g = int(giorni) if giorni not in (None, '') else None
    except (TypeError, ValueError):
        g = None
    if g:
        cmd += ['-mtime', f'-{g}']
    cmd += ['-print']
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b'').decode(errors='replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
    paths = [p for p in out.splitlines() if p and not secret(p)]
    if not paths:
        return f'Nessun file "{pat}" trovato in {base}' + (f' negli ultimi {g} giorni.' if g else '.')
    paths.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0, reverse=True)
    lines = []
    for p in paths[:25]:
        try:
            st = os.stat(p)
            when = datetime.datetime.fromtimestamp(st.st_mtime).strftime('%d/%m/%Y %H:%M')
            kind = 'cartella' if os.path.isdir(p) else human_size(st.st_size)
            lines.append(f'{p}  ({kind}, modificato {when})')
        except OSError:
            lines.append(p)
    more = f'\n… e altri {len(paths) - 25}' if len(paths) > 25 else ''
    return 'Trovati (dal più recente):\n' + '\n'.join(lines) + more


def t_cerca_testo(testo='', cartella='', **_):
    base = full(cartella)
    if not testo.strip():
        return 'Dimmi quale testo cercare.'
    cmd = ['grep', '-rIil', '--exclude-dir=.*', '--', testo, base]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=25).stdout
    except subprocess.TimeoutExpired:
        return 'La ricerca è troppo lunga: indica una cartella più precisa.'
    paths = [p for p in out.splitlines() if p and not secret(p)][:20]
    return ('File che contengono "%s":\n' % testo + '\n'.join(paths)) if paths else f'Nessun file in {base} contiene "{testo}".'


def t_elenca_cartella(percorso='', **_):
    p = full(percorso)
    if secret(p):
        return 'Questa cartella è privata: non la guardo.'
    if not os.path.isdir(p):
        return f'{p} non è una cartella.'
    items = []
    for name in os.listdir(p):
        if name.startswith('.'):
            continue
        fp = os.path.join(p, name)
        try:
            st = os.stat(fp)
        except OSError:
            continue
        items.append((st.st_mtime, name, os.path.isdir(fp), st.st_size))
    items.sort(reverse=True)
    lines = [f"{'📂' if d else '📄'} {n}{'/' if d else ''}  "
             f"({'' if d else human_size(s) + ', '}{datetime.datetime.fromtimestamp(m).strftime('%d/%m/%Y')})"
             for m, n, d, s in items[:60]]
    more = f'\n… e altri {len(items) - 60}' if len(items) > 60 else ''
    return f'Contenuto di {p} (dal più recente):\n' + ('\n'.join(lines) or '(vuota)') + more


def t_leggi_file(percorso='', **_):
    p = full(percorso)
    if secret(p):
        return 'Questo file è privato (chiavi o password): non lo leggo.'
    if os.path.isdir(p):
        return t_elenca_cartella(p)
    if not os.path.isfile(p):
        return f'Il file {p} non esiste.'
    if p.lower().endswith('.pdf'):
        try:
            txt = subprocess.run(['pdftotext', '-l', '5', '-layout', p, '-'], capture_output=True,
                                 text=True, timeout=20).stdout
        except Exception as e:
            return f'Non riesco a leggere il PDF: {e}'
        return clip(txt.strip() or '(PDF senza testo, forse è una scansione)')
    try:
        with open(p, 'rb') as f:
            data = f.read(TOOL_OUT * 4)
    except OSError as e:
        return f'Non riesco a leggerlo: {e}'
    if b'\0' in data[:4000]:
        return f'{p} non è un file di testo ({human_size(os.path.getsize(p))}). Posso aprirlo con l\'azione "apri".'
    return clip(data.decode('utf-8', errors='replace'))


def t_esegui_comando(comando='', descrizione='', **_):
    if not comando.strip():
        return 'Comando vuoto.'
    if not ask('Bash', {'command': comando, 'description': descrizione}):
        return DENIED
    try:
        r = subprocess.run(['bash', '-c', comando], cwd=HOME, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        return 'Il comando ci ha messo troppo (più di 90 secondi) ed è stato fermato.'
    out = (r.stdout + ('\n' + r.stderr if r.stderr.strip() else '')).strip()
    return clip(f'Codice di uscita {r.returncode}\n{out or "(nessun output)"}')


def t_scrivi_file(percorso='', contenuto='', **_):
    p = full(percorso)
    if secret(p):
        return 'Questo file è privato: non lo modifico.'
    if not ask('Write', {'file_path': p, 'content': contenuto}):
        return DENIED
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(contenuto)
    except OSError as e:
        return f'Non ci sono riuscito: {e}'
    return f'Scritto {p}.'


ACTIONS = []  # azioni da far eseguire all'estensione alla fine


def t_azione(tipo='', **kw):
    a = {'tipo': tipo}
    for k in ('nome', 'cerca', 'url', 'percorso', 'pagina', 'comando', 'vault'):
        v = kw.get(k)
        if v not in (None, ''):
            a[k] = v
    if tipo not in ('app', 'web', 'spotify', 'musica', 'obsidian', 'apri'):
        return f'Tipo di azione sconosciuto: {tipo}'
    if len(ACTIONS) >= 3:
        return 'Troppe azioni: massimo 3.'
    if tipo == 'apri':
        a['percorso'] = full(a.get('percorso', ''))
        if not os.path.exists(a['percorso']):
            return f"Non esiste {a['percorso']}: usa il numero di un risultato o cercalo con cerca_file."
    ACTIONS.append(a)
    return 'Fatto: lo apro appena finisci di rispondere. Ora scrivi in una frase cosa stai aprendo.'


TOOLS = {
    'cerca_file': (t_cerca_file, 'Glob', 'Cerca file o cartelle per nome (senza distinguere maiuscole).', {
        'nome': ('string', 'parte del nome o modello, es. "bolletta" o "*.pdf"'),
        'cartella': ('string', 'dove cercare (predefinito: la home)'),
        'giorni': ('integer', 'solo file modificati negli ultimi N giorni (facoltativo)'),
    }, ['nome']),
    'cerca_testo': (t_cerca_testo, 'Grep', 'Cerca i file di testo che contengono una parola o frase.', {
        'testo': ('string', 'testo da cercare'),
        'cartella': ('string', 'dove cercare (meglio una cartella precisa)'),
    }, ['testo']),
    'elenca_cartella': (t_elenca_cartella, 'Glob', 'Mostra il contenuto di una cartella, dal più recente.', {
        'percorso': ('string', 'percorso della cartella'),
    }, ['percorso']),
    'leggi_file': (t_leggi_file, 'Read', 'Legge un file di testo o PDF.', {
        'percorso': ('string', 'percorso completo del file'),
    }, ['percorso']),
    'azione': (t_azione, None, 'Apre qualcosa per l\'utente: app, sito, ricerca web, Spotify, musica, Obsidian o un file.', {
        'tipo': ('string', 'app | web | spotify | musica | obsidian | apri'),
        'nome': ('string', 'per tipo=app: nome dell\'app, es. "Firefox"'),
        'cerca': ('string', 'per web/spotify/obsidian: cosa cercare'),
        'url': ('string', 'per web: indirizzo https://...'),
        'pagina': ('string', 'per spotify: "preferiti" per i brani che piacciono'),
        'comando': ('string', 'per musica: play | pausa | avanti | indietro'),
        'vault': ('string', 'per obsidian: nome del vault'),
        'percorso': ('string', 'per apri: percorso completo del file o cartella'),
    }, ['tipo']),
    'esegui_comando': (t_esegui_comando, 'Bash', 'Esegue un comando bash. L\'utente deve approvarlo. Usalo solo per modifiche chieste dall\'utente.', {
        'comando': ('string', 'il comando, semplice e breve'),
        'descrizione': ('string', 'in italiano, cosa fa il comando'),
    }, ['comando', 'descrizione']),
    'scrivi_file': (t_scrivi_file, 'Write', 'Crea o sovrascrive un file di testo. L\'utente deve approvarlo.', {
        'percorso': ('string', 'percorso completo'),
        'contenuto': ('string', 'testo completo del file'),
    }, ['percorso', 'contenuto']),
}


def tool_specs():
    out = []
    for name, (_fn, _cn, desc, props, req) in TOOLS.items():
        out.append({'type': 'function', 'function': {
            'name': name, 'description': desc,
            'parameters': {'type': 'object', 'required': req,
                           'properties': {k: {'type': t, 'description': d} for k, (t, d) in props.items()}},
        }})
    return out


def status_input(name, args):
    """Traduce lo strumento nel formato di Claude, per la riga di stato del robottino."""
    p = args.get('percorso') or args.get('cartella') or ''
    if name == 'cerca_file':
        return {'pattern': args.get('nome', ''), 'path': p}
    if name == 'cerca_testo':
        return {'pattern': args.get('testo', ''), 'path': p}
    if name == 'elenca_cartella':
        return {'pattern': '*', 'path': p}
    if name == 'leggi_file':
        return {'file_path': p}
    if name == 'esegui_comando':
        return {'command': args.get('comando', ''), 'description': args.get('descrizione', '')}
    if name == 'scrivi_file':
        return {'file_path': p}
    return args


# ---------- ricerca automatica (prima di chiedere a Qwen) ----------
# I modelli piccoli spesso rispondono "non lo trovo" senza cercare: allora cerchiamo noi
# file e app con nomi SIMILI alle parole della domanda (anche con errori di trascrizione)
# e gli passiamo i risultati già pronti.
STOP = set('''
apri aprimi aprire apro apra aprilo aprila cerca cercami cercare cerco trova trovami trovare trovo
dove dov mostra mostrami fammi vedere voglio vorrei puoi potresti riesci per favore grazie ciao
della dello delle degli nella nello nelle negli sulla sullo sulle dalla dallo quello quella quelli
questo questa questi queste file cartella cartelle documento documenti cosa come sono anche ancora
tutto tutti tutte qualche qualcosa allora adesso subito dentro avere hai ho sul nel del dal una uno
mio mia miei mie tuo tua suoi chiedo chiedi chiedere chiesto stato stata creato creata sapere scritto scritta scritte contenuto contiene volume fare farmi fai puo può serve servirebbe computer programma applicazione app leggi leggimi dimmi parla parlami
'''.split())


def norm(w):
    w = unicodedata.normalize('NFKD', w.lower())
    return ''.join(c for c in w if c.isalnum() and not unicodedata.combining(c))


def squeeze(w):
    return re.sub(r'(.)\1+', r'\1', w)


def keywords(q):
    ws = [norm(w) for w in re.split(r"[\s'’,.;:!?()\[\]\"/]+", q)]
    return [w for w in dict.fromkeys(ws) if len(w) >= 4 and w not in STOP and not w.isdigit()]


def similar(a, b):
    if a == b:
        return 1.0
    if min(len(a), len(b)) >= 5 and (a in b or b in a):
        return 0.95
    sm = difflib.SequenceMatcher(None, a, b)
    if sm.real_quick_ratio() < 0.7 or sm.quick_ratio() < 0.7:
        return 0.0
    r = max(sm.ratio(), difflib.SequenceMatcher(None, squeeze(a), squeeze(b)).ratio())
    # le parole corte devono somigliarsi di più, se no "fare" trova "fatture"
    return r if r >= (0.88 if min(len(a), len(b)) <= 5 else 0.78) else 0.0


def home_index():
    cmd = ['find', HOME, '-xdev', '(', '-name', '.*', '-o', '-name', 'snap', '-o', '-name', 'node_modules',
           '-o', '-name', '__pycache__', ')', '-prune', '-o', '-print']
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.splitlines()[1:]
    except Exception:
        return []


def installed_apps():
    try:
        import gi
        gi.require_version('Gio', '2.0')
        from gi.repository import Gio
        return [a.get_name() for a in Gio.AppInfo.get_all() if a.should_show() and a.get_name()]
    except Exception:
        return []


def match_names(kws, names, key=lambda x: x, limit=8):
    tok_cache = {}
    scored = []
    for item in names:
        name = key(item)
        toks = [t for t in (norm(x) for x in re.split(r'[\W_]+', name)) if len(t) >= 3]
        stem = norm(os.path.splitext(name)[0])  # "da-fare.md" -> "dafare"
        if len(stem) >= 4 and stem not in toks:
            toks.append(stem)
        # punteggio = somma della parola più simile per ogni parola della domanda
        total = 0.0
        for k in kws:
            best = 0.0
            for t in toks:
                sc = tok_cache.get((k, t))
                if sc is None:
                    sc = tok_cache[(k, t)] = similar(k, t)
                best = max(best, sc)
            total += best
        if total >= 0.78:
            scored.append((total, item))
    scored.sort(key=lambda x: -x[0])
    return scored[:limit]


def auto_search(question):
    kws = keywords(question.replace(MIC, ''))
    if not kws:
        return ''
    files = match_names(kws, home_index(), key=os.path.basename, limit=60)
    # i più somiglianti, poi i file prima delle cartelle, poi i più recenti
    files.sort(key=lambda x: (-round(x[0], 2), os.path.isdir(x[1]),
                              -(os.path.getmtime(x[1]) if os.path.exists(x[1]) else 0)))
    files = [p for _s, p in files[:8]]
    apps = [a for _s, a in match_names(kws, installed_apps(), limit=4)]
    if not files and not apps:
        return ''
    if files:
        RESULTS[:] = files
    APPS[:] = apps
    out = [f'RICERCA AUTOMATICA per le parole {", ".join(kws)} (nomi simili, anche con errori di battitura):']
    if apps:
        out.append('App installate: ' + ', '.join(apps))
    if files:
        out.append('File e cartelle nella home:')
        out += numbered()
    # se chiedi cosa c'è scritto, il file lo leggiamo noi: così Qwen non può inventarlo
    if files and READ_RE.search(norm_sentence(question)):
        top = next((p for p in files if os.path.isfile(p)), None)
        if top:
            out.append(f'\nCONTENUTO VERO di [{files.index(top) + 1}] {top} (rispondi SOLO in base a questo testo, '
                       f'non inventare niente):\n<<<\n{clip(t_leggi_file(top), 2000)}\n>>>')
    out.append("Come usarli: se l'utente chiede di APRIRE, aprilo SUBITO senza chiedere conferma: "
               "azione tipo=app con il nome dell'app, oppure azione tipo=apri con percorso uguale al NUMERO "
               "del file (es. percorso=\"1\"). Se più file vanno bene ugualmente, apri il primo e nomina gli altri. "
               "Per leggerne uno usa leggi_file con il numero. Se non c'entrano, ignorali.")
    return '\n'.join(out)


# "cosa c'è scritto", "leggimi", "cosa dice", "riassumi"... (dopo norm: niente apostrofi)
READ_RE = re.compile(r'\b(leggi\w*|scritto|scritta|dice|contiene|contenuto|riassum\w*|riassunto|spiegami)\b|\bce\b|\bc e\b')
OPEN_RE = re.compile(r'\b(apri\w*|apra|avvia\w*|lancia\w*|fammi vedere|mostrami|fai partire)\b')


def norm_sentence(q):
    return ' '.join(norm(w) for w in q.replace(MIC, '').split())


def numbered():
    return [f"[{i}] {p}{'/' if os.path.isdir(p) else ''}" for i, p in enumerate(RESULTS, 1)]


def fix_paths(text):
    """Corregge nel testo finale i percorsi ricopiati male, così i pulsanti per aprirli funzionano."""
    def sub(m):
        p = m.group(1)
        if p.startswith('~/'):
            p = HOME + p[1:]
        return f'`{repair(p.rstrip("/"))}`' if p.startswith('/') else m.group(0)
    return re.sub(r'`([^`\n]+)`', sub, text)


# ---------- istruzioni ----------
def obsidian_vaults():
    try:
        with open(os.path.join(HOME, '.config', 'obsidian', 'obsidian.json')) as f:
            data = json.load(f)
        return [os.path.basename(v['path']) for v in data.get('vaults', {}).values()]
    except Exception:
        return []


def system_prompt(name):
    oggi = datetime.date.today()
    giorni = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica']
    s = f"""Sei {name}, il robottino che vive nella barra in alto di Ubuntu e parla come se fossi il computer dell'utente ("nei miei file", "sul mio disco").
Rispondi SEMPRE in italiano, in modo breve (1-4 frasi), simpatico ma sobrio. Niente tabelle.
Oggi è {giorni[oggi.weekday()]} {oggi.strftime('%d/%m/%Y')}. La home dell'utente è {HOME} (cartelle: Scrivania, Documenti, Scaricati, Immagini, Musica, Video).
Come lavori:
- Per trovare file usa cerca_file; per vedere una cartella elenca_cartella; per leggerli leggi_file.
- Per aprire app, siti, ricerche web, Spotify, musica, Obsidian o file usa lo strumento azione (per aprire un'app non serve cercare file).
- esegui_comando e scrivi_file solo se l'utente chiede di modificare qualcosa: l'utente deve approvare. Per cancellare usa "gio trash". Mai sudo.
- Non inventare mai file, percorsi o contenuti: di' solo quello che hai trovato con gli strumenti.
- Quando citi un file scrivi il percorso completo tra backtick, es. `{HOME}/Documenti/file.pdf`.
- Se il messaggio inizia con {MIC} è una trascrizione vocale (può avere errori): rispondi con 1-2 frasi semplici, senza elenchi."""
    vaults = obsidian_vaults()
    if vaults:
        s += '\nVault di Obsidian: ' + ', '.join(f'"{v}"' for v in vaults) + '.'
    mine = instructions_for_model()
    if mine:
        s += ("\nISTRUZIONI DELL'UTENTE, scritte da lui in prima persona: \"io\", \"sono\", \"mi\" = l'UTENTE; "
              "\"tu\", \"ti\" = TE, il robottino. Seguile sempre, valgono più delle regole sopra. "
              "Se l'utente chiede chi è, rispondigli dandogli del tu (es. \"Sei ...\").\n" + mine)
    return s


# ---------- istruzioni personali e "ricordati che..." ----------
ISTRUZIONI = os.path.join(DATA_DIR, 'istruzioni.md')
ISTR_HEADER = '''# Istruzioni per il robottino
# Scrivi qui cosa deve sapere o come deve comportarsi: una cosa per riga, con "- " davanti.
# Valgono per Qwen e per Claude. Le righe che iniziano con # sono commenti.
# Puoi anche dirgli in chat "ricordati che ...", "dimenticati che ..." o "cosa ricordi?".
'''


def instruction_lines():
    try:
        with open(ISTRUZIONI, encoding='utf-8') as f:
            return [l.rstrip() for l in f if l.strip() and not l.lstrip().startswith('#')]
    except OSError:
        return []


def read_instructions():
    return clip('\n'.join(instruction_lines()), 1500)


def instructions_for_model():
    # "Sono Antonino" scritto dall'utente: per un modello piccolo va detto chiaramente chi parla
    lines = [re.sub(r'^\s*-\s*', '', l) for l in instruction_lines()]
    return clip('\n'.join(f'- L\'utente ti ha detto: «{l}»' for l in lines), 1700)


def remember(fact):
    fact = fact.strip().rstrip('.').strip()
    fact = fact[0].upper() + fact[1:] if fact else fact
    os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)
    new = not os.path.exists(ISTRUZIONI)
    with open(ISTRUZIONI, 'a', encoding='utf-8') as f:
        if new:
            f.write(ISTR_HEADER + '\n')
        f.write(f'- {fact}\n')
    return fact


def forget(what):
    target = set(keywords(what))
    try:
        with open(ISTRUZIONI, encoding='utf-8') as f:
            lines = f.readlines()
    except OSError:
        return []
    keep, gone = [], []
    for l in lines:
        if not l.lstrip().startswith('#') and l.strip() and target:
            words = set(keywords(l))
            if len(target & words) >= max(1, (len(target) + 1) // 2):
                gone.append(l.strip().lstrip('- ').strip())
                continue
        keep.append(l)
    if gone:
        with open(ISTRUZIONI, 'w', encoding='utf-8') as f:
            f.writelines(keep)
    return gone


REMEMBER_RE = re.compile(r'^\s*(?:\U0001F3A4\s*)?(?:ok|ehi|senti)?[\s,]*(?:ricordati|ricorda|tieni a mente|memorizza|impara)\s+(?:che\s+|di\s+)?(.+)$', re.I | re.S)
FORGET_RE = re.compile(r'^\s*(?:\U0001F3A4\s*)?(?:ok|ehi|senti)?[\s,]*(?:dimenticati|dimentica|scordati)\s+(?:che\s+|di\s+)?(.+)$', re.I | re.S)
RECALL_RE = re.compile(r'^(?:che )?cosa (?:ti )?(?:ricordi|sai di me)(?: di me)?$')


def handle_memory(q):
    """Gestisce "ricordati che", "dimenticati che", "cosa ricordi?" senza disturbare Qwen. None = non è un comando."""
    m = REMEMBER_RE.match(q)
    if m:
        return f'Ok, me lo ricordo: "{remember(m.group(1))}" ✍️'
    m = FORGET_RE.match(q)
    if m:
        gone = forget(m.group(1))
        if not gone:
            return 'Non avevo niente di simile tra le cose da ricordare.'
        return 'Fatto, ho dimenticato: ' + '; '.join(f'"{g}"' for g in gone)
    if RECALL_RE.match(norm_sentence(q).strip()):
        lines = instruction_lines()
        if not lines:
            return 'Per ora non ho niente da ricordare. Dimmi "ricordati che ..." e lo imparo.'
        return 'Ecco cosa mi ricordo:\n' + '\n'.join(lines)
    return None


# ---------- Ollama ----------
class OllamaError(Exception):
    pass


def chat(messages, on_text):
    body = json.dumps({
        'model': MODEL, 'messages': messages, 'tools': tool_specs(), 'stream': True,
        'think': False,  # i Qwen3 "ibridi" (es. 1.7b) altrimenti ragionano a lungo prima di rispondere
        'keep_alive': '5m', 'options': {'num_ctx': NUM_CTX, 'temperature': 0.2},
    }).encode()
    req = urllib.request.Request(f'{OLLAMA}/api/chat', data=body, headers={'Content-Type': 'application/json'})
    text, calls = '', []
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            for line in r:
                if not line.strip():
                    continue
                ev = json.loads(line)
                if ev.get('error'):
                    raise OllamaError(ev['error'])
                msg = ev.get('message') or {}
                if msg.get('content'):
                    text += msg['content']
                    on_text(text)
                calls += msg.get('tool_calls') or []
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')
        if 'not found' in detail:
            raise OllamaError(f'il modello {MODEL} non è scaricato. Nel terminale: ollama pull {MODEL}')
        raise OllamaError(f'Ollama ha risposto con un errore: {detail[:300]}')
    except urllib.error.URLError:
        raise OllamaError('Ollama non risponde. È avviato? Prova nel terminale: systemctl status ollama')
    return text, calls


def load_session(sid):
    try:
        with open(os.path.join(SESS_DIR, f'{sid}.json')) as f:
            data = json.load(f)
    except Exception:
        return []
    if isinstance(data, list):  # formato vecchio
        return data
    RESULTS[:] = [p for p in data.get('risultati', []) if os.path.exists(p)]
    return data.get('messaggi', [])


def save_session(sid, history):
    # i risultati degli strumenti vecchi si accorciano: occupano memoria e rallentano Qwen
    slim = []
    for m in history[-KEEP_MESSAGES:]:
        m = dict(m)
        if m.get('role') == 'tool':
            m['content'] = clip(m.get('content', ''), 400)
        slim.append(m)
    while slim and slim[0].get('role') != 'user':
        slim.pop(0)
    os.makedirs(SESS_DIR, mode=0o700, exist_ok=True)
    with open(os.path.join(SESS_DIR, f'{sid}.json'), 'w') as f:
        json.dump({'messaggi': slim, 'risultati': RESULTS}, f, ensure_ascii=False)


def turn(domanda, nome, sessione):
    """Una domanda e la sua risposta. Restituisce l'id della sessione."""
    sid = sessione if (sessione or '').startswith('qwen-') else f'qwen-{uuid.uuid4().hex[:12]}'
    emit({'type': 'system', 'subtype': 'init', 'session_id': sid})
    ACTIONS.clear()
    APPS.clear()
    RESULTS.clear()

    mem = handle_memory(domanda)
    if mem:
        emit_text(mem)
        emit_result(sid, mem)
        return sid

    history = load_session(sid)
    history.append({'role': 'user', 'content': domanda})
    start = len(history)  # posizione subito dopo la domanda attuale

    last = [0.0]

    def partial(t):
        now = time.monotonic()
        if now - last[0] > 0.12:
            last[0] = now
            emit({'type': 'aninux_partial', 'text': t})

    answer = ''
    found = auto_search(domanda)
    if found:
        emit_tool('Glob', {'pattern': ' '.join(keywords(domanda)), 'path': HOME})
    elif RESULTS:
        # niente di nuovo: ricorda i risultati di prima ("apri il secondo")
        found = ('Risultati della ricerca precedente (puoi usare il numero come percorso):\n'
                 + '\n'.join(numbered()))
    try:
        for _ in range(MAX_ROUNDS):
            msgs = [{'role': 'system', 'content': system_prompt(nome)}] + history
            # i risultati della ricerca automatica stanno subito dopo la domanda attuale
            # (non si salvano nella storia, così non la appesantiscono)
            if found:
                msgs.insert(1 + start, {'role': 'system', 'content': found})
            text, calls = chat(msgs, partial)
            history.append({'role': 'assistant', 'content': text, **({'tool_calls': calls} if calls else {})})
            text = fix_paths(text)
            history[-1]['content'] = text
            if text.strip():
                emit_text(text.strip())
                answer += ('\n\n' if answer else '') + text.strip()
            if not calls:
                break
            for c in calls:
                fn = c.get('function', {})
                name = fn.get('name', '')
                targs = fn.get('arguments') or {}
                if isinstance(targs, str):
                    try:
                        targs = json.loads(targs)
                    except ValueError:
                        targs = {}
                spec = TOOLS.get(name)
                if spec and spec[1]:
                    emit_tool(spec[1], status_input(name, targs))
                try:
                    out = spec[0](**targs) if spec else f'Strumento sconosciuto: {name}'
                except Exception as e:
                    out = f'Errore: {e}'
                history.append({'role': 'tool', 'tool_name': name, 'content': out})
        else:
            if not answer:
                answer = 'Mi sono perso tra troppi passaggi: puoi chiedermelo in modo più preciso?'
                emit_text(answer)
    except OllamaError as e:
        emit_result(sid, error=str(e))
        return sid
    # rete di sicurezza: hai chiesto di aprire, Qwen l'ha solo scritto ma non l'ha fatto
    if not ACTIONS and OPEN_RE.search(norm_sentence(domanda)):
        cited = [p for p in (repair(x.rstrip('/')) for x in re.findall(r'`(/[^`\n]+)`', answer)) if os.path.exists(p)]
        if cited:
            ACTIONS.append({'tipo': 'apri', 'percorso': cited[0]})
        elif APPS:
            ACTIONS.append({'tipo': 'app', 'nome': APPS[0]})
        elif found and RESULTS:
            ACTIONS.append({'tipo': 'apri', 'percorso': RESULTS[0]})
    if ACTIONS:
        lines = '\n'.join(f'[[AZIONE: {json.dumps(a, ensure_ascii=False)}]]' for a in ACTIONS)
        emit_text(lines)
        answer += '\n' + lines
    if not answer.strip():
        answer = 'Fatto.'
        emit_text(answer)
    save_session(sid, history)
    emit_result(sid, answer)
    return sid


# ---------- chat nel terminale: `aninux` ----------
def run_action(a):
    """Come runAction dell'estensione, ma dal terminale. Restituisce una frase."""
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
    from urllib.parse import quote

    def quiet(argv):
        # le app aperte non devono scrivere i loro messaggi nella chat del terminale
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)

    def uri(u):
        quiet(['gio', 'open', u])

    t = a.get('tipo')
    if t == 'app':
        groups = Gio.DesktopAppInfo.search(str(a.get('nome', '')))
        if not groups or not groups[0]:
            raise RuntimeError(f'non trovo l\'app "{a.get("nome")}"')
        app = Gio.DesktopAppInfo.new(groups[0][0])
        quiet(['gio', 'launch', app.get_filename()])
        return f'Ho aperto {app.get_name()}'
    if t == 'web':
        if a.get('url'):
            uri(a['url'])
            return f'Ho aperto {a["url"]}'
        uri(f'https://www.google.com/search?q={quote(str(a.get("cerca", "")))}')
        return f'Ho cercato sul web: "{a.get("cerca")}"'
    if t == 'spotify':
        if a.get('pagina') == 'preferiti':
            uri('spotify:collection:tracks')
            return 'Ho aperto i tuoi brani preferiti su Spotify'
        uri(f'spotify:search:{quote(str(a["cerca"]))}' if a.get('cerca') else 'spotify:')
        return 'Ho aperto Spotify'
    if t == 'musica':
        cmd = {'play': 'Play', 'pausa': 'Pause', 'avanti': 'Next', 'indietro': 'Previous'}.get(a.get('comando'))
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        names = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                              'ListNames', None, None, Gio.DBusCallFlags.NONE, 1000, None).unpack()[0]
        players = sorted((n for n in names if n.startswith('org.mpris.MediaPlayer2.')),
                         key=lambda n: 'spotify' not in n)
        if not cmd or not players:
            raise RuntimeError('non c\'è nessun lettore musicale aperto')
        bus.call_sync(players[0], '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', cmd,
                      None, None, Gio.DBusCallFlags.NONE, 3000, None)
        return {'Play': 'Musica avviata', 'Pause': 'Musica in pausa', 'Next': 'Brano successivo',
                'Previous': 'Brano precedente'}[cmd]
    if t == 'obsidian':
        vault = a.get('vault') or (obsidian_vaults() or [''])[0]
        uri(f'obsidian://search?vault={quote(vault)}&query={quote(a["cerca"])}' if a.get('cerca')
            else f'obsidian://open?vault={quote(vault)}')
        return f'Ho aperto Obsidian ({vault})'
    if t == 'apri':
        p = full(a.get('percorso', ''))
        if not os.path.exists(p):
            raise RuntimeError(f'non trovo {p}')
        uri(GLib.filename_to_uri(p, None))
        return f'Ho aperto {os.path.basename(p)}'
    raise RuntimeError(f'azione sconosciuta "{t}"')


def terminal_chat(nome):
    import readline  # noqa: F401  (frecce e cronologia nella riga di input)

    tty = sys.stdout.isatty()
    dim = (lambda x: f'\033[2m{x}\033[0m') if tty else (lambda x: x)
    bold = (lambda x: f'\033[1m{x}\033[0m') if tty else (lambda x: x)
    red = (lambda x: f'\033[31m{x}\033[0m') if tty else (lambda x: x)
    state = {'shown': 0}
    sess_file = os.path.join(SESS_DIR, 'terminale.txt')

    def out(obj):
        t = obj.get('type')
        if t == 'aninux_partial':
            txt = obj['text']
            if state['shown'] == 0:
                sys.stdout.write(bold(f'{nome}: '))
            sys.stdout.write(txt[state['shown']:])
            sys.stdout.flush()
            state['shown'] = len(txt)
        elif t == 'assistant':
            for c in obj['message']['content']:
                if c['type'] == 'tool_use':
                    i = c['input']
                    what = {'Glob': f'🔎 cerco {i.get("pattern", "")}', 'Grep': f'🔎 cerco "{i.get("pattern", "")}"',
                            'Read': f'📖 leggo {i.get("file_path", "")}', 'Bash': '⚙ comando',
                            'Write': f'✏ scrivo {i.get("file_path", "")}'}.get(c['name'], c['name'])
                    print(dim(f'  {what}'))
                    continue
                text = c['text']
                acts = [json.loads(m) for m in re.findall(r'\[\[AZIONE:\s*(\{[^\n]*?\})\s*\]\]', text)]
                plain = re.sub(r'\[\[AZIONE:[^\n]*\]\]', '', text).strip()
                if plain:
                    if state['shown']:
                        print()  # la risposta è già comparsa un pezzo alla volta
                    else:
                        print(bold(f'{nome}: ') + plain)
                state['shown'] = 0
                for a in acts:
                    try:
                        print(dim(f'  ▶ {run_action(a)}'))
                    except Exception as e:
                        print(red(f'  ⚠ non ci sono riuscito: {e}'))
        elif t == 'result' and obj.get('is_error'):
            if state['shown']:
                print()
            print(red(f'⚠ {obj["result"]}'))
            state['shown'] = 0

    def ask_tty(tool, inp):
        if state['shown']:
            print()
            state['shown'] = 0
        if tool == 'Bash':
            print(bold(f'🔐 Vuole eseguire: {inp.get("description", "")}') + f'\n   $ {inp.get("command", "")}')
        else:
            print(bold(f'🔐 Vuole scrivere il file {inp.get("file_path", "")}:') + '\n' + clip(inp.get('content', ''), 800))
        try:
            return input('   Accetti? [s/N] ').strip().lower() in ('s', 'si', 'sì', 'y', 'yes')
        except EOFError:
            return False

    globals()['emit'] = out
    globals()['ask'] = ask_tty

    try:
        with open(sess_file) as f:
            sid = f.read().strip()
    except OSError:
        sid = ''
    print(bold(f'🤖 {nome} (Qwen, sul computer)') + dim(' — /nuova per ricominciare, /istruzioni per vederle, /esci o Ctrl+D per uscire'))
    if sid:
        print(dim('   (continuo la chat di prima)'))
    while True:
        try:
            q = input('\n' + bold('Tu: ')).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not q:
            continue
        if q in ('/esci', '/exit', '/quit', 'esci'):
            return
        if q == '/nuova':
            sid = ''
            try:
                os.remove(sess_file)
            except OSError:
                pass
            print(dim('Nuova chat.'))
            continue
        if q == '/istruzioni':
            print(read_instructions() or dim('(nessuna istruzione: dimmi "ricordati che ...")'))
            print(dim(f'File: {ISTRUZIONI}'))
            continue
        print(dim('  …ci penso'))
        try:
            sid = turn(q, nome, sid)
        except KeyboardInterrupt:
            print(red('\n  (fermato)'))
            continue
        os.makedirs(SESS_DIR, mode=0o700, exist_ok=True)
        with open(sess_file, 'w') as f:
            f.write(sid)


def main():
    ap = argparse.ArgumentParser(description='Aninux con Qwen. Senza --domanda apre la chat nel terminale.')
    ap.add_argument('--domanda')
    ap.add_argument('--nome', default='')
    ap.add_argument('--sessione', default='')
    ap.add_argument('--modello', default='', help='modello di Ollama (predefinito: %s)' % MODEL)
    args = ap.parse_args()
    if args.modello:
        globals()['MODEL'] = args.modello
    nome = args.nome
    if not nome:
        try:
            nome = subprocess.run(['gsettings', '--schemadir', os.path.join(os.path.dirname(os.path.realpath(__file__)), 'schemas'),
                                   'get', 'org.gnome.shell.extensions.robottino', 'bot-name'],
                                  capture_output=True, text=True, timeout=3).stdout.strip().strip("'")
        except Exception:
            nome = ''
        nome = nome or 'Aninux'
    if args.domanda is None:
        terminal_chat(nome)
    else:
        turn(args.domanda, nome, args.sessione)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
