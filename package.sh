#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

EXTENSION_NAME="mouse-tail"
ZIP_FILE="${EXTENSION_NAME}.zip"

# Files to include in the zip
FILES=(
    "extension.js"
    "metadata.json"
    "prefs.js"
    "profileEngine.js"
    "trailRender.js"
    "LICENSE"
    "README.md"
    "doc"
    "schemas"
    "locale"
)

echo "Packaging ${EXTENSION_NAME}..."

# Compile translations so the zip always carries fresh .mo files.
# Guard: even if compilation is skipped (no msgfmt), the dir must
# exist for the zip file list below.
po/compile-locales.sh
mkdir -p locale

# Remove existing zip if present
rm -f "${ZIP_FILE}"

# Create zip with only necessary files
zip -r "${ZIP_FILE}" "${FILES[@]}" \
    -x "*/.git*" \
    -x "*~" \
    -x "*.bak" \
    -x "*.swp" \
    -x "*/__pycache__/*" \
    -x "schemas/gschemas.compiled"

echo "Created ${ZIP_FILE}"
echo "Contents:"
unzip -l "${ZIP_FILE}"
