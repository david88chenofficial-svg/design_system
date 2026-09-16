"""Double-click launcher for the Seal Model Comparison Tool."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import traceback


# Keep emailed/shared copies clean of generated .pyc files.
sys.dont_write_bytecode = True


ROOT_DIR = Path(__file__).resolve().parent
APP_DIR = ROOT_DIR / "seal_calculations_2"


def show_error(title: str, message: str) -> None:
    """Show an error even when this script is running without a console."""
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(title, message, parent=root)
        root.destroy()
    except Exception:
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, message, title, 0x10)
        except Exception:
            pass


def main() -> None:
    gui_file = APP_DIR / "model_gui.py"
    if not gui_file.is_file():
        show_error(
            "Seal Design GUI not found",
            f"Expected to find:\n{gui_file}\n\n"
            "Keep LAUNCH_GUI.pyw in the top level of the Design_System folder.",
        )
        return

    os.chdir(APP_DIR)
    sys.path.insert(0, str(APP_DIR))

    try:
        import model_gui
    except ModuleNotFoundError as exc:
        missing = exc.name or "a required package"
        show_error(
            "Python package required",
            f"The GUI could not start because '{missing}' is not installed.\n\n"
            "Open PowerShell in this folder and run:\n\n"
            'py -m pip install -r "requirements.txt"\n\n'
            "Then double-click LAUNCH_GUI.pyw again.",
        )
        return
    except Exception:
        show_error(
            "Seal Design GUI could not start",
            "An error occurred while loading the GUI:\n\n" + traceback.format_exc(),
        )
        return

    try:
        model_gui.main()
    except Exception:
        show_error(
            "Seal Design GUI error",
            "The GUI stopped because of an error:\n\n" + traceback.format_exc(),
        )


if __name__ == "__main__":
    main()
