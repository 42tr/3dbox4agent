"""Load local JSON or restricted YAML scenes using the shared JS parser."""
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def load_scene_file(path, max_bytes=60000):
    path = Path(path)
    with path.open('rb') as source:
        raw = source.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError('scene file exceeds size limit')
    yaml = path.suffix.lower() in ('.yaml', '.yml')
    scene = None if yaml else json.loads(raw)
    packaged = isinstance(scene, dict) and 'format' in scene
    if yaml or packaged:
        try:
            result = subprocess.run(['node', str(ROOT/'scripts/parse-scene-stdin.js'), 'yaml' if yaml else 'json'], input=raw,
                                    capture_output=True, timeout=10, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ValueError('scene parser unavailable or timed out') from error
        if result.returncode:
            raise ValueError('invalid scene file: ' + result.stderr.decode('utf-8', 'replace').strip()[:300])
        scene = json.loads(result.stdout)
    if not isinstance(scene, dict):
        raise ValueError('scene file must contain an object')
    return scene, hashlib.sha256(raw).hexdigest()
