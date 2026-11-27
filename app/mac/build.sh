#!/bin/sh
#   OVIS_SIGN_IDENTITY   "Developer ID Application: …" to sign for distribution; ad hoc without it
#   OVIS_KEYCHAIN        the keychain holding that identity, when it is not the default one
#   OVIS_NOTARY_KEY      an App Store Connect API key (.p8) to notarize and staple the DMG, with
#   OVIS_NOTARY_KEY_ID   its key ID and
#   OVIS_NOTARY_ISSUER   its issuer ID
set -eu
cd "$(dirname "$0")"

version=${OVIS_MAC_VERSION:-1.0.0}
build=${OVIS_MAC_BUILD:-1}
app=build/Ovis.app
# numbers and dots only, as macOS takes a bundle's version: anything else would also break the sed below
for value in "$version" "$build"; do
  case $value in
    '' | .* | *. | *..* | *[!0-9.]*)
      echo "OVIS_MAC_VERSION and OVIS_MAC_BUILD take numbers and dots (1.2.3), not '$value'" >&2
      exit 1
      ;;
  esac
done
# the keychain as one argument, whatever its path holds
if [ -n "${OVIS_KEYCHAIN:-}" ]; then set -- --keychain "$OVIS_KEYCHAIN"; else set --; fi

swift build -c release --arch arm64 --arch x86_64
bin=$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)

rm -rf build
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" build/AppIcon.iconset
cp "$bin/OvisMac" "$app/Contents/MacOS/Ovis"
sed -e "s/@VERSION@/$version/" -e "s/@BUILD@/$build/" Info.plist > "$app/Contents/Info.plist"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" Resources/AppIcon-1024.png --out "build/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) Resources/AppIcon-1024.png --out "build/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns build/AppIcon.iconset -o "$app/Contents/Resources/AppIcon.icns"
cp -R Resources/ko.lproj "$app/Contents/Resources/"
cp Resources/carry-drafts.js "$app/Contents/Resources/"
cp Resources/title-bar.js "$app/Contents/Resources/"

if [ -n "${OVIS_SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --entitlements Ovis.entitlements "$@" --sign "$OVIS_SIGN_IDENTITY" "$app"
else
  codesign --force --entitlements Ovis.entitlements --sign - "$app"
fi
codesign --verify --strict "$app"

mkdir build/dmg
cp -R "$app" build/dmg/
ln -s /Applications build/dmg/Applications
hdiutil create -quiet -volname Ovis -srcfolder build/dmg -ov -format UDZO build/Ovis.dmg
rm -rf build/dmg

if [ -n "${OVIS_SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp "$@" --sign "$OVIS_SIGN_IDENTITY" build/Ovis.dmg
fi
if [ -n "${OVIS_NOTARY_KEY:-}" ]; then
  xcrun notarytool submit build/Ovis.dmg --key "$OVIS_NOTARY_KEY" --key-id "$OVIS_NOTARY_KEY_ID" --issuer "$OVIS_NOTARY_ISSUER" --wait
  xcrun stapler staple build/Ovis.dmg
  spctl --assess --type open --context context:primary-signature --verbose build/Ovis.dmg
fi
echo "built $(pwd)/build/Ovis.dmg"
