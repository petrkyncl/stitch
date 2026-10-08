#!/bin/sh
# Build, install and enable Stitch Hands on the connected phone. Keeps every other enabled accessibility service.
set -e
ADB=${ADB:-adb}
SVC=dev.stitch.hands/dev.stitch.hands.HandsService
cd "$(dirname "$0")"
# NO_BUILD=1 installs the APK that is already built (extra devices next to the phone).
[ -n "$NO_BUILD" ] || ./gradlew --offline -q assembleDebug
$ADB install -r app/build/outputs/apk/debug/app-debug.apk >/dev/null
CUR=$($ADB shell settings --user 0 get secure enabled_accessibility_services | tr -d '\r')
case "$CUR" in
  *"$SVC"*) NEW="$CUR" ;;
  null|"") NEW="$SVC" ;;
  *) NEW="$CUR:$SVC" ;;
esac
# Replacing an APK unbinds its service and Android may mark it crashed; stop the process, then write the list
# without and with the service so it binds fresh.
$ADB shell am force-stop dev.stitch.hands
$ADB shell "settings --user 0 put secure enabled_accessibility_services '$(echo "$CUR" | sed "s#:*$SVC##")'"
sleep 1
$ADB shell "settings --user 0 put secure enabled_accessibility_services '$NEW'"
$ADB shell settings --user 0 put secure accessibility_enabled 1
# Samsung freezes idle background apps, which would stall the HTTP server.
$ADB shell dumpsys deviceidle whitelist +dev.stitch.hands >/dev/null
$ADB shell cmd appops set dev.stitch.hands RUN_ANY_IN_BACKGROUND allow
# The agent types through its own keyboard. Remember the person's keyboard once, so restore-keyboard.sh can put it back.
IME=dev.stitch.hands/.StitchKeyboard
PREV=$($ADB shell settings --user 0 get secure default_input_method | tr -d '\r')
if [ "$PREV" != "$IME" ] && [ ! -f .previous-ime ]; then echo "$PREV" > .previous-ime; fi
$ADB shell ime enable $IME >/dev/null
$ADB shell ime set $IME >/dev/null
PORT=${HANDS_PORT:-7912}
$ADB forward tcp:$PORT tcp:7912 >/dev/null
sleep 1
curl -s -m 5 localhost:$PORT/ping && echo " Stitch Hands is running"
