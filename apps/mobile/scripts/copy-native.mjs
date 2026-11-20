// Copies the native plugin sources (native/) into the generated platform projects.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const copies = [
  [
    'native/android/PumiceFsPlugin.kt',
    'android/app/src/main/java/app/pumice/mobile/PumiceFsPlugin.kt',
    'android',
  ],
  ['native/ios/PumiceFsPlugin.swift', 'ios/App/App/PumiceFsPlugin.swift', 'ios'],
];
for (const [from, to, platform] of copies) {
  if (!existsSync(join(root, platform))) continue;
  mkdirSync(dirname(join(root, to)), { recursive: true });
  copyFileSync(join(root, from), join(root, to));
  console.log(`copied ${from} → ${to}`);
}
