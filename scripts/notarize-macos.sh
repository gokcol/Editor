#!/bin/sh
# Use an existing Developer ID and notarytool Keychain profile. No key export.
set -eu
app=${1:?Usage: sh scripts/notarize-macos.sh APP OUTPUT_DIR IDENTITY PROFILE}
out=${2:?Missing output directory}
identity=${3:?Missing Developer ID identity}
profile=${4:?Missing Keychain profile}
app=$(cd "$(dirname "$app")" && pwd)/$(basename "$app")
mkdir -p "$out"
out=$(cd "$out" && pwd)
name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$app/Contents/Info.plist")
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
binary=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
case "$name" in 7TXT|Yedit) ;; *) echo 'Unexpected app name' >&2; exit 1 ;; esac
stem="${name}_${version}_universal"
dmg="$out/$stem.dmg"
zip="$out/$stem-notary.zip"
test ! -e "$dmg" && test ! -e "$zip"
stage=$(mktemp -d "$out/.stage-$name.XXXXXX")
mountpoint=
cleanup() {
    if [ -n "$mountpoint" ]; then hdiutil detach "$mountpoint" >/dev/null || true; fi
    rm -rf "$stage"
}
trap cleanup EXIT HUP INT TERM
accepted() {
    python3 - "$1" <<'PY'
import json, sys
with open(sys.argv[1]) as file:
    receipt = json.load(file)
print('Apple notarization:', receipt.get('status'), receipt.get('id'))
if receipt.get('status') != 'Accepted':
    raise SystemExit('Notarization was not accepted; publication stopped')
PY
}
lipo -verify_arch arm64 x86_64 "$app/Contents/MacOS/$binary"
echo "Signing $name $version with Developer ID"
codesign --force --options runtime --timestamp --sign "$identity" "$app"
codesign --verify --deep --strict "$app"
ditto -c -k --keepParent "$app" "$zip"
echo "Submitting $name app for notarization"
xcrun notarytool submit "$zip" --keychain-profile "$profile" --wait --timeout 30m --output-format json > "$out/$stem-app-notary.json"
accepted "$out/$stem-app-notary.json"
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
ditto "$app" "$stage/$name.app"
ln -s /Applications "$stage/Applications"
printf 'Drag %s.app into Applications.\n' "$name" > "$stage/Install.txt"
hdiutil create -volname "$name $version" -srcfolder "$stage" -format UDZO "$dmg"
codesign --force --timestamp --sign "$identity" "$dmg"
echo "Submitting $name disk image for notarization"
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait --timeout 30m --output-format json > "$out/$stem-dmg-notary.json"
accepted "$out/$stem-dmg-notary.json"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
hdiutil attach -readonly -nobrowse -plist "$dmg" > "$stage/mount.plist"
mountpoint=$(python3 - "$stage/mount.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as file:
    data = plistlib.load(file)
print(next(entry['mount-point'] for entry in data['system-entities'] if 'mount-point' in entry))
PY
)
{
    codesign --verify --deep --strict "$dmg"
    codesign --verify --deep --strict "$mountpoint/$name.app"
    codesign -dv --verbose=4 "$mountpoint/$name.app"
    lipo -verify_arch arm64 x86_64 "$mountpoint/$name.app/Contents/MacOS/$binary"
    xcrun stapler validate "$mountpoint/$name.app"
    xcrun stapler validate "$dmg"
    spctl --assess --type execute --verbose=2 "$mountpoint/$name.app"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
} > "$out/$stem-verification.txt" 2>&1
hdiutil detach "$mountpoint"
mountpoint=
(cd "$out" && shasum -a 256 "$stem.dmg" > "$stem.dmg.sha256")
echo "Verified signed and notarized package: $dmg"
