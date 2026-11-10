// Impostazioni del robottino: nome, modello, voce, scorciatoie e account di Claude Code.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const HOME = GLib.get_home_dir();
const DEFAULT_NAME = 'Aninux';

const MODELS = [
    {id: '', label: 'Predefinito di Claude Code'},
    {id: 'haiku', label: 'Haiku – il più veloce'},
    {id: 'sonnet', label: 'Sonnet – equilibrato'},
    {id: 'opus', label: 'Opus – il più intelligente'},
];

const VOICE_MODES = [
    {id: 'voce', label: 'Solo se gli parli'},
    {id: 'sempre', label: 'Sempre'},
    {id: 'mai', label: 'Mai (solo per scritto)'},
];

const TERMINALS = [
    ['kgx', '--'], ['ptyxis', '--'], ['gnome-terminal', '--'], ['x-terminal-emulator', '-e'],
];

function expandHome(p) {
    p = (p ?? '').trim();
    if (p === '~')
        return HOME;
    return p.startsWith('~/') ? GLib.build_filenamev([HOME, p.slice(2)]) : p;
}

function shortHome(p) {
    return p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
}

// stessa ricerca dell'estensione: percorso scelto, poi ~/.local/bin/claude, poi il PATH
function findClaude(custom) {
    const chosen = expandHome(custom);
    if (chosen)
        return GLib.file_test(chosen, GLib.FileTest.IS_EXECUTABLE) ? chosen : null;
    const local = GLib.build_filenamev([HOME, '.local', 'bin', 'claude']);
    if (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE))
        return local;
    return GLib.find_program_in_path('claude');
}

function comboRow(title, subtitle, items, settings, key) {
    const row = new Adw.ComboRow({
        title, subtitle,
        model: Gtk.StringList.new(items.map(i => i.label)),
    });
    const sync = () => {
        const i = items.findIndex(x => x.id === settings.get_string(key));
        row.selected = i < 0 ? 0 : i;
    };
    sync();
    row.connect('notify::selected', () => {
        const id = items[row.selected]?.id;
        if (id !== undefined && id !== settings.get_string(key))
            settings.set_string(key, id);
    });
    const sid = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(sid));
    return row;
}

// casella di testo legata a una chiave: salva quando premi Invio (pulsante ✓)
function entryRow(title, settings, key) {
    const row = new Adw.EntryRow({title, show_apply_button: true, text: settings.get_string(key)});
    row.connect('apply', () => settings.set_string(key, row.text.trim()));
    const sid = settings.connect(`changed::${key}`, () => {
        if (row.text.trim() !== settings.get_string(key))
            row.text = settings.get_string(key);
    });
    row.connect('destroy', () => settings.disconnect(sid));
    return row;
}

function shortcutRow(title, settings, key) {
    const row = new Adw.EntryRow({
        title, show_apply_button: true, text: settings.get_strv(key)[0] ?? '',
    });
    row.connect('apply', () => {
        const text = row.text.trim();
        if (!text) {
            settings.set_strv(key, []);
            row.remove_css_class('error');
            return;
        }
        const [ok, keyval, mods] = Gtk.accelerator_parse(text);
        if (!ok || !keyval) {
            row.add_css_class('error');
            return;
        }
        row.remove_css_class('error');
        const accel = Gtk.accelerator_name(keyval, mods);
        settings.set_strv(key, [accel]);
        row.text = accel;
    });
    return row;
}

export default class AninuxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        window.add(this._generalPage(settings));
        window.add(this._accountPage(settings, window));
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Generale', icon_name: 'preferences-system-symbolic'});

        const bot = new Adw.PreferencesGroup({
            title: 'Robottino',
            description: 'Il nome con cui il robottino si presenta, nel riquadro, nelle notifiche e nelle risposte.',
        });
        const name = new Adw.EntryRow({
            title: 'Nome', show_apply_button: true,
            text: settings.get_string('bot-name') || DEFAULT_NAME,
        });
        name.connect('apply', () => {
            const v = name.text.trim() || DEFAULT_NAME;
            name.text = v;
            settings.set_string('bot-name', v);
        });
        bot.add(name);
        page.add(bot);

        const claude = new Adw.PreferencesGroup({title: 'Risposte'});
        claude.add(comboRow('Modello', 'Puoi cambiarlo anche dal pulsante 🧠 nel riquadro',
            MODELS, settings, 'model'));
        claude.add(comboRow('Risposte a voce', 'Serve la voce installata (installa-voce.sh)',
            VOICE_MODES, settings, 'voice-replies'));
        page.add(claude);

        const keys = new Adw.PreferencesGroup({
            title: 'Scorciatoie',
            description: 'Scrivi la combinazione, ad esempio &lt;Super&gt;space o &lt;Control&gt;&lt;Super&gt;space, e premi Invio. Vuoto = nessuna scorciatoia.',
        });
        keys.add(shortcutRow('Apri il riquadro', settings, 'open-assistant'));
        keys.add(shortcutRow('Parla al robottino', settings, 'listen-assistant'));
        page.add(keys);
        return page;
    }

    _accountPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Account Claude', icon_name: 'avatar-default-symbolic'});

        // --- stato dell'account ---
        const status = new Adw.PreferencesGroup({
            title: 'Account',
            description: 'Il robottino usa Claude Code: serve un abbonamento Claude (Pro o Max) oppure un account della Console Anthropic.',
        });
        const who = new Adw.ActionRow({title: 'Controllo…', subtitle: ' '});
        who.add_prefix(new Gtk.Image({icon_name: 'avatar-default-symbolic', pixel_size: 32}));
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Aggiorna', css_classes: ['flat'],
        });
        who.add_suffix(refresh);
        status.add(who);

        const actions = new Adw.ActionRow({title: 'Accesso'});
        const login = new Gtk.Button({label: 'Accedi…', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        const logout = new Gtk.Button({label: 'Esci', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        actions.add_suffix(login);
        actions.add_suffix(logout);
        status.add(actions);
        page.add(status);

        // --- profilo ---
        const profile = new Adw.PreferencesGroup({
            title: 'Profilo',
            description: 'Ogni cartella profilo è un account Claude Code separato, con il suo accesso e le sue conversazioni. ' +
                'Lascia vuoto per usare quello normale (~/.claude). Per un secondo account scegli una cartella nuova, ' +
                'per esempio ~/.claude-universita, e poi premi «Accedi…».',
        });
        const dir = entryRow('Cartella del profilo', settings, 'claude-config-dir');
        const pick = new Gtk.Button({
            icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Scegli una cartella', css_classes: ['flat'],
        });
        pick.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Cartella del profilo di Claude Code', modal: true});
            const current = expandHome(settings.get_string('claude-config-dir')) || GLib.build_filenamev([HOME, '.claude']);
            dialog.set_initial_folder(Gio.File.new_for_path(GLib.file_test(current, GLib.FileTest.IS_DIR) ? current : HOME));
            dialog.select_folder(window, null, (d, res) => {
                try {
                    const f = d.select_folder_finish(res);
                    if (f)
                        settings.set_string('claude-config-dir', shortHome(f.get_path()));
                } catch (_e) {} // annullato
            });
        });
        dir.add_suffix(pick);
        profile.add(dir);
        page.add(profile);

        // --- programma ---
        const program = new Adw.PreferencesGroup({
            title: 'Programma',
            description: 'Lascia vuoto per cercare «claude» da solo (in ~/.local/bin e nel PATH).',
        });
        program.add(entryRow('Percorso di claude', settings, 'claude-path'));
        const found = new Adw.ActionRow({title: 'In uso', subtitle: ' ', subtitle_selectable: true});
        program.add(found);
        page.add(program);

        // --- logica ---
        let busy = false;
        const env = () => {
            const p = expandHome(settings.get_string('claude-config-dir'));
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            });
            if (p)
                launcher.setenv('CLAUDE_CONFIG_DIR', p, true);
            else
                launcher.unsetenv('CLAUDE_CONFIG_DIR');
            return launcher;
        };

        const update = () => {
            const claude = findClaude(settings.get_string('claude-path'));
            found.subtitle = claude ?? 'Non trovato: installa Claude Code o indica il percorso qui sopra';
            login.sensitive = logout.sensitive = refresh.sensitive = Boolean(claude);
            if (!claude) {
                who.title = 'Claude Code non trovato';
                who.subtitle = 'Installalo da https://claude.com/claude-code';
                return;
            }
            if (busy)
                return;
            busy = true;
            who.title = 'Controllo…';
            who.subtitle = ' ';
            try {
                const proc = env().spawnv([claude, 'auth', 'status', '--json']);
                proc.communicate_utf8_async(null, null, (p, res) => {
                    busy = false;
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        const info = JSON.parse(out);
                        if (!info.loggedIn) {
                            who.title = 'Non hai ancora fatto l\'accesso';
                            who.subtitle = 'Premi «Accedi…»';
                            logout.sensitive = false;
                            return;
                        }
                        who.title = info.email || info.orgName || 'Accesso fatto';
                        const plan = info.subscriptionType ? `Claude ${info.subscriptionType[0].toUpperCase()}${info.subscriptionType.slice(1)}`
                            : info.authMethod === 'claude.ai' ? 'Abbonamento Claude' : 'Console Anthropic';
                        who.subtitle = `${plan} · profilo ${shortHome(info.configDirectory ?? '~/.claude')}`;
                    } catch (_e) {
                        who.title = 'Non riesco a leggere lo stato dell\'account';
                        who.subtitle = 'Aggiorna Claude Code (serve il comando «claude auth status»)';
                    }
                });
            } catch (e) {
                busy = false;
                who.title = 'Non riesco ad avviare claude';
                who.subtitle = e.message;
            }
        };

        login.connect('clicked', () => {
            const claude = findClaude(settings.get_string('claude-path'));
            if (!claude)
                return;
            const p = expandHome(settings.get_string('claude-config-dir'));
            // $1 = claude, $2 = cartella profilo (vuota = predefinita)
            const script = 'if [ -n "$2" ]; then export CLAUDE_CONFIG_DIR="$2"; fi; ' +
                '"$1" auth login; echo; read -rp "Fatto. Premi Invio per chiudere questa finestra… " _';
            const term = TERMINALS.find(([t]) => GLib.find_program_in_path(t));
            if (!term) {
                who.title = 'Non trovo un terminale';
                who.subtitle = `Apri un terminale e scrivi: ${p ? `CLAUDE_CONFIG_DIR=${p} ` : ''}claude auth login`;
                return;
            }
            try {
                Gio.Subprocess.new([term[0], term[1], 'bash', '-c', script, 'accesso', claude, p],
                    Gio.SubprocessFlags.NONE);
                who.title = 'Accesso in corso nel terminale…';
                who.subtitle = 'Quando hai finito torna qui: lo stato si aggiorna da solo';
            } catch (e) {
                who.title = 'Non riesco ad aprire il terminale';
                who.subtitle = e.message;
            }
        });

        logout.connect('clicked', () => {
            const claude = findClaude(settings.get_string('claude-path'));
            if (!claude)
                return;
            const dialog = new Adw.AlertDialog({
                heading: 'Uscire dall\'account?',
                body: 'Il robottino non potrà rispondere finché non accedi di nuovo con questo profilo.',
            });
            dialog.add_response('cancel', 'Annulla');
            dialog.add_response('logout', 'Esci');
            dialog.set_response_appearance('logout', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, r) => {
                if (r !== 'logout')
                    return;
                try {
                    env().spawnv([claude, 'auth', 'logout']).wait_async(null, () => update());
                } catch (e) {
                    who.subtitle = e.message;
                }
            });
            dialog.present(window);
        });

        refresh.connect('clicked', update);
        const ids = ['claude-config-dir', 'claude-path'].map(k => settings.connect(`changed::${k}`, update));
        // quando torni alla finestra (per esempio dopo l'accesso nel terminale)
        const activeId = window.connect('notify::is-active', () => {
            if (window.is_active)
                update();
        });
        window.connect('close-request', () => {
            ids.forEach(id => settings.disconnect(id));
            window.disconnect(activeId);
            return false;
        });
        update();
        return page;
    }
}
