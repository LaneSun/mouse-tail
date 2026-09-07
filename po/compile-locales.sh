#!/bin/bash
# Compile every po/*.po into locale/<lang>/LC_MESSAGES/mouse-tail.mo.
# Used by install.sh (git checkout) and package.sh (zip packaging).
# Translations are optional: if msgfmt is missing, warn and keep going.

cd "$(dirname "$0")/.."

if ! command -v msgfmt >/dev/null 2>&1; then
  echo "[!] msgfmt not found — skipping translations (UI falls back to English)." >&2
  exit 0
fi

compiled=0
for po_file in po/*.po; do
  [ -e "$po_file" ] || continue
  lang="$(basename "$po_file" .po)"
  out_dir="locale/${lang}/LC_MESSAGES"
  mkdir -p "$out_dir"
  if msgfmt --check -o "${out_dir}/mouse-tail.mo" "$po_file"; then
    echo "[+] Compiled translations: ${lang}"
    compiled=$((compiled + 1))
  else
    echo "[!] Failed to compile ${po_file} — skipped." >&2
  fi
done

[ "$compiled" -eq 0 ] && echo "[i] No .po files found."
exit 0
