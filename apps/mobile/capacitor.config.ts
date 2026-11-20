import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.pumice.mobile',
  appName: 'Pumice',
  webDir: 'dist',
  ios: { contentInset: 'never', scheme: 'Pumice' },
  android: { allowMixedContent: false },
};

export default config;
