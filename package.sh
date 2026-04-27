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
    "LICENSE"
    "README.md"
    "doc"
    "schemas"
)

echo "Packaging ${EXTENSION_NAME}..."

# Remove existing zip if present
rm -f "${ZIP_FILE}"

# Create zip with only necessary files
zip -r "${ZIP_FILE}" "${FILES[@]}" \
    -x "*/.git*" \
    -x "*~" \
    -x "*.bak" \
    -x "*.swp" \
    -x "*/__pycache__/*"

echo "Created ${ZIP_FILE}"
echo "Contents:"
unzip -l "${ZIP_FILE}"
