#!/bin/bash
# Compile GSettings schema for mouse-tail extension

# Navigate to the schemas directory
cd "$(dirname "$0")/schemas"

# Compile the schema
glib-compile-schemas .

echo "Schema compiled successfully!"
