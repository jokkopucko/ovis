#!/bin/bash
# The SSH path's emulator run: the fixture up (up.sh), the test-only keys authorized there, an Android
# emulator (one that runs is used as it is; else AVD is started headless and stopped at the end), and
# the instrumented tests SshFixtureTest and SshSetupFlowTest against it (Gradle's
# connectedDebugAndroidTest). With --bare, the bare fixture too (up-bare.sh) and the first install
# from the phone, whose time and installer lines land in $work/emulator-run.log.
#
#   AVD=ovis_phone_ssh scripts/fixtures/phone-ssh/emulator-run.sh [--bare]
#
# KEEP_FIXTURE=1 leaves the fixture containers up afterwards (to try the app by hand); down.sh stops
# them.
#
# Needs: Docker, the Android SDK (ANDROID_HOME, an AVD of an image with Google APIs), JDK 21
# (JAVA_HOME), and a build of the app's pages (docs/native-app.md, Build and install). The emulator
# reaches the fixture on this PC as 10.0.2.2. On a PC that others share, run it in a heavy slot
# (OVIS_HEAVY_CPUS is passed to Docker) and take turns for the emulator.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
work=${PHONE_SSH_WORK:-$HOME/.cache/ovis-tmp/phone-ssh}
avd=${AVD:-ovis_phone_ssh}
keys=$repo/app/android/app/src/test/resources/ssh-test-keys
sdk=${ANDROID_HOME:?ANDROID_HOME names the Android SDK}
adb=$sdk/platform-tools/adb
bare=0
[ "${1:-}" = --bare ] && bare=1
mkdir -p "$work"

started=0
cleanup() {
  if [ "$started" = 1 ]; then
    "$adb" emu kill >/dev/null 2>&1 || true
    wait "$emulator" 2>/dev/null || true
  fi
  [ "${KEEP_FIXTURE:-0}" = 1 ] || bash "$here/down.sh" >/dev/null
}
trap cleanup EXIT

bash "$here/up.sh"
# every test key but rsa-pem, which SshFixtureTest expects refused
bash "$here/authorize.sh" ovis-phone-ssh-fixture "$keys"/{ed25519,ed25519-pass,rsa-pass,rsa-pem-pass,ecdsa}.pub
args=(
  -Pandroid.testInstrumentationRunnerArguments.class=sh.ovis.app.SshFixtureTest,sh.ovis.app.SshSetupFlowTest
  -Pandroid.testInstrumentationRunnerArguments.sshHost=10.0.2.2
  -Pandroid.testInstrumentationRunnerArguments.sshPort=2290
)
if [ "$bare" = 1 ]; then
  bash "$here/up-bare.sh"
  args+=(-Pandroid.testInstrumentationRunnerArguments.bareSshPort=2291)
fi

if ! "$adb" devices | grep -q '^emulator-'; then
  "$sdk/emulator/emulator" -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect >"$work/emulator.log" 2>&1 &
  emulator=$!
  started=1
fi
# one that is still starting is waited for too, for as long as the boot below gets
timeout 300 "$adb" wait-for-device || { echo "emulator-run: no emulator came up in 5 minutes; see $work/emulator.log" >&2; exit 1; }
for _ in $(seq 300); do
  [ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  sleep 1
done
[ "$("$adb" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] || { echo "emulator-run: the emulator did not boot in 5 minutes" >&2; exit 1; }

# the setup screen's tests need its window in front: the display awake and no lock screen over it
"$adb" shell svc power stayon true
"$adb" shell input keyevent KEYCODE_WAKEUP
"$adb" shell wm dismiss-keyguard
# Espresso's own advice: no animations on the device under test
for scale in window_animation_scale transition_animation_scale animator_duration_scale; do "$adb" shell settings put global "$scale" 0; done
"$adb" logcat -c
status=0
(cd "$repo/app/android" && ./gradlew --no-daemon :app:connectedDebugAndroidTest "${args[@]}") || status=$?
"$adb" logcat -d -s OvisSshTest:I >"$work/emulator-run.log" || true
echo "emulator-run: tests exit $status; the test log is $work/emulator-run.log"
grep -E 'host key|signed in|installed in' "$work/emulator-run.log" || true
exit "$status"
