"""Store and retrieve immutable 3DBox experiment JSON in a local SQLite catalog."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

APP_ID = 0x33444258  # 3DBX
SCHEMA_VERSION = 1
MAX_BYTES = 50 * 1024 * 1024
DEFAULT_DB = '.3dbox/experiment-catalog.sqlite3'
FORMAT_RE = re.compile(r'^3dbox-[A-Za-z0-9_-]{1,100}$')
ID_RE = re.compile(r'^[0-9a-f]{64}$')


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError('non-finite JSON number')


def parse_report(raw):
    try:
        report = json.loads(raw.decode('utf-8'), object_pairs_hook=no_duplicates, parse_constant=reject_constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise ValueError('invalid UTF-8 JSON: ' + str(error)) from error
    if not isinstance(report, dict) or not isinstance(report.get('format'), str) or not FORMAT_RE.fullmatch(report['format']):
        raise ValueError('expected a 3dbox report format')
    config = report.get('config') if isinstance(report.get('config'), dict) else {}
    scene = config.get('sceneId') or config.get('scene') or report.get('scene')
    if isinstance(scene, dict): scene = scene.get('id')
    if not isinstance(scene, str) or len(scene) > 100: scene = None
    return report['format'], scene


def open_catalog(db, write=False):
    path = Path(db).expanduser().absolute()
    created = False
    if write:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd); created = True
        except FileExistsError:
            pass
    elif not path.is_file():
        raise ValueError('catalog does not exist')
    uri = path.as_uri() + ('?mode=rw' if write else '?mode=ro')
    con = sqlite3.connect(uri, uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        if write: con.execute('BEGIN IMMEDIATE')
        app_id = con.execute('PRAGMA application_id').fetchone()[0]
        version = con.execute('PRAGMA user_version').fetchone()[0]
        if created:
            if app_id != 0 or version != 0 or con.execute("SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchone()[0]:
                raise ValueError('new catalog is not empty')
            con.execute(f'PRAGMA application_id={APP_ID}')
            con.execute(f'PRAGMA user_version={SCHEMA_VERSION}')
            con.execute('CREATE TABLE reports (id TEXT PRIMARY KEY, format TEXT NOT NULL, scene TEXT, label TEXT NOT NULL, created_at TEXT NOT NULL, size INTEGER NOT NULL, payload BLOB NOT NULL)')
            con.execute('CREATE INDEX reports_search ON reports(format, scene, created_at)')
        elif app_id != APP_ID or version != SCHEMA_VERSION:
            raise ValueError('file is not a supported 3dbox catalog')
        return con
    except BaseException:
        con.close()
        raise


def info(row):
    return {key:row[key] for key in ('id','format','scene','label','created_at','size')}


def load_report(path):
    if path == '-': raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    else:
        with open(path, 'rb') as stream:
            raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES: raise ValueError('report exceeds 50 MiB')
    fmt, scene = parse_report(raw)
    return raw, fmt, scene


def add(db, file, label):
    if len(label) > 200 or any(ord(ch) < 32 for ch in label): raise ValueError('invalid label')
    raw, fmt, scene = load_report(file); digest = hashlib.sha256(raw).hexdigest()
    with open_catalog(db, True) as con:
        con.execute('INSERT OR IGNORE INTO reports VALUES (?,?,?,?,?,?,?)',
                    (digest, fmt, scene, label, datetime.now(timezone.utc).isoformat(timespec='seconds'), len(raw), raw))
        inserted = bool(con.execute('SELECT changes()').fetchone()[0])
        row = lookup(con, digest, True)
        if verified_bytes(row) != raw: raise ValueError('stored report content mismatch')
    return {'inserted':inserted,'report':info(row)}


def lookup(con, report_id, payload=False):
    if not ID_RE.fullmatch(report_id): raise ValueError('report ID must be 64 lowercase hexadecimal characters')
    row = con.execute('SELECT id,format,scene,label,created_at,size'+(',payload' if payload else '')+' FROM reports WHERE id=?',(report_id,)).fetchone()
    if row is None: raise ValueError('report not found')
    return row


def verified_bytes(row):
    raw = row['payload']
    if len(raw) != row['size'] or hashlib.sha256(raw).hexdigest() != row['id']:
        raise ValueError('stored report checksum mismatch')
    return raw


def export(db, report_id, output):
    with open_catalog(db) as con: raw = verified_bytes(lookup(con, report_id, True))
    # O_EXCL prevents overwriting any existing file, including another export.
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    except BaseException:
        try: os.unlink(output)
        except OSError: pass
        raise
    return {'id':report_id,'output':str(output),'size':len(raw)}


def verify(db):
    with open_catalog(db) as con:
        integrity = con.execute('PRAGMA integrity_check').fetchall()
        if len(integrity) != 1 or integrity[0][0] != 'ok': raise ValueError('SQLite integrity check failed')
        count = 0
        for row in con.execute('SELECT id,size,payload FROM reports'):
            verified_bytes(row); count += 1
    return {'verified':count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', default=DEFAULT_DB, help='catalog path (default: .3dbox/experiment-catalog.sqlite3)')
    commands = parser.add_subparsers(dest='command', required=True)
    put = commands.add_parser('add'); put.add_argument('file'); put.add_argument('--label', default='')
    listing = commands.add_parser('list'); listing.add_argument('--format'); listing.add_argument('--scene'); listing.add_argument('--limit', type=int, default=50); listing.add_argument('--label'); listing.add_argument('--before-created-at'); listing.add_argument('--before-id')
    show = commands.add_parser('show'); show.add_argument('id')
    out = commands.add_parser('export'); out.add_argument('id'); out.add_argument('output')
    read = commands.add_parser('read'); read.add_argument('id')
    commands.add_parser('verify')
    args = parser.parse_args()
    try:
        if args.command == 'add': result = add(args.db, args.file, args.label)
        elif args.command == 'export': result = export(args.db, args.id, args.output)
        elif args.command == 'verify': result = verify(args.db)
        elif args.command == 'read':
            with open_catalog(args.db) as con: raw = verified_bytes(lookup(con, args.id, True))
            sys.stdout.buffer.write(raw); return 0
        else:
            with open_catalog(args.db) as con:
                if args.command == 'show': result = info(lookup(con, args.id))
                else:
                    if not 1 <= args.limit <= 501: raise ValueError('limit must be 1–501')
                    if (args.before_created_at is None) != (args.before_id is None): raise ValueError('cursor requires timestamp and ID')
                    if args.before_created_at is not None and (not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00', args.before_created_at) or not ID_RE.fullmatch(args.before_id)): raise ValueError('invalid cursor')
                    if args.label is not None and len(args.label) > 200: raise ValueError('invalid label filter')
                    query = 'SELECT id,format,scene,label,created_at,size FROM reports WHERE 1=1'; params = []
                    if args.format is not None: query += ' AND format=?'; params.append(args.format)
                    if args.scene is not None: query += ' AND scene=?'; params.append(args.scene)
                    if args.label is not None: query += ' AND instr(label,?)>0'; params.append(args.label)
                    if args.before_created_at is not None:
                        query += ' AND (created_at < ? OR (created_at = ? AND id < ?))'; params.extend([args.before_created_at,args.before_created_at,args.before_id])
                    query += ' ORDER BY created_at DESC,id DESC LIMIT ?'; params.append(args.limit)
                    result = [info(row) for row in con.execute(query,params)]
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, sqlite3.Error) as error:
        print('catalog: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__': sys.exit(main())
