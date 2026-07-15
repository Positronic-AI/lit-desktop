# -*- mode: python ; coding: utf-8 -*-
# Freezes the lit-desktop backend sidecar. The `lit` package is installed from
# the public pre-built wheel (lit-releases) before this runs — this repo carries
# NO lit-lib source, so PyInstaller collects everything from the installed
# package in site-packages (hence no `pathex` into a local src/).
from PyInstaller.utils.hooks import collect_data_files
from PyInstaller.utils.hooks import collect_submodules

import os

datas = []
hiddenimports = ['uvicorn.loops.auto', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on']
# croniter is imported dynamically by the schedule stimulus loader, so
# collect_submodules('lit') never sees it. Force it in or the schedule
# stimulus fails to load ("No module named 'croniter'").
hiddenimports += ['croniter']

# collect_data_files('lit') blindly sweeps in build artifacts and the deprecated
# Node API's bundled web UI. The api-only backend needs none of it. Filter out:
#   - Cython .c intermediates (server.c etc.) and .pyx/.pxd
#   - source maps (.map)
#   - the old web UI static assets (lit/api/static/, esp. Monaco)
def _keep(entry):
    src = entry[0].replace('\\', '/')
    if src.endswith(('.c', '.map', '.pyx', '.pxd')):
        return False
    if '/lit/api/static/' in src:
        return False
    return True

datas += [d for d in collect_data_files('lit') if _keep(d)]

# collect_submodules('lit') relies on pkgutil walking the package by IMPORTING
# each subpackage to recurse — but `lit` is Cython-compiled, and compiled
# subpackages don't always expose a walkable __path__, so submodules get missed
# (e.g. ModuleNotFoundError: No module named 'lit.mux.utils' at runtime). Walk
# the installed package on disk instead and register every compiled/py submodule
# explicitly — bulletproof for a compiled package.
import importlib.util as _ilu
_lit_origin = _ilu.find_spec('lit').origin          # .../site-packages/lit/__init__.py
_lit_dir = os.path.dirname(_lit_origin)              # .../site-packages/lit
_site_root = os.path.dirname(_lit_dir)               # .../site-packages
for _root, _dirs, _files in os.walk(_lit_dir):
    for _f in _files:
        if _f.endswith(('.pyd', '.so', '.py')):
            _base = _f.split('.')[0]                 # 'utils' from 'utils.cpython-312-...so'
            if not _base or _base.startswith('__'):
                continue
            _rel = os.path.relpath(_root, _site_root)
            hiddenimports.append(_rel.replace(os.sep, '.') + '.' + _base)
hiddenimports += collect_submodules('lit')           # belt-and-suspenders
hiddenimports += collect_submodules('uvicorn')

# CRITICAL for the wheel-based build: `lit` ships as Cython-compiled extensions
# (.pyd/.so), and PyInstaller CANNOT trace imports through compiled modules — so
# it never discovers the third-party packages `lit` imports and silently omits
# them, producing a binary that crashes at runtime with ModuleNotFoundError
# (e.g. 'fastapi'). When building from source PyInstaller read the .py and found
# them; from the wheel we must list them explicitly. These are the runtime
# dependencies from positronic-lit's pyproject.toml, by IMPORT name. PyInstaller
# traces each one's own (pure-Python) transitive imports from here.
_RUNTIME_DEPS = [
    'fastapi', 'uvicorn', 'pydantic', 'aiofiles', 'multipart', 'click', 'rich',
    'toml', 'jwt', 'httpx', 'aiohttp', 'asyncssh', 'mcp', 'fastmcp', 'anthropic',
    'google.generativeai', 'tiktoken', 'yaml', 'ollama', 'croniter',
    'cryptography', 'dotenv', 'requests', 'psutil', 'typing_extensions', 'pytz',
    'dateutil', 'tqdm', 'filelock', 'urllib3', 'watchfiles', 'websocket',
    'socketio',
]
hiddenimports += _RUNTIME_DEPS
# Packages with lazily-imported submodules / bundled data need a full collect so
# nothing is missed (starlette powers fastapi; certifi handled above).
for _pkg in ('fastapi', 'starlette', 'anthropic', 'mcp', 'fastmcp'):
    try:
        hiddenimports += collect_submodules(_pkg)
    except Exception:
        pass

# Bundle certifi + its CA file so TLS verification works in the frozen binary.
hiddenimports += ['certifi']
datas += collect_data_files('certifi')

# Stimulus + hook plugins are discovered at runtime by globbing *.py on disk
# (stimulus_loader: `stimuli_dir.glob("*.py")`). collect_submodules only puts
# bytecode into the archive, which the glob can't see — so the loose .py files
# must be extracted to disk. Without this, every stimulus is "Unknown" and the
# agent never responds to messages. (mux/stimuli is excluded from Cython, so the
# .py files are present in the wheel.)
datas += collect_data_files('lit.mux.stimuli', include_py_files=True)
try:
    datas += collect_data_files('lit.mux.hooks', include_py_files=True)
except Exception:
    pass

# Native bridge daemon (lit-bridge-rs): the claude-interactive backend spawns
# this binary and otherwise falls back to a dev-tree path that only exists on
# the build machine. CI builds it (cargo), ad-hoc signs it on macOS, and passes
# its absolute path here. Bundled as `datas` (a verbatim copy, NOT `binaries`)
# so PyInstaller doesn't rewrite the Mach-O and invalidate the signature. The
# entry point resolves it from sys._MEIPASS and sets LIT_BRIDGE_RS_BIN.
_rs_bundle = os.environ.get('LIT_BRIDGE_RS_BUNDLE')
if _rs_bundle and os.path.exists(_rs_bundle):
    datas += [(_rs_bundle, '.')]
    print(f"[lit-server.spec] bundling native bridge: {_rs_bundle}")
else:
    print("[lit-server.spec] LIT_BRIDGE_RS_BUNDLE not set — native bridge NOT bundled")

# Heavy ML / vision / data packages the API path never touches. lit/bin/__init__.py
# imports the ML subcommands under try/except ImportError, so when these aren't
# bundled it falls back to _ML_MODULES = None and `lit serve --api-only` runs fine.
ML_EXCLUDES = [
    'tensorflow', 'tensorboard', 'keras', 'tensorflow_estimator',
    'torch', 'torchvision',
    'numba', 'llvmlite',
    'cv2', 'opencv_python',
    'scipy', 'sklearn', 'scikit_learn',
    'pandas',
    'h5py', 'ml_dtypes',
    'matplotlib',
    'playwright',
]


a = Analysis(
    ['lit-server-entry.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=ML_EXCLUDES,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

# onefile: a single self-contained lit-server executable for the Tauri sidecar.
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='lit-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
# (onefile: no COLLECT step — everything is packed into `exe` above.)
