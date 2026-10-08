#!/bin/sh
# Build, install and enable Stitch Hands on the connected phone. Keeps every other enabled accessibility service.
set -e
ADB=${ADB:-adb}
SVC=dev.stitch.hands/dev.stitch.hands.HandsService
cd "$(dirname "$0")"
./gradlew --offline -q assembleDebug
$ADB install -r app/build/outputs/apk/debug/app-debug.apk >/dev/null
CUR=$($ADB shell settings --user 0 get secure enabled_accessibility_services | tr -d '\r')
case "$CUR" in
  *"$SVC"*) NEW="$CUR" ;;
  null|"") NEW="$SVC" ;;
  *) NEW="$CUR:$SVC" ;;
esac
# Replacing an APK unbinds its service; writing the list again binds it.
$ADB shell "settings --user 0 put secure enabled_accessibility_services '$(echo "$CUR" | sed "s#:*$SVC##")'"
$ADB shell "settings --user 0 put secure enabled_accessibility_services '$NEW'"
$ADB shell settings --user 0 put secure accessibility_enabled 1
# Samsung freezes idle background apps, which would stall the HTTP server.
$ADB shell dumpsys deviceidle whitelist +dev.stitch.hands >/dev/null
$ADB shell cmd appops set dev.stitch.hands RUN_ANY_IN_BACKGROUND allow
$ADB forward tcp:7912 tcp:7912 >/dev/null
sleep 1
curl -s -m 5 localhost:7912/ping && echo " Stitch Hands is running"
