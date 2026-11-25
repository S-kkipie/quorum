import type { CapacitorConfig } from '@capacitor/cli'

// This file configures the bundled first-run page only. Once a hub URL is stored, MainActivity builds its own
// CapConfig at runtime with server.url set to the hub (see MainActivity.java), so the web app runs from the hub
// origin with the Capacitor bridge injected there.
const config: CapacitorConfig = {
  appId: 'dev.quorum.app',
  appName: 'Quorum',
  webDir: 'www',
  android: {
    // The hub is plain http on a personal tailnet; see res/xml/network_security_config.xml.
    allowMixedContent: true,
  },
}

export default config
