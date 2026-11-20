#!/usr/bin/env bash
# Generates every app icon from pumice.svg. Needs rsvg-convert and ImageMagick (brew install
# librsvg imagemagick); iconutil is part of macOS.
set -euo pipefail
cd "$(dirname "$0")"
root=../..
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Variants: full-bleed square and circle (Android legacy icons), stone only (adaptive foreground).
sed 's|<rect x="100" y="100" width="824" height="824" rx="186"|<rect x="0" y="0" width="1024" height="1024" rx="180"|' pumice.svg >"$tmp/square.svg"
sed 's|<rect x="100" y="100" width="824" height="824" rx="186"|<rect x="0" y="0" width="1024" height="1024" rx="512"|' pumice.svg >"$tmp/round.svg"
# The adaptive icon's safe zone is the middle 61%: center the stone and size it to fit.
sed -e 's|<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>||' \
  -e 's|<g filter="url(#shadow)">|<g transform="translate(512 512) scale(1.05) translate(-530 -514)"><g filter="url(#shadow)">|' \
  -e 's|</svg>|</g></svg>|' pumice.svg >"$tmp/foreground.svg"

# Desktop (electron-builder reads build/icon.*)
desktop=$root/apps/desktop/build
rsvg-convert -w 1024 pumice.svg -o "$desktop/icon.png"
mkdir "$tmp/icon.iconset"
for s in 16 32 128 256 512; do
  rsvg-convert -w $s pumice.svg -o "$tmp/icon.iconset/icon_${s}x${s}.png"
  rsvg-convert -w $((s * 2)) pumice.svg -o "$tmp/icon.iconset/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$tmp/icon.iconset" -o "$desktop/icon.icns"
magick "$tmp/square.svg" -background none -define icon:auto-resize=256,128,64,48,32,16 "$desktop/icon.ico" 2>/dev/null ||
  { rsvg-convert -w 256 "$tmp/square.svg" -o "$tmp/ico.png" && magick "$tmp/ico.png" -define icon:auto-resize=256,128,64,48,32,16 "$desktop/icon.ico"; }

# Android launcher icons
res=$root/apps/mobile/android/app/src/main/res
for d in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  IFS=: read -r name legacy adaptive <<<"$d"
  rsvg-convert -w "$legacy" "$tmp/square.svg" -o "$res/mipmap-$name/ic_launcher.png"
  rsvg-convert -w "$legacy" "$tmp/round.svg" -o "$res/mipmap-$name/ic_launcher_round.png"
  rsvg-convert -w "$adaptive" "$tmp/foreground.svg" -o "$res/mipmap-$name/ic_launcher_foreground.png"
done
cat >"$res/values/ic_launcher_background.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#CB5F33</color>
</resources>
XML

# Web and mobile web bundle
for app in web mobile; do
  mkdir -p "$root/apps/$app/public"
  cp "$tmp/square.svg" "$root/apps/$app/public/favicon.svg"
done
echo "icons written"
