import type { Platform, Shell } from '@pumice/platform';
import { defineService } from '../service';

/** Raw platform access. Requires the `platform` permission; meant for core infrastructure plugins. */
export const PlatformService = defineService<Platform>('kernel.platform');

/** Opening URLs and revealing files in the OS. Requires the `shell` permission. */
export const ShellService = defineService<Shell>('kernel.shell');
