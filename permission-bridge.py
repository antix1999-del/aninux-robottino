#!/usr/bin/env python3
"""Ponte dei permessi di Aninux.

Piccolo server MCP (stdio) che Claude Code usa come --permission-prompt-tool.
Ogni volta che Claude vuole modificare un file o eseguire un comando, questo
script chiede il permesso all'estensione GNOME via D-Bus e aspetta che
l'utente prema "Accetta" o "Rifiuta" nel riquadro di Aninux.
"""
import json
import sys

try:
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
except Exception:  # senza gi non si può chiedere: si rifiuta tutto
    Gio = None

DENY_MSG = ("L'utente ha rifiutato questa operazione. Non riprovare la stessa cosa in un altro modo: "
            "spiega cosa volevi fare e chiedi all'utente come preferisce procedere.")
WAIT_MS = 15 * 60 * 1000


def ask(tool, tool_input):
    if Gio is None:
        return False
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    res = bus.call_sync(
        'org.gnome.Shell', '/org/gnome/Shell/Extensions/Aninux',
        'org.gnome.Shell.Extensions.Aninux', 'Ask',
        GLib.Variant('(ss)', (tool, json.dumps(tool_input, ensure_ascii=False))),
        GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, WAIT_MS, None)
    return bool(res.unpack()[0])


def send(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


TOOL = {
    'name': 'approva',
    'description': "Chiede all'utente il permesso di eseguire uno strumento.",
    'inputSchema': {
        'type': 'object',
        'properties': {
            'tool_name': {'type': 'string'},
            'input': {'type': 'object'},
            'tool_use_id': {'type': 'string'},
        },
        'required': ['tool_name', 'input'],
    },
}

for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    mid = msg.get('id')
    method = msg.get('method')
    if method == 'initialize':
        send({'jsonrpc': '2.0', 'id': mid, 'result': {
            'protocolVersion': msg.get('params', {}).get('protocolVersion', '2024-11-05'),
            'capabilities': {'tools': {}},
            'serverInfo': {'name': 'aninux', 'version': '1'},
        }})
    elif method == 'tools/list':
        send({'jsonrpc': '2.0', 'id': mid, 'result': {'tools': [TOOL]}})
    elif method == 'tools/call':
        args = msg.get('params', {}).get('arguments', {})
        tool_input = args.get('input', {})
        try:
            allowed = ask(args.get('tool_name', '?'), tool_input)
        except Exception as e:  # riquadro non raggiungibile o tempo scaduto
            allowed = False
            sys.stderr.write(f'aninux bridge: {e}\n')
        decision = ({'behavior': 'allow', 'updatedInput': tool_input} if allowed
                    else {'behavior': 'deny', 'message': DENY_MSG})
        send({'jsonrpc': '2.0', 'id': mid,
              'result': {'content': [{'type': 'text', 'text': json.dumps(decision)}]}})
    elif mid is not None:
        send({'jsonrpc': '2.0', 'id': mid, 'result': {}})
