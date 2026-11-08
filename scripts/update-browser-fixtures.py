#!/usr/bin/env python3
"""Export deterministic browser test DTOs from the real Rust EPUB/library implementation.
Run only in an isolated checkout, like other validation commands.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
env = dict(os.environ)
if shutil.which('cargo') is None:
    toolchain = Path.home() / 'Library/Caches/leaf-toolchain'
    env['CARGO_HOME'] = str(toolchain / 'cargo')
    env['RUSTUP_HOME'] = str(toolchain / 'rustup')
    env['PATH'] = str(toolchain / 'cargo/bin') + os.pathsep + env.get('PATH', '')
with tempfile.TemporaryDirectory(prefix='leaf-browser-fixtures-') as directory:
    output = Path(directory) / 'catalog.json'
    subprocess.run(['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', 'native_scope_contract_for_browser_tests', '--', '--ignored'], cwd=root, env={**env, 'LEAF_EXPORT_FIXTURES': str(output)}, check=True)
    catalog = json.loads(output.read_text())

def normalize(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'opened': value[key] = 0
            else: normalize(child)
    elif isinstance(value, list):
        for child in value: normalize(child)

normalize(catalog)
for name in ['sample', 'anthology', 'collection']:
    source_id = 'sample' if name == 'sample' else 'anthology'
    catalog[name].update(id=source_id, path=f'/{source_id}.epub', token=f'{source_id}-token')
for view in catalog['parts'].values():
    view.update(id='anthology', path='/anthology.epub', token='anthology-token')
(root / 'fixtures/browser-catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
