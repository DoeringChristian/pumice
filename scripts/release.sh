#!/usr/bin/env bash
# Builds the macOS app (arm64 + x64, unsigned) and the Android debug APK, publishes them as a
# GitHub release for the version in apps/desktop/package.json, and prints the cask checksums.
# Usage: scripts/release.sh   (needs gh, npm, and for Android: JAVA_HOME + ANDROID_HOME)
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./apps/desktop/package.json').version")
out="apps/desktop/release/$version"

npm ci
[ -d vendor/excalidraw/packages/excalidraw/dist ] || npm run build:excalidraw
(cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-vite build &&
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --x64 --publish never)

# The unpacked apps are only a build step; left in place, Spotlight lists each as another Pumice.
rm -rf "$out"/mac "$out"/mac-arm64
touch apps/desktop/release/.metadata_never_index

assets=("$out"/Pumice-"$version"-mac-*.dmg "$out"/Pumice-"$version"-mac-*.zip "$out"/latest-mac.yml)
if [ -n "${ANDROID_HOME:-}" ]; then
  npm run android:apk -w @pumice/mobile
  cp apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk "$out/Pumice-$version-android-debug.apk"
  assets+=("$out/Pumice-$version-android-debug.apk")
fi

gh release create "v$version" "${assets[@]}" --title "Pumice $version" --generate-notes
echo "Update the cask (DoeringChristian/homebrew-pumice, Casks/pumice.rb): version and"
shasum -a 256 "$out"/Pumice-"$version"-mac-*.dmg
