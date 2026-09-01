//A small rip from https://github.com/chris01b/Govee-API-Client/blob/master/index.js
//Seems like a good start for athe api client but is not complete and not published as npm package.
//All credits go to chris01b for this great start

//New API Implementation
//https://openapi.api.govee.com/router/api/v1/user/devices

const fetch = require('isomorphic-unfetch');
const { randomUUID } = require('node:crypto');
const { assertPowerCommandAllowed } = require('../lib/govee-device-quirks');

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class GoveeApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GoveeApiError';
    Object.assign(this, details);
  }
}

class GoveeClient {
  constructor(config) {
    this.api_key = config.api_key;
    this.basePath = "https://openapi.api.govee.com/router/api/v1";
    this.fetch = config.fetch || fetch;
    this.requestTimeoutMs = config.request_timeout_ms || 10000;
    this.maxRetries = config.max_retries ?? 2;
    this.wait = config.wait || wait;
    this.log = config.log || (() => {});
  }

  async request(endpoint = "", options = {}) {
    const url = this.basePath + endpoint;
    const headers = {
      'Govee-API-Key': this.api_key,
      'Content-type': 'application/json',
      ...(options.headers || {}),
    };
    const method = options.method || 'GET';
    const requestId = this.getRequestId(options.body);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let response;
      let data;
      try {
        this.log(`Govee API ${method} ${endpoint}`);
        response = await this.fetch(url, { ...options, headers, signal: controller.signal });
        data = await this.parseResponse(response);
      } catch (error) {
        const timedOut = error && error.name === 'AbortError';
        const wrapped = new GoveeApiError(
          timedOut ? `Govee API request timed out after ${this.requestTimeoutMs}ms` : `Govee API request failed: ${error.message}`,
          { code: timedOut ? 'GOVEE_TIMEOUT' : 'GOVEE_NETWORK_ERROR', requestId, cause: error },
        );
        if (attempt < this.maxRetries) {
          await this.wait(this.retryDelayMs(attempt));
          continue;
        }
        throw wrapped;
      } finally {
        clearTimeout(timeout);
      }

      const status = Number(response.status || 200);
      const apiCode = Number(data?.code);
      if (status >= 200 && status < 300 && apiCode === 200) return data;

      const retryable = RETRYABLE_STATUS_CODES.has(status) || apiCode === 429;
      if (retryable && attempt < this.maxRetries) {
        await this.wait(this.retryAfterMs(response, attempt));
        continue;
      }

      throw new GoveeApiError(data?.msg || `Govee API returned HTTP ${status}`, {
        status,
        code: Number.isFinite(apiCode) ? apiCode : undefined,
        requestId,
        retryable,
      });
    }
    throw new GoveeApiError('Govee API request exhausted retry attempts', { requestId });
  }

  getRequestId(body) {
    if (typeof body !== 'string') return undefined;
    try { return JSON.parse(body).requestId; } catch (_error) { return undefined; }
  }

  async parseResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (_error) {
      throw new GoveeApiError('Govee API returned a non-JSON response', { status: response.status });
    }
  }

  retryDelayMs(attempt) {
    return Math.min(8000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250);
  }

  retryAfterMs(response, attempt) {
    const retryAfter = response.headers?.get?.('retry-after');
    const seconds = Number(retryAfter);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : this.retryDelayMs(attempt);
  }

  ping() {
    let config = {
      method: 'GET'
    };
    return this.request("/ping", config);
  }

  deviceList() {
    let config = {
      method: 'GET'
    };
    return this.request("/user/devices", config);
  }

  deviceControl(body) {
    const config = {
      method: 'POST',
      body: JSON.stringify(body)
    }
    return this.request("/device/control", config);
  }

  postStateRequest(body) {
    const config = {
      method: 'POST',
      body: JSON.stringify(body)
    };
    return this.request('/device/state', config);
  }

  postDynamicScenesRequest(body) {
    const config = {
      method: 'POST',
      body: JSON.stringify(body)
    };
    return this.request('/device/scenes', config);
  }

  postDiyScenesRequest(body) {
    const config = {
      method: 'POST',
      body: JSON.stringify(body)
    };
    return this.request('/device/diy-scenes', config);
  }

  state(model, device) {
    return new Promise((resolve, reject) => {
        //console.log('attempt to retrieve state for device ['+device+':'+model+']');
        let params = {
          "requestId": randomUUID(),
          "payload": {
              "sku": model,
              "device": device
          }
        };
        this.postStateRequest(params).then(res => {
            resolve(res.payload);
        }).catch(e => {reject(e)});
    });
  }

  lightModes(model, device) {
    return new Promise((resolve, reject) => {
        //console.log('attempt to retrieve light modes for device ['+device+':'+model+']');
        let params = {
          "requestId": randomUUID(),
          "payload": {
              "sku": model,
              "device": device
          }
        };
        this.postDynamicScenesRequest(params).then(res => {
            resolve(res.payload);
        }).catch(e => {reject(e)});
    });
  }

  diyLightModes(model, device) {
    return new Promise((resolve, reject) => {
        //console.log('attempt to retrieve DiY light modes for device ['+device+':'+model+']');
        let params = {
          "requestId": randomUUID(),
          "payload": {
              "sku": model,
              "device": device
          }
        };
        this.postDiyScenesRequest(params).then(res => {
            resolve(res.payload);
        }).catch(e => {reject(e)});
    });
  }

  setSegmentColor(segment, color, model, device) {
    return new Promise((resolve, reject) => {
      let params = {
        "requestId": randomUUID(),
        "payload": {
          "sku": model,
          "device": device,
          "capability": {
            "type": "devices.capabilities.segment_color_setting",
            "instance": "segmentedColorRgb",
            "value": {
              "segment":segment,
              "rgb":color
            }
          }
        }
      }
      this.deviceControl(params).then(res => {
        resolve(res);
      }).catch(e => {reject(e)});
    });
  }

  setSegmentBrightness(segment, brightness, model, device) {
    return new Promise((resolve, reject) => {
      let params = {
        "requestId": randomUUID(),
        "payload": {
          "sku": model,
          "device": device,
          "capability": {
            "type": "devices.capabilities.segment_color_setting",
            "instance": "segmentedBrightness",
            "value": {
              "segment":segment,
              "brightness":brightness
            }
          }
        }
      }
      this.deviceControl(params).then(res => {
        resolve(res);
      }).catch(e => {reject(e)});
    });
  }

  setLightScene(scene, instance, model, device) {
    return new Promise((resolve, reject) => {
      //console.log('attempt to switch device ['+device+':'+model+'] to new mode: '+scene)
      let params = {
        "requestId": randomUUID(),
        "payload": {
          "sku": model,
          "device": device,
          "capability": {
            "type": "devices.capabilities.dynamic_scene",
            "instance": instance,
            "value": scene
            }
          }
        }
        this.deviceControl(params).then(res => {
          resolve(res);
        }).catch(e => {reject(e)});
      });
  }

    setTemperatureSettings(targetTemp, instance, model, device) {
    return new Promise((resolve, reject) => {
      //console.log('attempt to switch device ['+device+':'+model+'] to new mode: '+scene)
      let params = {
        "requestId": randomUUID(),
        "payload": {
          "sku": model,
          "device": device,
          "capability": {
            "type": "devices.capabilities.temperature_setting",
            "instance": instance,
            "value": {
                "temperature":targetTemp
            }
            }
          }
        }
        this.deviceControl(params).then(res => {
          resolve(res);
        }).catch(e => {reject(e)});
      });
  }

  setMode(scene, instance, model, device) {
    return new Promise((resolve, reject) => {
      //console.log('attempt to switch device ['+device+':'+model+'] to new mode: '+scene)
      let params = {
        "requestId": randomUUID(),
        "payload": {
          "sku": model,
          "device": device,
          "capability": {
            "type": "devices.capabilities.mode",
            "instance": instance,
            "value": scene
            }
          }
        }
        this.deviceControl(params).then(res => {
          resolve(res);
        }).catch(e => {reject(e)});
      });
  }

  setMusicMode(musicMode, sensitivity, model, device) {
    return new Promise((resolve, reject) => {
      //console.log('attempt to switch device ['+device+':'+model+'] to new mode: '+scene)
      let params = {
        "requestId": randomUUID(),
        "payload": {
          "sku": model,
          "device": device,
          "capability": {
            "type": "devices.capabilities.music_setting",
            "instance": "musicMode",
            "value": {
              "musicMode":musicMode,
              "sensitivity":sensitivity
            }
            }
          }
        }
        this.deviceControl(params).then(res => {
          resolve(res);
        }).catch(e => {reject(e)});
      });
  }

  setWorkMode(workMode, modeValue, model, device) {
    return new Promise((resolve, reject) => {
      //console.log('attempt to switch device ['+device+':'+model+'] to new mode: '+modeValue)
      let params = {
        "requestId": randomUUID(),
        "payload": {
          "sku": model,
          "device": device,
          "capability": {
            "type": "devices.capabilities.work_mode",
            "instance": "workMode",
            "value": {
              "workMode":workMode,
              "modeValue":modeValue
            }
            }
          }
        }
        this.deviceControl(params).then(res => {
          resolve(res);
        }).catch(e => {reject(e)});
      });
  }

  devicesTurn(mode, model, device) {
    try {
      assertPowerCommandAllowed(model, 'powerSwitch', mode);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      if ((mode != 1 && mode != 0)) {
        reject(new Error("Incorrect turn parameter"));
      } else {
        //console.log('attempt to switch device ['+device+':'+model+'] to new mode: '+mode)
        let params = {
          "requestId": randomUUID(),
          "payload": {
            "sku": model,
            "device": device,
            "capability": {
              "type": "devices.capabilities.on_off",
              "instance": "powerSwitch",
              "value": mode
            }
          }
        }
        this.deviceControl(params).then(res => {
          resolve(res);
        }).catch(e => {reject(e)});
      }
    });
  }
  
  devicesToggle(mode, instance, model, device) {
    return new Promise((resolve, reject) => {
      if ((mode != 1 && mode != 0)) {
        reject(new Error("Incorrect toggle parameter"));
      } else {
        //console.log('attempt to switch device ['+device+':'+model+'] to new mode: '+mode)
        let params = {
          "requestId": randomUUID(),
          "payload": {
            "sku": model,
            "device": device,
            "capability": {
              "type": "devices.capabilities.toggle",
              "instance": instance,
              "value": mode
            }
          }
        }
        this.deviceControl(params).then(res => {
          resolve(res);
        }).catch(res => reject(res));
      }
    });
  }
  
  devicesMode(mode, model, device) {
  return new Promise((resolve, reject) => {
      //console.log('attempt to switch device ['+device+':'+model+'] to new mode: '+mode)
      let params = {
        'device': device,
        'model': model,
        'cmd' : {
          'name': 'mode',
          'value': mode
        }
      };
      this.deviceControl(params).then(res => {
        resolve(res);
      }).catch(e => {reject(e)});
    });
  }
  
  range(instance, value, model, device) {
    return new Promise((resolve, reject) => {
      let params = {
        "requestId": randomUUID(),
        "payload": {
          "sku": model,
          "device": device,
          "capability": {
            "type": "devices.capabilities.range",
            "instance": instance,
            "value": value
          }
        }
      };
      this.deviceControl(params).then(res => {
        resolve(res);
      }).catch(e => {reject(e)});
    });
  }

  brightness(dim, model, device) {
    return new Promise((resolve, reject) => {
      if (dim < 0 | dim > 100) {
        reject(new Error("Incorrect dim level"));
      } else {
        //console.log('attempt dim device ['+device+':'+model+'] to new level: '+dim)
        let params = {
          "requestId": randomUUID(),
          "payload": {
            "sku": model,
            "device": device,
            "capability": {
              "type": "devices.capabilities.range",
              "instance": "brightness",
              "value": dim
            }
          }
        };
        this.deviceControl(params).then(res => {
          resolve(res);
        }).catch(e => {reject(e)});
      }
    });
  }

  //Ensure that the colortemp fits the range specified by the device properties
  colorTemp(colortemp, model, device) {
    return new Promise((resolve, reject) => {
        //console.log('attempt set color temp of device ['+device+':'+model+'] to new temp: '+colortemp)
        let params = {
          "requestId": randomUUID(),
          "payload": {
            "sku": model,
            "device": device,
            "capability": {
              "type": "devices.capabilities.color_setting",
              "instance": "colorTemperatureK",
              "value": colortemp
            }
          }
        };
        this.deviceControl(params).then(res => {
            resolve(res);
        }).catch(e => {reject(e)});
    });
  }

  //Color object needs to be hex to int converted
  color(color, model, device) {
    return new Promise((resolve, reject) => {
        //console.log('attempt set color of device ['+device+':'+model+'] to new color: '+JSON.stringify(color));
        let params = {
          "requestId": randomUUID(),
          "payload": {
            "sku": model,
            "device": device,
            "capability": {
              "type": "devices.capabilities.color_setting",
              "instance": "colorRgb",
              "value": color
            }
          }
        };
        this.deviceControl(params).then(res => {
          resolve(res);
        }).catch(e => {reject(e)});
    });
  }

}

exports.GoveeClient = GoveeClient;
exports.GoveeApiError = GoveeApiError;
