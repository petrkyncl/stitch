#!/bin/sh
# Extra Android emulators next to the USB phone, each with its own Stitch engine.
#   scripts/emulators.sh up [N]   boot N emulators (default 4), install Hands, start one engine per emulator
#   scripts/emulators.sh down     stop the engines and the emulators
#
# The emulators live on their own adb server (5038) and on console ports above adb's scan range (5555-5585),
# so the phone's adb server and engine never see them. Emulator i gets engine port 4410+2i (video +1),
# Hands on localhost:7921+i and scrcpy on 27191+i. Each engine keeps its own registry and runs under runs/devices/.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SDK=${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}
AVD=${AVD:-Pixel_9_Pro}
export ANDROID_ADB_SERVER_PORT=5038
# This adb server is for the emulators only: it must never claim the USB phone, or the two servers fight over it.
export ADB_LIBUSB_START_DETACHED=1
export PATH="$SDK/platform-tools:$PATH"
N=${2:-4}

case "$1" in
  up)
    adb start-server >/dev/null 2>&1
    i=0
    while [ $i -lt "$N" ]; do
      port=$((5600 + 2 * i))
      if ! adb devices | grep -q "emulator-$port"; then
        nohup "$SDK/emulator/emulator" -avd "$AVD" -read-only -port $port -no-boot-anim -no-snapshot -gpu host \
          >"/tmp/stitch-emulator-$port.log" 2>&1 </dev/null &
      fi
      i=$((i + 1))
    done
    i=0
    while [ $i -lt "$N" ]; do
      port=$((5600 + 2 * i)); serial=emulator-$port; dir="$ROOT/runs/devices/$serial"
      printf '%s: ' "$serial"
      until [ "$(adb -s $serial shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
      ANDROID_SERIAL=$serial HANDS_PORT=$((7921 + i)) NO_BUILD=1 sh "$ROOT/hands/install.sh" | tail -1
      mkdir -p "$dir/runs" "$dir/registry"
      if ! lsof -iTCP:$((4410 + 2 * i)) -sTCP:LISTEN >/dev/null 2>&1; then
        (cd "$dir" && ANDROID_SERIAL=$serial HANDS_PORT=$((7921 + i)) SCRCPY_PORT=$((27191 + i)) PORT=$((4410 + 2 * i)) STITCH_REGISTRY="$ROOT/registry" \
          nohup node --env-file-if-exists="$ROOT/.env" "$ROOT/src/server.mjs" >engine.log 2>&1 </dev/null &)
      fi
      echo "  engine on http://localhost:$((4410 + 2 * i))"
      i=$((i + 1))
    done
    ;;
  down)
    for p in $(lsof -tiTCP:4410-4499 -sTCP:LISTEN 2>/dev/null); do kill "$p" 2>/dev/null || true; done
    for s in $(adb devices | awk '/^emulator-/ {print $1}'); do adb -s "$s" emu kill >/dev/null 2>&1 || true; done
    ;;
  *) echo "usage: $0 up [N] | down"; exit 1 ;;
esac
