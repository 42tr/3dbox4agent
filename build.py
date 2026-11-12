"""Compatibility entry point for the Console build."""
from pathlib import Path
from runpy import run_path

run_path(str(Path(__file__).resolve().parent / 'packages/console/build.py'), run_name='__main__')
