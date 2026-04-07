"""Build the Python sidecar into a standalone exe using PyInstaller."""

import subprocess
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).parent
DIST = ROOT / "src-tauri" / "binaries"

def main():
    # Build with PyInstaller
    subprocess.run([
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", "sidecar",
        "--distpath", str(DIST),
        "--workpath", str(ROOT / "build" / "pyinstaller"),
        "--specpath", str(ROOT / "build"),
        "--add-data", f"{ROOT / 'brain.py'};.",
        "--add-data", f"{ROOT / 'capture.py'};.",
        "--hidden-import", "pywinauto",
        "--hidden-import", "pywinauto.controls.uiawrapper",
        "--hidden-import", "pywinauto.findwindows",
        "--hidden-import", "rapidocr_onnxruntime",
        "--hidden-import", "mss",
        "--hidden-import", "numpy",
        "--hidden-import", "PIL",
        "--clean",
        str(ROOT / "sidecar" / "server.py"),
    ], check=True)

    # Tauri expects binaries named with target triple
    exe = DIST / "sidecar.exe"
    target = DIST / "sidecar-x86_64-pc-windows-msvc.exe"
    if target.exists():
        target.unlink()
    shutil.copy2(exe, target)
    print(f"Sidecar built: {target}")

if __name__ == "__main__":
    main()
