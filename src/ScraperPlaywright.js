const { chromium } = require('playwright');

class ScraperPlaywright {
    /**
     * @param {{
     *   timeoutMs?: number,
     *   extraWaitMs?: number,
     *   maxSteps?: number,
     *   userAgent?: string,
     *   locale?: string,
     *   defaultProxy?: { use?: boolean, host?: string, port?: number, protocol?: 'socks5'|'http'|'https' },
     *   headless?: boolean
     * }} [opts]
     */
    constructor(opts) {
        opts = opts || {};
        this.defaultTimeoutMs = (opts.timeoutMs !== undefined) ? opts.timeoutMs : 60000;
        this.defaultExtraWaitMs = (opts.extraWaitMs !== undefined) ? opts.extraWaitMs : 3000;
        this.maxSteps = (opts.maxSteps !== undefined) ? opts.maxSteps : 5;

        this.userAgent = opts.userAgent || (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/123.0.0.0 Safari/537.36'
        );
        this.locale = opts.locale || 'fr-FR';
        this.defaultProxy = opts.defaultProxy || { use: false };
        this.headless = (opts.headless !== undefined) ? opts.headless : true;
    }

    /**
     * @param {string} html
     * @param {Record<string,string>} [headers]
     * @returns {boolean}
     */
    static isCloudflareChallenge(html, headers) {
        if (!html) return false;
        var server = '';
        if (headers) {
            server = String(headers.server || headers.Server || '').toLowerCase();
        }
        return (
            /<title>\s*Just a moment/i.test(html) &&
            (html.indexOf('/cdn-cgi/challenge-platform/') !== -1 ||
                html.indexOf('__cf_chl_') !== -1 ||
                html.indexOf('cf_chl_') !== -1) &&
            (server.indexOf('cloudflare') !== -1 || /noindex,nofollow/i.test(html))
        );
    }

    /**
     * @param {string} url
     * @param {{
     *   timeoutMs?: number,
     *   extraWaitMs?: number,
     *   headers?: Record<string,string>,
     *   proxy?: { use?: boolean, host?: string, port?: number, protocol?: 'socks5'|'http'|'https' },
     *   userDataDir?: string
     * }} [opts]
     * @returns {Promise<{ html: string, cookies: Array<any>, finalUrl: string }>}
     */
    async fetch(url, opts) {
        opts = opts || {};
        const timeoutMs = (opts.timeoutMs !== undefined) ? opts.timeoutMs : this.defaultTimeoutMs;
        const extraWaitMs = (opts.extraWaitMs !== undefined) ? opts.extraWaitMs : this.defaultExtraWaitMs;
        const headers = opts.headers || {};
        const proxy = (opts.proxy && opts.proxy.use) ? opts.proxy : this.defaultProxy;
        const proxyServer = (proxy && proxy.use)
            ? ((proxy.protocol || 'socks5') + '://' + proxy.host + ':' + proxy.port)
            : undefined;

        const userDataDir = opts.userDataDir
            ? opts.userDataDir + "/" + ".pw-" + this._safeHost(url)
            : './.pw-' + this._safeHost(url);

        const ua = headers['User-Agent'] || this.userAgent;
        const acceptLang = headers['Accept-Language'] || 'fr-FR,fr;q=0.9,en;q=0.8';

        const deadline = Date.now() + timeoutMs;
        function timeLeft() { return Math.max(1, deadline - Date.now()); }

        const launchOptions = {
            headless: this.headless,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
            proxy: proxyServer ? { server: proxyServer } : undefined
        };

        const context = await chromium.launchPersistentContext(userDataDir, {
            ...launchOptions,
            viewport: { width: 1366, height: 768 },
            locale: this.locale,
            userAgent: ua,
            extraHTTPHeaders: { 'Accept-Language': acceptLang, ...headers }
        });

        const page = await context.newPage();

        try {
            // 1) goto initial pour éviter de planter sur redirections (net::ERR_ABORTED)
            try {
                await page.goto(url, { waitUntil: 'commit', timeout: timeLeft() });
            } catch (e) {
                if (String(e).indexOf('ERR_ABORTED') === -1) throw e;
            }

            // 2) boucle d’attente Cloudflare
            for (var step = 0; step < this.maxSteps; step++) {
                try { await page.waitForLoadState('networkidle', { timeout: Math.min(timeLeft(), 15000) }); }
                catch (_) {}
                await page.waitForTimeout(extraWaitMs);

                const htmlNow = await page.content();
                const titleNow = await page.title();
                const stillCF = ScraperPlaywright.isCloudflareChallenge(htmlNow) || /Just a moment/i.test(titleNow);

                if (! stillCF) {
                    const cookies = await context.cookies(page.url());
                    const finalUrl = page.url();

                    await page.close().catch(function() {});
                    await context.close().catch(function() {});
                    return { html: htmlNow, cookies, finalUrl };
                }

                if (timeLeft() <= 1) break;
                await page.waitForTimeout(1200);
            }

            // 3) tentative finale: reload léger
            try {
                await page.reload({ waitUntil: 'commit', timeout: timeLeft() });
                try { await page.waitForLoadState('networkidle', { timeout: Math.min(timeLeft(), 10000) }); } catch (_) {}
                await page.waitForTimeout(1200);
            } catch (_) {}

            const html = await page.content();
            const cookies = await context.cookies(page.url());
            const finalUrl = page.url();

            await page.close().catch(function() {});
            await context.close().catch(function() {});
            return { html, cookies, finalUrl };

        } catch (e) {
            try { await page.close(); } catch (_) {}
            try { await context.close(); } catch (_) {}
            throw e;
        }
    }

    _safeHost(u) {
        try { return new URL(u).hostname; } catch (_) { return 'default'; }
    }
}

module.exports = ScraperPlaywright;