'use strict';

const { Device } = require('homey');
const { parseGoveeRgbState, resolveHomeyColor } = require('../lib/govee-color');
const { GoveeCommandCoordinator } = require('../lib/govee-command-coordinator');
const { GoveeWarningRecovery } = require('../lib/govee-warning-recovery');
const { findCapabilityValue, nearlyEqual } = require('../lib/govee-state');
const {
  assertPowerCommandAllowed,
  exposesMasterPowerControl,
  usesOptimisticNightlightPower,
} = require('../lib/govee-device-quirks');
const GoveeSharedDevice = require('./govee-shared-device');

class GoveeDevice extends Device {
  /**
   * onInit is called when the device is initialized.
   */
  async setupDevice() {
    this._commandCoordinator = this._commandCoordinator || new GoveeCommandCoordinator();
    this._warningRecovery = this._warningRecovery || new GoveeWarningRecovery();
    try {
      this._setupStage = 'device data';
      this.sharedDevice = new GoveeSharedDevice.SharedDevice();
      this.data = await this.getDeviceData();
      if (!Array.isArray(this.data.capabilitieslist)) this.data.capabilitieslist = [];
      this._setupStage = 'standard capabilities';
      await this.addRemoveStandardCapabilities();
      this._setupStage = 'dynamic capabilities and Flow cards';
      await this.sharedDevice.createDynamicCapabilities(this.data.model,this.data.mac,this.data.capabilitieslist,this);
      this._setupStage = 'capability cleanup';
      await this.cleanOldCapabilities();
      this._setupStage = 'capability listeners';
      await this.setupCapabilities();
      this._pendingFlowRegistrationClaims?.clear();
      this.log('govee.device.'+this.data.model+': '+this.data.name+' of type '+this.goveedevicetype+' has been setup');
      this._setupRetryCount = 0;
      await this.unsetWarning().catch(() => {});
      await this.setAvailable().catch(() => {});
      this.start_update_loop();
      try {
        await this.refreshState();
      } catch (error) {
        this.log(`Initial state refresh will retry through the scheduler: ${error.message}`);
      }
    } catch (err) {
      const message = `Setup failed during ${this._setupStage || 'initialization'}: ${err.message}`;
      this.error(message);
      for (const key of this._pendingFlowRegistrationClaims || []) this.homey.app.releaseFlowRegistration(key);
      this._pendingFlowRegistrationClaims?.clear();
      await this.setUnavailable(message).catch(() => {});
      this.scheduleSetupRetry();
    }
  }

  scheduleSetupRetry() {
    if (this._setupRetryTimer) return;
    this._setupRetryCount = (this._setupRetryCount || 0) + 1;
    const delay = Math.min(300000, 5000 * (2 ** Math.min(this._setupRetryCount - 1, 6)));
    this._setupRetryTimer = this.homey.setTimeout(() => {
      this._setupRetryTimer = null;
      void this.setupDevice();
    }, delay);
    this.log(`Device setup will retry in ${Math.round(delay / 1000)} seconds`);
  }

  async onUninit() {
    if (this._setupRetryTimer) this.homey.clearTimeout(this._setupRetryTimer);
    this.homey.app.unregisterPollDevice(this);
    // Unregister MQTT event listener
    if (this.sharedDevice) {
      this.sharedDevice.unregisterMqttEventListener(this);
    }
  }

  async getDeviceData()
  {
    //Lets get the device data object
    let deviceData = this.getData();
    //Lets check what version of the device we are working with
    let deviceVersion = await this.getStoreValue('deviceVersion');
    if(deviceVersion==='v2'){
      deviceData.capabilitieslist=await this.getStoreValue('capabilityList');
      //Update our settings based on current values in the device
      await this.setSettings({
        // only provide keys for the settings you want to change
        devicemodel: deviceData.model,
        devicecapabilities: JSON.stringify(deviceData.capabilitieslist)
      });
      this.setSettings
      return deviceData;
    }
    //Then its the old device, we need to map the capabilities
    //Lets retrieve the v2 capabilities of this device from the API
    var devicelist = await this.driver.api.deviceList();
    var thisdevice = devicelist.data.find(function(e) { return e.device === deviceData.mac })
    if(thisdevice!=null){
      this.log('Device '+deviceData.mac+' needs to be upgraded, retrieved its capabilities');
      this.log('Retrieved updated capability metadata for a legacy device');
      //Now make sure we store these, so we can consider the device upgraded
      this.setStoreValue('capabilityList',thisdevice.capabilities).catch(err => this.error('Failed to store capabilityList:', err.message));
      this.setStoreValue('deviceVersion','v2').catch(err => this.error('Failed to store deviceVersion:', err.message));
      deviceData.capabilitieslist=thisdevice.capabilities;
      //Update our settings based on current values in the device
      await this.setSettings({
        // only provide keys for the settings you want to change
        devicemodel: deviceData.model,
        devicecapabilities: JSON.stringify(deviceData.capabilitieslist)
      });
      this.setSettings
      return deviceData;
    }
    // Device not found in API list — return with empty capabilities so the update loop doesn't crash
    this.error('Device ' + deviceData.mac + ' not found in cloud API device list');
    deviceData.capabilitieslist = [];
    return deviceData;
  }

  start_update_loop() {
    let interval = this.homey.settings.get('poll_interval');
    if(interval < 60000)
    {
      this.log('Interval is not set or set to low, force 1 min');
      interval = 60000;
    }
    this.homey.app.registerPollDevice(this, interval);
  }

  async refreshState()
  {
    if (this._refreshPromise) return this._refreshPromise;
    if (!this.data) {
      throw new Error('Cannot refresh state: device data not initialized');
    }
    this._refreshPromise = this.performRefresh();
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  async performRefresh() {
    try {
      const currentState = await this.driver.deviceState(this.data.model, this.data.mac, this.data.type);
      const capabilities = currentState?.capabilitieslist;
      if (!Array.isArray(capabilities)) throw new Error('Govee returned an invalid capability state list');

      await this.sharedDevice.refreshDynamicCapabilities(currentState, this);
      const update = async (capability, value) => {
        if (value !== undefined && this.hasCapability(capability)) await this.setCapabilityValue(capability, value);
      };

      const online = findCapabilityValue(capabilities, 'online');
      if (online !== undefined) {
        await update('alarm_online.'+this.goveedevicetype, !Boolean(online));
        await update('alarm_connectivity', !Boolean(online));
      }
      const power = findCapabilityValue(capabilities, 'powerSwitch');
      await update('onoff', power === undefined ? undefined : Boolean(power));
      const oscillating = findCapabilityValue(capabilities, 'oscillationToggle');
      await update('oscillating', oscillating === undefined ? undefined : oscillating == 1);
      const brightness = findCapabilityValue(capabilities, 'brightness');
      if (Number.isFinite(brightness)) await update('dim', brightness / (brightness > 100 ? 255 : 100));

      const colorTemperature = findCapabilityValue(capabilities, 'colorTemperatureK');
      const colorTemperatureOptions = this.data.capabilitieslist.find((entry) => entry.instance === 'colorTemperatureK');
      if (this.hasCapability('light_temperature') && colorTemperature !== undefined && colorTemperatureOptions?.parameters?.range) {
        if (colorTemperature !== 0) {
          const { min, max } = colorTemperatureOptions.parameters.range;
          const percentage = Math.max(0, Math.min(1, 1 - ((colorTemperature - min) / (max - min))));
          await update('light_mode', 'temperature');
          await update('light_temperature', percentage);
        } else {
          await update('light_mode', 'color');
          await update('light_temperature', null);
        }
      }

      if (this.hasCapability('light_hue')) {
        const colorState = parseGoveeRgbState(capabilities, this.driver.colorCommandGetParser.bind(this.driver));
        if (colorState?.mode === 'color') {
          await update('light_mode', 'color');
          await update('light_saturation', colorState.saturation);
          await update('light_hue', colorState.hue);
        } else if (colorState?.mode === 'temperature') {
          await update('light_mode', 'temperature');
          await update('light_hue', null);
          await update('light_saturation', null);
        }
      }

      const targetTemperature = findCapabilityValue(capabilities, 'targetTemperature')
        ?? findCapabilityValue(capabilities, 'sliderTemperature');
      if (targetTemperature && Number.isFinite(targetTemperature.temperature)) {
        const celsius = targetTemperature.unit === 'Fahrenheit'
          ? (targetTemperature.temperature - 32) / 1.8
          : targetTemperature.temperature;
        await update('target_temperature', celsius);
      }
      const sensorTemperature = findCapabilityValue(capabilities, 'sensorTemperature');
      if (Number.isFinite(sensorTemperature)) await update('measure_temperature', (sensorTemperature - 32) / 1.8);
      const sensorHumidity = findCapabilityValue(capabilities, 'sensorHumidity');
      if (Number.isFinite(sensorHumidity)) await update('measure_humidity', sensorHumidity);
      else if (Number.isFinite(sensorHumidity?.currentHumidity)) await update('measure_humidity', sensorHumidity.currentHumidity);
      const targetHumidity = findCapabilityValue(capabilities, 'humidity');
      if (Number.isFinite(targetHumidity)) await update('target_humidity', targetHumidity / 100);

      this._refreshFailures = 0;
      await this.setAvailable().catch(() => {});
      if (this._warningRecovery?.consumeAfterSuccessfulRefresh()) {
        await this.unsetWarning().catch(() => {});
      }
      return currentState;
    } catch (error) {
      this._refreshFailures = (this._refreshFailures || 0) + 1;
      this.error(`State refresh failed (${this._refreshFailures}): ${error.message}`);
      if (this._refreshFailures >= 3) await this.setUnavailable(`Govee state refresh failed: ${error.message}`).catch(() => {});
      throw error;
    }
  }

  async refreshFreshState() {
    if (this._refreshPromise) await this._refreshPromise.catch(() => {});
    return this.refreshState();
  }

  async addRemoveStandardCapabilities()
  {
    //Now create/update the capabilities based on the device
    try {
      if(!this.hasCapability('alarm_online.'+this.goveedevicetype))
        await this.addCapability('alarm_online.'+this.goveedevicetype);
    } catch (err) {
      this.error('Failed to add alarm_online capability:', err.message);
    }
    try {
      if(!this.hasCapability('alarm_connectivity'))
        await this.addCapability('alarm_connectivity');
    } catch (err) {
      this.error('Failed to add alarm_connectivity capability:', err.message);
    }
    if(this.data.capabilitieslist.find(function(e) { return e.instance == "powerSwitch" })
      && exposesMasterPowerControl(this.data.model)) {
      if(!this.hasCapability('onoff'))
        await this.addCapability('onoff');
    } else if(this.hasCapability('onoff'))
      await this.removeCapability('onoff');  
    if(this.data.capabilitieslist.find(function(e) { return e.instance == "brightness" })) {
      if(!this.hasCapability('dim'))
        await this.addCapability('dim'); 
    } else if(this.hasCapability('dim'))
      await this.removeCapability('dim');    
    if(this.data.capabilitieslist.find(function(e) { return e.instance == "colorRgb" })) {
      if(!this.hasCapability('light_saturation'))
        await this.addCapability('light_saturation');    
      if(!this.hasCapability('light_hue'))
        await this.addCapability('light_hue');    
    } else {
      if(this.hasCapability('light_saturation'))
        await this.removeCapability('light_saturation');
      if(this.hasCapability('light_hue'))
        await this.removeCapability('light_hue');
    } 
    if(this.data.capabilitieslist.find(function(e) { return e.instance == "bodyAppearedEvent" })) {
      if(!this.hasCapability('alarm_presence'))
        await this.addCapability('alarm_presence');        
    } else {
      if(this.hasCapability('alarm_presence'))
        await this.removeCapability('alarm_presence');
    }

    if(this.data.capabilitieslist.find(function(e) {return e.instance == "colorTemperatureK" })) {
      if(!this.hasCapability('light_temperature'))
        await this.addCapability('light_temperature');
    } else if(this.hasCapability('light_temperature'))
      await this.removeCapability('light_temperature');  
    if(this.data.capabilitieslist.find(function(e) { return e.instance == "colorRgb" }) && this.data.capabilitieslist.find(function(e) {return e.instance == "colorTemperatureK" })) {
      if(!this.hasCapability('light_mode'))
        await this.addCapability('light_mode');
    } else if(this.hasCapability('light_mode'))
      await this.removeCapability('light_mode');
    
    //These are more likely to be appliance capabilities
    if(this.data.capabilitieslist.find(function(e) { return e.instance == "sensorTemperature" })) {
      if(!this.hasCapability('measure_temperature'))
        await this.addCapability('measure_temperature'); 
    } else if(this.hasCapability('measure_temperature'))
      await this.removeCapability('measure_temperature');
    if(this.data.capabilitieslist.find(function(e) { return e.instance == "sensorHumidity" })) {
      if(!this.hasCapability('measure_humidity'))
        await this.addCapability('measure_humidity'); 
    } else if(this.hasCapability('measure_humidity'))
      await this.removeCapability('measure_humidity');  
    //humidity target
    if(this.data.capabilitieslist.find(function(e) { return e.instance == "humidity" })) {
      this.log('Located the Target humidity capabilities')
      if(!this.hasCapability('target_humidity')) 
        await this.addCapability('target_humidity');
    } else if(this.hasCapability('target_humidity'))
      await this.removeCapability('target_humidity');
    //oscillationToggle
    if(this.data.capabilitieslist.find(function(e) { return e.instance == "oscillationToggle" })) {
      this.log('Located the oscillation capabilities')
      if(!this.hasCapability('oscillating')) 
        await this.addCapability('oscillating');
    } else if(this.hasCapability('oscillating'))
      await this.removeCapability('oscillating');
    //Thermostat support (targetTemperature or sliderTemperature)
    let tempInstance = this.data.capabilitieslist.find(function(e) {return e.instance == "targetTemperature"})
      || this.data.capabilitieslist.find(function(e) {return e.instance == "sliderTemperature"});
    if(tempInstance)
    {
      this.log('Located the '+tempInstance.instance+' capabilities')
      this.temperatureInstance = tempInstance.instance;
      if(!this.hasCapability('target_temperature')) {
        await this.addCapability('target_temperature');
      }
      let tempRange = tempInstance.parameters.fields.find(function(e) {return e.fieldName == "temperature" }).range;
      const thermostatOptions = {
        "min": tempRange.min,
        "max": tempRange.max,
        "step": tempRange.step
      }
      await this.setCapabilityOptions('target_temperature', thermostatOptions);
    } else if(this.hasCapability('target_temperature'))
      await this.removeCapability('target_temperature');
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   * That is a good moment to map the static device capabilities of Govee with the Homey capabilities
   */
  async onAdded() {
    this.log('govee.device.'+this.data.model+': '+this.data.name+' has been added');
    this.log('Lets connect capabilities:'+JSON.stringify(this.data.capabilitieslist));
    //Lets make the capabilities list more flexible, lets store it in the storevalues
    this.setStoreValue('capabilityList',this.data.capabilitieslist).catch(err => this.error('Failed to store capabilityList:', err.message));
    this.setStoreValue('deviceVersion','v2').catch(err => this.error('Failed to store deviceVersion:', err.message));
    //Lets create all its capabilities
    await this.addRemoveStandardCapabilities();
    //Now we need to link our capbilities with the ones we left or added
    await this.setupCapabilities();
  }

  async cleanOldCapabilities()
  {
    if(this.hasCapability('segmentControlColor'))
      await this.removeCapability('segmentControlColor');
    if(this.hasCapability('segmentControlBrightness'))
      await this.removeCapability('segmentControlBrightness');
    if(this.hasCapability('dreamViewToggle'))
      await this.removeCapability('dreamViewToggle');
    if(this.hasCapability('lightScenes'))
      await this.removeCapability('lightScenes');
    if(this.hasCapability('lightDiyScenes'))
      await this.removeCapability('lightDiyScenes');
    if(this.hasCapability('snapshots'))
      await this.removeCapability('snapshots');
    if(this.hasCapability('musicMode'))
      await this.removeCapability('musicMode');
    if(this.hasCapability('setHumidity.'+this.goveedevicetype))
      await this.removeCapability('setHumidity.'+this.goveedevicetype);
  }

  /**
   * Ensure we setup the listeners of the registered capabities.
   * Since we add capbilities based on the govee API this should create a full dynamic device
   */
  async setupCapabilities()
  {
    this.log('Now link capabilities with listeners');
    if (this.hasCapability('onoff'))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'onoff', this.onCapabilityOnoff.bind(this));
    if (this.hasCapability('dreamViewToggle.'+this.goveedevicetype))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'dreamViewToggle.'+this.goveedevicetype, this.onCapabilityDreamview.bind(this));
    if (this.hasCapability('gradientToggle.'+this.goveedevicetype))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'gradientToggle.'+this.goveedevicetype, this.onCapabilityGradient.bind(this));
    if (this.hasCapability('dim'))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'dim', this.onCapabilityDim.bind(this));
    if (this.hasCapability('light_temperature'))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'light_temperature', this.onCapabilityLightTemperature.bind(this));
    // Explicit listeners are required for capabilities added dynamically to
    // socket devices. A grouped listener can leave Homey without a handler.
    if (this.hasCapability('light_saturation'))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'light_saturation', this.onCapabilitySaturation.bind(this));
    if (this.hasCapability('light_hue'))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'light_hue', this.onCapabilityHue.bind(this));
    if (this.hasCapability('target_humidity'))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'target_humidity', this.onCapabilityTargetHumidity.bind(this));
    if (this.hasCapability('light_mode'))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'light_mode', this.onCapabilityLightMode.bind(this));
    if (this.hasCapability('lightScenes.'+this.goveedevicetype))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'lightScenes.'+this.goveedevicetype, this.onCapabilityLightScenes.bind(this));
    if (this.hasCapability('lightDiyScenes.'+this.goveedevicetype))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'lightDiyScenes.'+this.goveedevicetype, this.onCapabilityDIYLightScenes.bind(this));
    if (this.hasCapability('nightlightScenes.'+this.goveedevicetype))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'nightlightScenes.'+this.goveedevicetype, this.onCapabilityNightlightScenes.bind(this));
    if (this.hasCapability('oscillating'))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'oscillating', this.onCapabilityOscillating.bind(this));
    if (this.hasCapability('lackWater.'+this.goveedevicetype))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'lackWater.'+this.goveedevicetype, this.onLackWaterOnoff.bind(this));
    if (this.hasCapability('target_temperature'))
      this.sharedDevice.registerDynamicCapabilityListener(this, 'target_temperature', this.onCapabilityTargetTemperature.bind(this));

  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('govee.device.'+this.data.model+': '+this.data.name+' settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('govee.device.'+this.data.model+': '+this.data.name+' was renamed to '+name);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('govee.device.'+this.data.model+': '+this.data.name+' has been deleted');
    this.homey.app.unregisterPollDevice(this);
    if (this._setupRetryTimer) this.homey.clearTimeout(this._setupRetryTimer);
    // Unregister MQTT event listener
    if (this.sharedDevice) {
      this.sharedDevice.unregisterMqttEventListener(this);
    }
  }

  async onLackWaterOnoff( value, opts ) {
    this.setIfHasCapability('alarm_tank_empty', value);
  }

  async executeVerifiedCommand(label, send, verify, attempts = 2) {
    try {
      const result = await this._commandCoordinator.execute({
        label,
        send,
        read: () => this.refreshFreshState(),
        verify,
        attempts,
      });
      this._warningRecovery?.recordSuccess();
      await this.unsetWarning().catch(() => {});
      return result;
    } catch (error) {
      this._warningRecovery?.recordFailure(error);
      await this.setWarning(`${label} failed verification: ${error.message}`).catch(() => {});
      throw error;
    }
  }

  async executeSerializedCommand(label, send) {
    return this._commandCoordinator.execute({ label, send });
  }

  stateValue(currentState, instance) {
    return findCapabilityValue(currentState?.capabilitieslist, instance);
  }

    /**
   * Sets the target temperature of thermostat devices
   * @param {string} value the target temp value of the temperature within its defined range
   * @param {*} opts 
   */
  async onCapabilityTargetTemperature( value, opts ) {
    const instance = this.temperatureInstance || 'targetTemperature';
    await this.executeVerifiedCommand(
      'Target temperature',
      () => this.driver.setTargetTemperature(value, instance, this.data.model, this.data.mac, this.goveedevicetype),
      (state) => {
        const observed = this.stateValue(state, instance);
        if (!observed || !Number.isFinite(observed.temperature)) return false;
        const celsius = observed.unit === 'Fahrenheit' ? (observed.temperature - 32) / 1.8 : observed.temperature;
        return nearlyEqual(celsius, value, 0.6);
      },
    );
  }

  /**
   * Turns the device on or off based on the passed value
   * @param {string} value the 'on' or 'off' value of the device state
   * @param {*} opts 
   */
  async onCapabilityOnoff( value, opts ) {
    assertPowerCommandAllowed(this.data.model, 'powerSwitch', value);
    await this.executeVerifiedCommand(
      'Power command',
      () => this.driver.turn(value ? 1 : 0, this.data.model, this.data.mac, this.goveedevicetype),
      (state) => {
        const observed = this.stateValue(state, 'powerSwitch');
        return observed !== undefined && Boolean(observed) === Boolean(value);
      },
    );
  }

  async onCapabilityDreamview( value, opts ) {
    await this.executeVerifiedCommand(
      'DreamView command',
      () => this.driver.toggle(value ? 1 : 0, 'dreamViewToggle', this.data.model, this.data.mac, this.goveedevicetype),
      (state) => {
        const observed = this.stateValue(state, 'dreamViewToggle');
        return observed !== undefined && Boolean(observed) === Boolean(value);
      },
    );
  }

  async onCapabilityOscillating( value, opts ) {
    await this.executeVerifiedCommand(
      'Oscillation command',
      () => this.driver.toggle(value ? 1 : 0, 'oscillationToggle', this.data.model, this.data.mac, this.goveedevicetype),
      (state) => {
        const observed = this.stateValue(state, 'oscillationToggle');
        return observed !== undefined && Boolean(observed) === Boolean(value);
      },
    );
  }

  async onCapabilityNightlight( value, opts ) {
    if (usesOptimisticNightlightPower(this.data.model)) {
      await this.executeSerializedCommand(
        'Nightlight command',
        () => this.driver.toggle(value ? 1 : 0, 'nightlightToggle', this.data.model, this.data.mac, this.goveedevicetype),
      );
      await this.setCapabilityValue('nightlightToggle.'+this.goveedevicetype, Boolean(value));
      this.homey.setTimeout(() => {
        void this.refreshState().catch((error) => this.log(`Nightlight state reconciliation failed: ${error.message}`));
      }, 5000);
      return;
    }
    await this.executeVerifiedCommand(
      'Nightlight command',
      () => this.driver.toggle(value ? 1 : 0, 'nightlightToggle', this.data.model, this.data.mac, this.goveedevicetype),
      (state) => {
        const observed = this.stateValue(state, 'nightlightToggle');
        return observed !== undefined && Boolean(observed) === Boolean(value);
      },
    );
  }

  async onCapabilitySocketToggle(instance, value, opts) {
    await this.executeVerifiedCommand(
      `${instance} command`,
      () => this.driver.toggle(value ? 1 : 0, instance, this.data.model, this.data.mac, this.goveedevicetype),
      (state) => {
        const observed = this.stateValue(state, instance);
        return observed !== undefined && Boolean(observed) === Boolean(value);
      },
    );
  }

  async onCapabilityGradient( value, opts ) {
    await this.executeVerifiedCommand(
      'Gradient command',
      () => this.driver.toggle(value ? 1 : 0, 'gradientToggle', this.data.model, this.data.mac, this.goveedevicetype),
      (state) => {
        const observed = this.stateValue(state, 'gradientToggle');
        return observed !== undefined && Boolean(observed) === Boolean(value);
      },
    );
  }

  /**
   * Switches the device to a different light scene
   * @param {string} value the scene value of the device
   * @param {*} opts 
   */
    async onCapabilityLightScenes( value, opts ) {
      //We need to check if this device uses dynamic light scenes
      this.setWarning('Will switch to scene '+this.lightScenes.options[value].name);
      this.log('Mode switched to item '+value+' that results in scene '+JSON.stringify(this.lightScenes.options[value]));
      await this.executeSerializedCommand('Light scene command', () => this.driver.setLightScene(this.lightScenes.options[value].value, "lightScene", this.data.model, this.data.mac, this.goveedevicetype));
      this.unsetWarning();
    }

  /**
   * Switches the device to a new target humidity
   * @param {string} value the humidity target
   * @param {*} opts 
   */
  async onCapabilityTargetHumidity( value, opts ) {
    let perc_value = value*100;
    await this.executeVerifiedCommand(
      'Target humidity command',
      () => this.driver.range('humidity', perc_value, this.data.model, this.data.mac),
      (state) => nearlyEqual(Number(this.stateValue(state, 'humidity')), perc_value, 1),
    );
  }
  
  /**
   * Switches the device to a different DIY light scene
   * @param {string} value the scene value of the device
   * @param {*} opts 
   */
      async onCapabilityDIYLightScenes( value, opts ) {
        this.setWarning('Will switch to diy scene '+this.diyScenes.options[value].name);
        this.log('Mode switched to item '+value+' that results in diy scene '+JSON.stringify(this.diyScenes.options[value]));
        await this.executeSerializedCommand('DIY scene command', () => this.driver.setLightScene(this.diyScenes.options[value].value, "diyScene", this.data.model, this.data.mac, this.goveedevicetype));
        this.unsetWarning();
      }

  /**
   * Switches the device to a different nightlight scene
   * @param {string} value the scene value of the device
   * @param {*} opts 
   */
        async onCapabilityNightlightScenes( value, opts ) {
          const scene = this.nightlightScenes.options[value];
          this.log('Mode switched to item '+value+' that results in nightlight scene '+JSON.stringify(scene));
          await this.executeVerifiedCommand(
            'Nightlight scene command',
            () => this.driver.setMode(scene.value, 'nightlightScene', this.data.model, this.data.mac, this.goveedevicetype),
            (state) => JSON.stringify(this.stateValue(state, 'nightlightScene')) === JSON.stringify(scene.value),
          );
        }
  

  /**
   * Sets the device to the desired brightness level
   * @param {number} value a value between 0 and 100 to indicate the desired brightness level of the device
   * @param {*} opts 
   */
  async onCapabilityDim( value, opts ) {
    await this.executeVerifiedCommand(
      'Brightness command',
      () => this.driver.brightness(value, this.data.model, this.data.mac),
      (state) => {
        const observed = Number(this.stateValue(state, 'brightness'));
        if (!Number.isFinite(observed)) return false;
        return nearlyEqual(observed / (observed > 100 ? 255 : 100), value, 0.03);
      },
    );
  }

  /**
   * Sets the saturation value of the color
   * @param {number} value The percentage of the color saturation
   * @param {*} opts 
   */
  async onCapabilitySaturation( value, opts ) {
    const color = resolveHomeyColor({ saturation: value }, this.getState());
    var light = 1;
    this.log("Capability trigger: Saturation");
    await this.executeColorCommand(color, light);
  }

  /**
   * Sets the Hue of the color
   * @param {number} value The color in gradient value based on the color wheel of Homey
   * @param {*} opts 
   */
  async onCapabilityHue( value, opts ) {
    const color = resolveHomeyColor({ hue: value }, this.getState());
    var light = 1;
    this.log("Capability trigger: Hue");
    await this.executeColorCommand(color, light);
  }

  /**
   * Sets the Hue and Saturation of the color
   * @param {number} value The color in gradient value based on the color wheel of Homey
   * @param {*} opts 
   */
  async onCapabilityHueSaturation( newValues, opts ) {
    var light = 1;
    this.log("Capability trigger: Hue & Saturation [hue:"+newValues.light_hue+" - saturation: "+newValues.light_saturation);
    const color = resolveHomeyColor(
      {
        hue: newValues.light_hue,
        saturation: newValues.light_saturation,
      },
      this.getState(),
    );
    await this.executeColorCommand(color, light);
  }

  async executeColorCommand(color, light = 1) {
    await this.executeVerifiedCommand(
      'Color command',
      () => this.driver.color(color.hue, color.saturation, light, this.data.model, this.data.mac),
      (state) => {
        const observed = parseGoveeRgbState(state?.capabilitieslist, this.driver.colorCommandGetParser.bind(this.driver));
        if (observed?.mode !== 'color') return false;
        const hueDistance = Math.min(Math.abs(observed.hue - color.hue), 1 - Math.abs(observed.hue - color.hue));
        return hueDistance <= 0.03 && nearlyEqual(observed.saturation, color.saturation, 0.05);
      },
    );
  }

  /**
   * Sets the color temperature of the device
   * @param {number} value The color temperature in percentage of the range of the device
   * @param {*} opts 
   */
  async onCapabilityLightTemperature( value, opts ) {
    //If the capability colorTem is available, these properties should be also
    this.log("Capability trigger: Temperature: "+value);
    var colorTempOptions = this.data.capabilitieslist.find(function(e) {return e.instance == "colorTemperatureK" });
    let rangeMin = colorTempOptions.parameters.range.min;
    let rangeMax = colorTempOptions.parameters.range.max;
    var relativeColorTemp = rangeMax-((rangeMax-rangeMin)*value);
    if(value>=0)
    {
      await this.executeVerifiedCommand(
        'Color temperature command',
        () => this.driver.colorTemp(relativeColorTemp, this.data.model, this.data.mac),
        (state) => nearlyEqual(Number(this.stateValue(state, 'colorTemperatureK')), relativeColorTemp, 25),
      );
    }
  }

  /**
   * Sets the Light mode for color or temperature
   * @param {string} value The light mode from the enum color,temperature
   * @param {*} opts 
   */
  async onCapabilityLightMode( value, opts ) {
    this.log("Capability trigger: Switch light modes");
    this.setIfHasCapability('light_mode', value);
    // if(value=='temperature'){
    //   var colorTemp = this.getCapabilityValue('light_temperature');
    //   await this.onCapabilityLightTemperature(colorTemp);
    // } else if (value=='color'){
    //   var hue = this.getState().light_hue;  
    //   await this.onCapabilityHue(hue);
    // }
  }

  setIfHasCapability(cap, value) {
    if (this.hasCapability(cap)) {
      return this.setCapabilityValue(cap, value).catch(this.error)
    } 
    // else {
    //   this.log('Attempt to set cap ['+cap+'] on device '+this.data.model+':'+this.data.name+' but it is not available');
    // }
  }

}

module.exports = GoveeDevice;
