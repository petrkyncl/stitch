#!/bin/sh
# Put back the keyboard the phone used before install.sh switched it to the Stitch keyboard.
set -e
ADB=${ADB:-adb}
cd "$(dirname "$0")"
[ -f .previous-ime ] || { echo "No saved keyboard (.previous-ime missing)"; exit 1; }
PREV=$(cat .previous-ime)
$ADB shell ime set "$PREV"
echo "Keyboard restored to $PREV"
