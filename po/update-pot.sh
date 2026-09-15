#!/bin/bash
# Regenerate the translation template from sources.
# Usage: po/update-pot.sh  (run from the repo root or anywhere)

cd "$(dirname "$0")/.."

if ! command -v xgettext >/dev/null 2>&1; then
  echo "Missing dependency: xgettext (gettext-tools)." >&2
  exit 1
fi

xgettext \
  --from-code=UTF-8 \
  --language=JavaScript \
  --keyword=_ --keyword=ngettext:1,2 \
  --package-name=mouse-tail \
  --package-version=1.0 \
  --output=po/mouse-tail.pot \
  prefs.js extension.js

echo "Regenerated po/mouse-tail.pot"
echo "After editing *.po files, compile them with:"
echo "  po/compile-locales.sh"
