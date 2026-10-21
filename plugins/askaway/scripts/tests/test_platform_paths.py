"""Tests for the per-OS Claude Desktop sessions folder in scripts/askaway.py."""
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "askaway.py"


def sessions_root(platform: str, home: Path) -> str:
    probe = (f"import runpy, sys; sys.platform = {platform!r}; "
             f"print(runpy.run_path({str(SCRIPT)!r}, run_name='askaway_probe')['DESKTOP_SESSIONS_ROOT'])")
    done = subprocess.run([sys.executable, "-I", "-c", probe], capture_output=True, text=True, timeout=30,
                          env={"HOME": str(home), "PATH": "/usr/bin:/bin"}, check=True)
    return done.stdout.strip()


def test_macos_uses_application_support(tmp_path):
    assert sessions_root("darwin", tmp_path) == str(
        tmp_path / "Library" / "Application Support" / "Claude" / "claude-code-sessions")


def test_linux_keeps_dot_config(tmp_path):
    assert sessions_root("linux", tmp_path) == str(tmp_path / ".config" / "Claude" / "claude-code-sessions")
