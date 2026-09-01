'use strict';

const Homey = require('homey');
const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const gvCloud = require('./api/govee-api-v2');
const { GoveePollScheduler } = require('./lib/govee-poll-scheduler');
const { parseGoveeMqttMessage } = require('./lib/govee-mqtt');

class GoveeApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Govee App has been initialized');
    //Setup global jobs
    this.mqttClient=null;
    this.localApiClient=null;
    this.cloudApi=null;
    this._registeredGoveeFlowCards = new Set();
    //Create an event emitter to send received mqtt to the devices
    this.eventBus = new EventEmitter();
    this.pollScheduler = new GoveePollScheduler({
      setInterval: this.homey.setInterval.bind(this.homey),
      clearInterval: this.homey.clearInterval.bind(this.homey),
      logger: (message) => this.error(message),
    });

    // Initialize cloud API for app-level flow cards
    this.initCloudApi();

    // Listen for API key changes to reinitialize cloud API
    this._settingsListener = (key) => {
      if (key === 'api_key') {
        void this.reinitializeCloudConnections();
      }
    };
    this.homey.settings.on('set', this._settingsListener);

    // Register Dreamview toggle action card
    this._toggleDreamviewDevice = this.homey.flow.getActionCard('toggle-dreamview-device');
    this._toggleDreamviewDevice.registerRunListener(async (args) => {
      // args.state is the dropdown ID string directly (e.g., "on" or "off")
      return this.toggleDreamviewDevice(args.device, args.state);
    });
    this._toggleDreamviewDevice.registerArgumentAutocompleteListener('device', async (query, args) => {
      return this.getDreamviewDevices(query);
    });

    // Register BaseGroup toggle action card
    this._toggleGroupDevice = this.homey.flow.getActionCard('toggle-group-device');
    this._toggleGroupDevice.registerRunListener(async (args) => {
      return this.toggleVirtualDevice(args.device, args.state);
    });
    this._toggleGroupDevice.registerArgumentAutocompleteListener('device', async (query, args) => {
      return this.getVirtualDevicesBySkus(['BaseGroup'], query, 'Device Group');
    });

    // Register SameModeGroup toggle action card
    this._toggleSamemodelGroup = this.homey.flow.getActionCard('toggle-samemodel-group');
    this._toggleSamemodelGroup.registerRunListener(async (args) => {
      return this.toggleVirtualDevice(args.device, args.state);
    });
    this._toggleSamemodelGroup.registerArgumentAutocompleteListener('device', async (query, args) => {
      return this.getVirtualDevicesBySkus(['SameModeGroup'], query, 'Same-Model Group');
    });

    // Register Dreamview Scenes widget autocomplete for each scene slot (3 scenes per row)
    const dreamviewWidget = this.homey.dashboards.getWidget('dreamview-scenes');
    for (let i = 1; i <= 3; i++) {
      dreamviewWidget.registerSettingAutocompleteListener(`scene${i}`, async (query) => {
        return this.getDreamviewDevices(query);
      });
    }

    // Register Govee Groups widget autocomplete for each group slot (3 groups per row)
    const groupsWidget = this.homey.dashboards.getWidget('govee-groups');
    for (let i = 1; i <= 3; i++) {
      groupsWidget.registerSettingAutocompleteListener(`group${i}`, async (query) => {
        return this.getVirtualDevicesBySkus(['BaseGroup', 'SameModeGroup'], query, 'Group');
      });
    }

  }

  async onUninit() {
    this.pollScheduler?.stop();
    //We need to disconnect our hosts
    await this.disconnectMqttClient();
    if (this.localApiClient != null) {
      try {
        this.localApiClient.destroy();
      } catch (err) {
        this.error('Error cleaning up Local API client:', err.message);
      }
    }
    //Kill the eventbus, this prevents subscribed events from trying to fire while we are destroying hosts
    this.eventBus.removeAllListeners();
    this.log('Cleaned up open connections');
  }

  registerPollDevice(device, interval) {
    const data = device.getData();
    const key = `${device.goveedevicetype}:${data.mac || data.id}`;
    device._pollSchedulerKey = key;
    this.pollScheduler.register(key, () => device.refreshState(), interval);
  }

  unregisterPollDevice(device) {
    if (device._pollSchedulerKey) this.pollScheduler.unregister(device._pollSchedulerKey);
  }

  claimFlowRegistration(key) {
    if (this._registeredGoveeFlowCards.has(key)) return false;
    this._registeredGoveeFlowCards.add(key);
    return true;
  }

  releaseFlowRegistration(key) {
    this._registeredGoveeFlowCards.delete(key);
  }

  async reinitializeCloudConnections() {
    this.cloudApi = null;
    this.initCloudApi();
    const drivers = this.homey.drivers?.getDrivers?.() || {};
    await Promise.allSettled(Object.values(drivers).map((driver) => driver.reInit?.()));
    await this.disconnectMqttClient();
    if (this.eventBus.eventNames().length > 0) await this.setupMqttReceiver();
    this.log('Govee cloud connections reinitialized after API key update');
  }

  async disconnectMqttClient() {
    const client = this.mqttClient;
    this.mqttClient = null;
    if (!client) return;
    try {
      await new Promise((resolve) => client.end(true, {}, resolve));
    } catch (err) {
      this.error('Error cleaning up MQTT client:', err.message);
      try { client.destroy(); } catch (_error) { /* already closing */ }
    }
  }

  async setupMqttReceiver(){
    //We only need to do this once for cloud devices
    if(this.mqttClient!==null)
      return;
    const apiKey = this.homey.settings.get('api_key');
    if (!apiKey) {
      this.error('Cannot connect Govee MQTT: API key is not configured');
      return;
    }
    const emqx_url = 'mqtt.openapi.govee.com'; 

    const options = {  
        clean: true,  
        username: apiKey,
        password: apiKey,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
    }
    this.log('Connecting the mqtt broker for status updates');

    const connectUrl = 'mqtts://' + emqx_url  
    const client = mqtt.connect(connectUrl, options)
    client.on('connect', () => {  
      this.log('Connected to the mqtt broker.')  
      client.subscribe("GA/"+apiKey, (err) => {
          if (err) this.error('Failed to subscribe to Govee MQTT updates:', err.message);
          else this.log('Subscribed to Govee MQTT status updates');
      })  
    })
    client.on('error', (err) => this.error('Govee MQTT connection error:', err.message));
    client.on('offline', () => this.log('Govee MQTT connection is offline; reconnecting'));
    client.on('reconnect', () => this.log('Reconnecting to Govee MQTT'));
    this.mqttClient=client;
    this.mqttClient.on('message', (_topic, message) => {
      try {
        const payload = parseGoveeMqttMessage(message);
        this.log('Received a validated Govee MQTT device event');
        this.eventBus.emit('device_event_'+payload.device, payload);
      } catch (error) {
        this.error('Ignored invalid Govee MQTT message:', error.message);
      }
    })
  }

  /**
   * Initialize the cloud API client for app-level flow cards
   */
  initCloudApi() {
    const apiKey = this.homey.settings.get('api_key');
    if (apiKey) {
      this.cloudApi = new gvCloud.GoveeClient({ api_key: apiKey, log: (message) => this.log(message) });
      this.log('Cloud API initialized for app-level flow cards');
    }
  }

  /**
   * Get virtual devices of specific SKU types for autocomplete
   */
  async getVirtualDevicesBySkus(skus, query, description) {
    const apiKey = this.homey.settings.get('api_key');
    if (!apiKey) {
      throw new Error('Cloud API key not configured. Please add your Govee API key in the app settings.');
    }

    if (!this.cloudApi) {
      this.initCloudApi();
    }

    try {
      const response = await this.cloudApi.deviceList();
      return response.data
        .filter(device => skus.includes(device.sku))
        .filter(device => device.deviceName.toLowerCase().includes(query.toLowerCase()))
        .map(device => ({
          name: device.deviceName,
          description,
          id: device.device,
          sku: device.sku
        }));
    } catch (error) {
      this.error('Failed to fetch virtual devices:', error);
      throw new Error('Failed to fetch devices from Govee cloud. Please check your API key.');
    }
  }

  /**
   * Activate or deactivate any virtual device (group, scene) via cloud API
   */
  async toggleVirtualDevice(device, state) {
    const apiKey = this.homey.settings.get('api_key');
    if (!apiKey) {
      throw new Error('Cloud API key not configured. Please add your Govee API key in the app settings.');
    }

    if (!this.cloudApi) {
      this.initCloudApi();
    }

    const mode = state === 'on' ? 1 : 0;
    const action = state === 'on' ? 'activated' : 'deactivated';

    try {
      await this.cloudApi.devicesTurn(mode, device.sku, device.id);
      this.log(`Virtual device "${device.name}" ${action}`);
      return true;
    } catch (error) {
      this.error('Failed to toggle virtual device:', error);
      throw new Error(`Failed to ${state === 'on' ? 'activate' : 'deactivate'} device: ${error.message}`);
    }
  }

  /**
   * Get list of DreamViewScenic scenes from cloud API for autocomplete
   */
  async getDreamviewDevices(query) {
    const apiKey = this.homey.settings.get('api_key');
    if (!apiKey) {
      throw new Error('Cloud API key not configured. Please add your Govee API key in the app settings.');
    }

    if (!this.cloudApi) {
      this.initCloudApi();
    }

    try {
      const response = await this.cloudApi.deviceList();
      // Filter for DreamViewScenic virtual device groups
      const dreamviewScenes = response.data.filter(device => {
        return device.sku === 'DreamViewScenic';
      });

      // Filter by query and map to autocomplete format
      return dreamviewScenes
        .filter(device => device.deviceName.toLowerCase().includes(query.toLowerCase()))
        .map(device => ({
          name: device.deviceName,
          description: 'Dreamview Scene',
          id: device.device,
          sku: device.sku
        }));
    } catch (error) {
      this.error('Failed to fetch Dreamview scenes:', error);
      throw new Error('Failed to fetch Dreamview scenes from Govee cloud. Please check your API key.');
    }
  }

  /**
   * Activate or deactivate a Dreamview scene via cloud API
   */
  async toggleDreamviewDevice(device, state) {
    const apiKey = this.homey.settings.get('api_key');
    if (!apiKey) {
      throw new Error('Cloud API key not configured. Please add your Govee API key in the app settings.');
    }

    if (!this.cloudApi) {
      this.initCloudApi();
    }

    const mode = state === 'on' ? 1 : 0;
    const action = state === 'on' ? 'activated' : 'deactivated';

    try {
      await this.cloudApi.devicesTurn(mode, device.sku, device.id);
      this.log(`Dreamview scene "${device.name}" ${action}`);
      return true;
    } catch (error) {
      this.error('Failed to toggle Dreamview scene:', error);
      throw new Error(`Failed to ${state === 'on' ? 'activate' : 'deactivate'} scene: ${error.message}`);
    }
  }
}

module.exports = GoveeApp;
