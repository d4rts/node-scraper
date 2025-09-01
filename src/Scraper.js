const Request = require('request');
const SocksProxyAgent = require('socks-proxy-agent');

const Utils = require('./Utils');
const ScraperPlaywright = require('./ScraperPlaywright');
const Seed = require('./Seed');
const SeedElement = require('./SeedElement');

const ScraperRequest = require('./Request');

/**
 * @callback DownloadedCallback
 *  @param {string} content
 *  @param {{Object<string, *>} customParams
 *  @returns {void|null}
 */

/**
 * @callback ExceptionCallback
 *  @param {Error|string} err - ErrorOccured from DownloadedCallback
 *  @param {import('./Request')} scraperRequest - ScraperRequest
 */

/**
 * @callback EndCallback
 */

class Scraper {
  constructor() {
    this.usePlaywright = false;
    this.playwrightWorkingDir = null;
    this.logStandartTty = true;
    this.logErrorsTty = true;

    this.seed = new Seed(this.logStandartTty, this.logErrorsTty);

    this.maxPoolSocket = 50;
    this.maxTreatmentPool = 200;

    /** @type {EndCallback|null} */
    this.endCallback = null;

    /** @type {ExceptionCallback|null} */
    this.exceptionCallback = null;

    /** @type {DownloadedCallback|null} */
    this.globalRequestCallback = null;

    this.agentOptions = null;
    this.forceIpv4 = false;

    this.globalRequestParams = {
      type: 'GET',
      reinjectCookies: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.72 Safari/537.36'
      },
      postData: null,
      jsonData: null,
      followRedirects: true,
      timeout: 30000,
      forceSeed: false,
      proxy: {
        use: false,
        host: 'localhost',
        port: 9050,
        username: '',
        password: ''
      }
    };
    this.cookieJar = Request.jar();
    this._pw = null;
  }

  /**
   * @param {string} url
   * @param {DownloadedCallback} callback
   * @param {Object<string, *>} params - override Scraper.globalRequestParams
   * @param {Object<string, *>} customParams - Your custom params
   */
  addUrl(url, callback = null, params = {}, customParams = {}) {
    const scraperRequest = this._generateRequest(url, params);

    if (! callback) {
      callback = this.globalRequestCallback;
    }
    const seedElement = this._generateSeedElement(scraperRequest, callback, params, customParams);
    this.seed.push(seedElement);
  }

  start() {
      this._checkAndProcessSeed();
  }

  /**
   * @param {boolean} logStandartTty
   */
  setLogStandartTty(logStandartTty) {
    this.logStandartTty = logStandartTty;
    this.seed.logStandartTty = logStandartTty;
  }

  /**
   * @param {boolean} logErrorsTty
   */
  setLogErrorsTty(logErrorsTty) {
    this.logErrorsTty = logErrorsTty;
    this.seed.logErrorsTty = logErrorsTty;
  }

  _checkAndProcessSeed() {
    let seedElement = null;
    while (
        this.seed.treatingLength() < this.maxTreatmentPool &&
        (seedElement = this.seed.getWaitingForTreatment()) !== null
        ) {
      this._makeRequest(seedElement);
    }

    if (this.seed.waitingLength() === 0 && this.seed.treatingLength() === 0) {
      if (this.endCallback) this.endCallback();
    }
  }

  async _makeRequest(seedElement) {
    const instance = this;
    let options = {
      url     : seedElement.request.url,
      method  : seedElement.request.type,
      headers : seedElement.request.headers,
      timeout : seedElement.request.timeout,
      pool    : { maxSockets : this.maxPoolSocket }
    };

    if (seedElement.request.followRedirects) {
      options['followAllRedirects'] = true;
    }

    if (seedElement.request.reinjectCookies) {
      options['jar'] = this.cookieJar;
    }

    if (seedElement.request.jsonData) {
      options['json'] = seedElement.request.jsonData;
    }

    if (seedElement.request.postData) {
      options['formData'] = seedElement.request.postData;
    }

    if (seedElement.request.proxy.use) {
      options.agent = new SocksProxyAgent.SocksProxyAgent(
          "socks5://" + seedElement.request.proxy.host + ":" + seedElement.request.proxy.port
      );
    } else if (this.agentOptions) {
      options['agentOptions'] = this.agentOptions;
    }

    if (this.forceIpv4) {
      options['family'] = 4;
    }

    try {
      await Request(options, async function (err, res, body) {
        if (err) {
          Utils.printerr(err + " " + options.url, instance.logErrorsTty);
          instance.seed.treatingElementToWaiting(seedElement);
          instance._checkAndProcessSeed();
          return;
        }

        var prefix = "";
        //Cloudflare detection, if this.usePlayright is false, send an error
        try {
          if (ScraperPlaywright.isCloudflareChallenge(body, res.headers)) {
            if (!instance.usePlaywright) {
              if (instance.exceptionCallback) {
                instance.exceptionCallback(
                    new Error("Cloudflare Challenge detected, try with parameter playwright=true"),
                    seedElement.request
                );
              }
              Utils.printerr("Download KO(CloudFlare) : " + seedElement.request.url, instance.logErrorsTty);
              instance.seed.treatingElementToEnded(seedElement);
              instance._checkAndProcessSeed();
              return;
            }

            prefix = "(Playwright) ";
            if (null === instance._pw) {
              instance._pw = new ScraperPlaywright({
                timeoutMs: 60000,
                headless: true,
              });
            }
            const targetUrl = seedElement.request.url;
            const pwResult = await instance._pw.fetch(targetUrl, {
              headers: seedElement.request.headers,
              proxy: seedElement.request.proxy,
              userDataDir: instance.playwrightWorkingDir,
              timeoutMs: 60000,
              extraWaitMs: 3000,
              type: seedElement.request.type,
              jsonData: seedElement.request.jsonData,
              postData: seedElement.request.postData
            });

            body = (typeof pwResult === 'string') ? pwResult : pwResult.html;
            if (
                seedElement.request.reinjectCookies
                && instance.cookieJar
                && pwResult
                && Array.isArray(pwResult.cookies)
                && pwResult.cookies.length
            ) {
              const jarUrl = pwResult.finalUrl || targetUrl;
              for (const c of pwResult.cookies) {
                const cookieStr = `${c.name}=${c.value}; Path=/`;
                try {
                  instance.cookieJar.setCookie(cookieStr, jarUrl); // sync avec request.jar()
                } catch (e) {
                  Utils.printerr('[cookie inject error] ' + (e && e.message ? e.message : e), instance.logErrorsTty);
                }
              }
            }
          }
        } catch (e) {
          Utils.printerr('Playwright fallback failed: ' + (e && e.message ? e.message : e), instance.logErrorsTty);
          instance.seed.treatingElementToWaiting(seedElement);
          instance._checkAndProcessSeed();
          return;
        }

        Utils.print(prefix + "Download OK : " + seedElement.request.url, instance.logStandartTty);
        try {
          let ret = await seedElement.callback(body, seedElement.customParams);
          if (ret === false) {
            instance.seed.treatingElementToWaiting(seedElement);
            Utils.printerr("Error, retry later " + options.url, instance.logErrorsTty);
          } else {
            instance.seed.treatingElementToEnded(seedElement);
          }
        } catch (e) {
          instance.seed.treatingElementToEnded(seedElement);
          Utils.printerr(e, instance.logErrorsTty);
          if (instance.exceptionCallback) {
            instance.exceptionCallback(e, seedElement.request);
          }
        }
        instance._checkAndProcessSeed();
      });
    } catch (e) {
      Utils.printerr(e, instance.logErrorsTty);
      instance.seed.treatingElementToWaiting(seedElement);
    }
  }

  _generateRequest(url, params) {
    const scraperRequest = new ScraperRequest(url);

    scraperRequest.type = params && params.type
        ? params.type
        : this.globalRequestParams.type;

    scraperRequest.reinjectCookies = params && params.reinjectCookies
        ? params.reinjectCookies
        : this.globalRequestParams.reinjectCookies;

    scraperRequest.headers = this.globalRequestParams.headers;
    if (params && params.headers) {
      for (let key in params.headers) {
        scraperRequest.headers[key] = params.headers[key];
      }
    }

    scraperRequest.postData = params && params.postData
        ? params.postData
        : this.globalRequestParams.postData;

    scraperRequest.jsonData = params && params.jsonData
        ? params.jsonData
        : this.globalRequestParams.jsonData;

    scraperRequest.timeout = params && params.timeout
        ? params.timeout
        : this.globalRequestParams.timeout;

    scraperRequest.proxy = this.globalRequestParams.proxy;
    if (params && params.proxy) {
      if (params.proxy.use) {
        scraperRequest.proxy.use = params.proxy.use;
      }
      if (params.proxy.host) {
        scraperRequest.proxy.host = params.proxy.host;
      }
      if (params.proxy.port) {
        scraperRequest.proxy.port = params.proxy.port;
      }
      if (params.proxy.username) {
        scraperRequest.proxy.username = params.proxy.username;
      }
      if (params.proxy.password) {
        scraperRequest.proxy.password = params.proxy.password;
      }
    }
    return scraperRequest;
  }

  _generateSeedElement(scraperRequest, callback, params, customParams) {
    const seedElement = new SeedElement(scraperRequest)
    seedElement.callback = callback;
    seedElement.customParams = customParams;
    seedElement.forceSeed = params.forceSeed ? params.forceSeed : this.globalRequestParams.forceSeed;
    return seedElement;
  }
}

module.exports = Scraper;