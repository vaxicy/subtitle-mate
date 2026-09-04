"""Package the SubtitleMate Chrome extension into a zip for Chrome Web Store upload.

Includes only the extension runtime files:
  manifest.json, icons/, popup/, content/, shared/, background/, _locales/,
  support.html, support.js, README.md, LICENSE

Excludes: .git, .codebuddy, docs/ (privacy policy is hosted on GitHub Pages),
store-assets/ (uploaded separately in the store form), scripts/ (build tooling),
dev notes, old packed zips, and OS/temp files.

Outputs:
  - <project>/subtitle-mate-<version>.zip  (project-internal copy)
  - D:/迅雷下载/vibe coding/subtitle-mate-<version>.zip  (default folder copy)
"""
import hashlib
import json
import os
import shutil
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DIR = r"D:\迅雷下载\vibe coding"

EXCLUDE_DIRS = {
    ".git", ".codebuddy", "subtitle-mate-privacy", "node_modules",
    "store-assets", "scripts", "docs",
}
EXCLUDE_FILES = {
    ".DS_Store", "Thumbs.db", ".gitignore", ".vscodeignore",
    "privacy-policy.html", "subtitlemate-ai-prompt.md",
}
SKIP_SUFFIXES = (".zip", ".tmp", ".bak", ".log")


def load_manifest():
    with open(os.path.join(BASE, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)


def manifest_refs(m):
    """Every local file path referenced from manifest.json."""
    refs = []
    refs.extend((m.get("icons") or {}).values())
    refs.extend(((m.get("action") or {}).get("default_icon") or {}).values())
    sw = (m.get("background") or {}).get("service_worker")
    if sw:
        refs.append(sw)
    popup = (m.get("action") or {}).get("default_popup")
    if popup:
        refs.append(popup)
    for cs in m.get("content_scripts") or []:
        refs.extend(cs.get("js") or [])
    for war in m.get("web_accessible_resources") or []:
        refs.extend(war.get("resources") or [])
    return refs


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


def md5(path):
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def remove_stale_zips(keep_name):
    """Delete subtitle-mate-*.zip of other versions in the project folder and in
    the default output folder, so an outdated package is never uploaded."""
    for folder in (BASE, DEFAULT_DIR):
        if not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            if (name.startswith("subtitle-mate-") and name.endswith(".zip")
                    and name != keep_name):
                os.remove(os.path.join(folder, name))
                print(f"removed stale: {os.path.join(folder, name)}")


def main():
    manifest = load_manifest()
    version = manifest["version"]

    # --- pre-checks ---------------------------------------------------------
    assert manifest["manifest_version"] == 3, "manifest_version must be 3"

    missing = [r for r in manifest_refs(manifest)
               if not os.path.exists(os.path.join(BASE, r))]
    if missing:
        raise SystemExit(f"manifest references missing files: {missing}")

    files = collect_files()
    if not files:
        raise SystemExit("no files collected")
    assert any(rel == "manifest.json" for _, rel in files), "manifest.json missing"

    project_zip = os.path.join(BASE, f"subtitle-mate-{version}.zip")
    default_zip = os.path.join(DEFAULT_DIR, f"subtitle-mate-{version}.zip")

    remove_stale_zips(os.path.basename(project_zip))

    with zipfile.ZipFile(project_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for full, rel in files:
            z.write(full, rel)

    # --- post-checks: re-read the manifest from inside the zip --------------
    with zipfile.ZipFile(project_zip) as z:
        names = z.namelist()
        assert "manifest.json" in names, "manifest.json not at zip root"
        inside = json.loads(z.read("manifest.json").decode("utf-8"))
    assert inside["version"] == version, "version mismatch inside zip"
    assert inside["name"] == manifest["name"], "name mismatch inside zip"

    os.makedirs(DEFAULT_DIR, exist_ok=True)
    shutil.copy2(project_zip, default_zip)
    assert md5(project_zip) == md5(default_zip), "default-folder copy differs"

    print(f"packed {len(files)} files -> {project_zip}")
    print(f"copied  -> {default_zip}")
    print(f"version: {version}")
    print("--- contents ---")
    for name in names:
        print("  " + name)
    print("all checks passed")


if __name__ == "__main__":
    main()
