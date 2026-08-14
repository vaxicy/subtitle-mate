"""Package the SubtitleMate Chrome extension into a zip for Chrome Web Store upload.

Excludes: .git, .codebuddy, subtitle-mate-privacy (separate privacy repo),
old packed zips, and OS/temp files.
Outputs:
  - <project>/subtitle-mate-<version>.zip  (project-internal copy)
  - D:/迅雷下载/vibe coding/subtitle-mate-<version>.zip  (default folder copy)
"""
import json
import os
import shutil
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DIR = r"D:\迅雷下载\vibe coding"

EXCLUDE_DIRS = {".git", ".codebuddy", "subtitle-mate-privacy", "node_modules"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db"}
SKIP_SUFFIXES = (".zip", ".tmp", ".bak", ".log")


def load_version():
    with open(os.path.join(BASE, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def collect_files():
    out = []
    for root, dirs, files in os.walk(BASE):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for fn in files:
            if fn in EXCLUDE_FILES or fn.endswith(SKIP_SUFFIXES):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, BASE)
            out.append((full, rel))
    return sorted(out)


def main():
    version = load_version()
    files = collect_files()
    if not files:
        raise SystemExit("no files collected")

    project_zip = os.path.join(BASE, f"subtitle-mate-{version}.zip")
    default_zip = os.path.join(DEFAULT_DIR, f"subtitle-mate-{version}.zip")

    # Remove any stale project-internal zips of other versions first.
    for name in os.listdir(BASE):
        if name.startswith("subtitle-mate-") and name.endswith(".zip") and name != os.path.basename(project_zip):
            os.remove(os.path.join(BASE, name))
            print(f"removed stale: {name}")

    with zipfile.ZipFile(project_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for full, rel in files:
            z.write(full, rel)

    os.makedirs(DEFAULT_DIR, exist_ok=True)
    shutil.copy2(project_zip, default_zip)

    print(f"packed {len(files)} files -> {project_zip}")
    print(f"copied  -> {default_zip}")
    print(f"version: {version}")


if __name__ == "__main__":
    main()
