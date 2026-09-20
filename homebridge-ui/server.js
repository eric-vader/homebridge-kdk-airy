/**
 * Server side of the settings page. The Homebridge UI starts this file as a child process while the page is open
 * and forwards the page's `homebridge.request('/discover')` calls to the handler.
 */
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';

import { handleDiscover } from './discover.js';

class KdkAirySettingsServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/discover', payload => handleDiscover(payload));
    this.ready();
  }
}

new KdkAirySettingsServer();
