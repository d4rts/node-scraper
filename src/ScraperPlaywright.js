// ScraperPlaywright.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

class ScraperPlaywright {
    /**
     * @param {{
     *   timeoutMs?: number,           // délai max total par fetch (par défaut 60000)
     *   extraWaitMs?: number,         // micro-attente entre étapes (par défaut 3000)
     *   maxSteps?: number,            // itérations max (CF etc.) (par défaut 5)
     *   userAgent?: string,
     *   locale?: string,
     *   defaultProxy?: { use?: boolean, host?: string, port?: number, protocol?: 'socks5'|'http'|'https' },
     *   headless?: boolean,
     *   fastNavTimeoutMs?: number,    // délai court pour page.goto(..., waitUntil:'commit') (par défaut 8000)
     *   cfSettleTotalMs?: number,     // budget total pour la mini-boucle CF (par défaut 8000)
     *   blockResources?: Array<'image'|'font'|'media'|'stylesheet'|'other'>,
     *   blockTrackers?: boolean,      // bloque domaines analytics/ads connus
     *   userDataDirBase?: string
     * }} [opts]
     */
    constructor(opts) {
        opts = opts || {};
        this.defaultTimeoutMs   = (opts.timeoutMs  !== undefined) ? opts.timeoutMs  : 60000;
        this.defaultExtraWaitMs = (opts.extraWaitMs!== undefined) ? opts.extraWaitMs: 300;
        this.maxSteps           = (opts.maxSteps   !== undefined) ? opts.maxSteps   : 4;

        this.fastNavTimeoutMs   = (opts.fastNavTimeoutMs !== undefined) ? opts.fastNavTimeoutMs : 5000;
        this.cfSettleTotalMs    = (opts.cfSettleTotalMs  !== undefined) ? opts.cfSettleTotalMs  : 5000;

        this.userAgent = opts.userAgent || (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/126.0.0.0 Safari/537.36'
        );
        this.locale = opts.locale || 'fr-FR';
        this.defaultProxy = opts.defaultProxy || { use: false };
        this.headless = (opts.headless !== undefined) ? opts.headless : true;

        this.blockResources = Array.isArray(opts.blockResources)
            ? opts.blockResources
            : ['image', 'font', 'media', 'stylesheet'];
        this.blockTrackers = (opts.blockTrackers !== undefined) ? opts.blockTrackers : true;

        this.userDataDirBase = opts.userDataDirBase || process.cwd();

        /** @type {Map<string, import('playwright').BrowserContext>} */
        this._contexts = new Map(); // clé: host|proxy
        /** @type {Set<string>} */
        this._warmed = new Set();   // origin|proxy warmup fait
    }

    /** CF detection */
    static isCloudflareChallenge(html, headers) {
        if (!html) return false;
        let server = '';
        if (headers) server = String(headers.server || headers.Server || '').toLowerCase();
        return (
            /<title>\s*Just a moment/i.test(html) &&
            (html.includes('/cdn-cgi/challenge-platform/') ||
                html.includes('__cf_chl_') ||
                html.includes('cf_chl_')) &&
            (server.includes('cloudflare') || /noindex,nofollow/i.test(html))
        );
    }

    /**
     * Fetch via Playwright (GET + POST/PUT/PATCH/DELETE).
     * Réutilise un contexte persistant par hôte, bloque ressources lourdes/trackers,
     * nav commit-first + mini-boucle CF.
     */
    async fetch(url, opts) {
        opts = opts || {};
        let method    = (opts.type || 'GET').toUpperCase();
        const postData= opts.postData;
        const jsonData= opts.jsonData;

        const timeoutMs = (opts.timeoutMs  !== undefined) ? opts.timeoutMs  : this.defaultTimeoutMs;
        const waitMs    = (opts.extraWaitMs!== undefined) ? opts.extraWaitMs: this.defaultExtraWaitMs;
        const headersIn = opts.headers || {};
        const proxyCfg  = (opts.proxy && opts.proxy.use) ? opts.proxy : this.defaultProxy;

        // Normalise Capifrance: force /fr/
        const normalizedUrl = this._normalizeCapifranceUrl(url);

        const u = new URL(normalizedUrl);
        const origin = u.origin;
        const host   = u.hostname;
        const proxyServer = (proxyCfg && proxyCfg.use)
            ? ((proxyCfg.protocol || 'socks5') + '://' + proxyCfg.host + ':' + proxyCfg.port)
            : undefined;

        const context = await this._getOrCreateContext({
            host,
            origin,
            proxyServer,
            userDataDir: this._buildUserDataDir(opts.userDataDir, host, proxyServer),
            headers: headersIn
        });

        const page = await context.newPage();

        try {
            // 1) Warmup CF par origin une seule fois
            const warmKey = `${origin}|${proxyServer || ''}`;
            if (!this._warmed.has(warmKey)) {
                await this._gotoCommit(page, origin + '/', Math.min(this.fastNavTimeoutMs, timeoutMs));
                await this._cfSettle(page, Math.min(this.cfSettleTotalMs, timeoutMs), waitMs);
                this._warmed.add(warmKey);
            }

            // 2) GET rapide
            if (method === 'GET') {
                await this._gotoCommit(page, normalizedUrl, Math.min(this.fastNavTimeoutMs, timeoutMs));
                await this._cfSettle(page, Math.min(this.cfSettleTotalMs, timeoutMs), waitMs);
                const html = await page.content();
                const cookies = await context.cookies(page.url());
                const finalUrl = page.url();
                await page.close().catch(() => {});
                return { html, cookies, finalUrl };
            }

            // 3) Non-GET → exécution dans la page (même origin/fingerprint)
            if (new URL(page.url()).origin !== origin) {
                await this._gotoCommit(page, origin + '/fr/', Math.min(this.fastNavTimeoutMs, timeoutMs));
                await this._cfSettle(page, Math.min(this.cfSettleTotalMs, timeoutMs), waitMs);
            }

            // CSRF depuis DOM + cookies
            const csrf = await this._extractCsrf(page);

            const isJson = (jsonData != null);
            const hdrs = this._prepareBrowserSideHeaders(headersIn, isJson, csrf);

            const bodySerialized = isJson
                ? JSON.stringify({ ...(jsonData || {}), ...(csrf ? { _token: csrf } : {}) })
                : new URLSearchParams({ ...(postData || {}), ...(csrf ? { _token: csrf } : {}) }).toString();

            const postResult = await page.evaluate(async ({ url, method, headers, bodySerialized }) => {
                const r = await fetch(url, {
                    method,
                    headers,
                    body: bodySerialized,
                    credentials: 'include',
                    redirect: 'follow'
                });
                const text = await r.text();
                return { status: r.status, url: r.url, text };
            }, { url: normalizedUrl, method, headers: hdrs, bodySerialized });

            if (postResult.status >= 400) {
                throw new Error(`HTTP ${method} ${normalizedUrl} failed: ${postResult.status} ${postResult.text.slice(0, 300)}`);
            }

            const cookies = await context.cookies(postResult.url);
            await page.close().catch(() => {});
            return { html: postResult.text, cookies, finalUrl: postResult.url };

        } catch (e) {
            try { await page.close(); } catch (_) {}
            throw e;
        }
    }

    /** Ferme tous les contextes/browsers (à appeler en fin de job) */
    async closeAll() {
        const tasks = [];
        for (const [k, ctx] of this._contexts.entries()) {
            this._contexts.delete(k);
            tasks.push(ctx.close().catch(() => {}));
        }
        await Promise.allSettled(tasks);
    }

    // -------------------- Helpers perf / internals --------------------

    async _getOrCreateContext({ host, origin, proxyServer, userDataDir, headers }) {
        const key = `${host}|${proxyServer || ''}`;
        const existing = this._contexts.get(key);
        if (existing && !existing.isClosed?.()) return existing;
        if (existing) { try { await existing.close(); } catch {} this._contexts.delete(key); }

        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: this.headless,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-features=IsolateOrigins,site-per-process,Translate'
            ],
            proxy: proxyServer ? { server: proxyServer } : undefined,
            viewport: { width: 1366, height: 768 },
            locale: this.locale,
            userAgent: this.userAgent,
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block',
            extraHTTPHeaders: { 'Accept-Language': headers['Accept-Language'] || 'fr-FR,fr;q=0.9,en;q=0.8', ...this._withoutUaRo(headers) }
        });

        // Bloque ressources lourdes et trackers
        const blockedTypes = new Set(this.blockResources.map(x => x.toLowerCase()));
        const blockedHosts = this.blockTrackers ? [
            'www.google-analytics.com','ssl.google-analytics.com','analytics.google.com',
            'www.googletagmanager.com','stats.g.doubleclick.net','connect.facebook.net',
            'static.hotjar.com','cdn.segment.com','cdn.matomo.cloud','stats.grafana.org'
        ] : [];
        await context.route('**/*', (route) => {
            const req = route.request();
            const type = req.resourceType();
            const url  = req.url();
            if (blockedTypes.has(type)) return route.abort();
            if (this.blockTrackers && blockedHosts.some(h => url.includes(h))) return route.abort();
            // ne pas bloquer /cdn-cgi/* (Cloudflare)
            return route.continue();
        });

        context.setDefaultTimeout(Math.min(20000, this.defaultTimeoutMs));
        context.setDefaultNavigationTimeout(Math.min(20000, this.defaultTimeoutMs));

        this._contexts.set(key, context);
        return context;
    }

    async _gotoCommit(page, url, timeoutMs) {
        try {
            await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
        } catch (e) {
            // On tolère un timeout "commit" court : on enchaîne quand même (souvent CF répond lentement)
            if (!String(e).includes('Timeout')) throw e;
        }
    }

    async _cfSettle(page, totalMs, waitMs) {
        const deadline = Date.now() + totalMs;
        for (let i = 0; i < this.maxSteps; i++) {
            try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(1000, totalMs) }); } catch {}
            await page.waitForTimeout(Math.max(50, Math.min(waitMs, 600)));
            const [html, title] = await Promise.all([
                page.content().catch(() => ''),
                page.title().catch(() => '')
            ]);
            const stillCF = ScraperPlaywright.isCloudflareChallenge(html) || /Just a moment/i.test(title);
            if (!stillCF) return;
            if (Date.now() > deadline) return;
        }
    }

    async _extractCsrf(page) {
        const csrfFromDom = await page.evaluate(() => {
            const meta = document.querySelector('meta[name="csrf-token"], meta[name="_token"]');
            if (meta && meta.getAttribute('content')) return meta.getAttribute('content');
            const input = document.querySelector('input[name="_token"]');
            if (input && input.getAttribute('value')) return input.getAttribute('value');
            return null;
        });
        if (csrfFromDom) return csrfFromDom;
        const cookies = await page.context().cookies(page.url());
        const xsrf = cookies.find(c => /xsrf|csrf/i.test(c.name));
        return xsrf ? decodeURIComponent(xsrf.value) : null;
    }

    _withoutUaRo(h) {
        const out = { ...h };
        delete out['User-Agent']; delete out['user-agent'];
        delete out['Referer'];    delete out['referer'];
        delete out['Origin'];     delete out['origin'];
        return out;
    }

    _safe(s) { return String(s).replace(/[^a-z0-9.\-]+/gi, '_'); }

    _buildUserDataDir(userDataDirOpt, host, proxyServer) {
        const base = userDataDirOpt || this.userDataDirBase || process.cwd();
        const dir  = path.join(base, `.pw-${this._safe(host)}${proxyServer ? '-'+this._safe(proxyServer) : ''}`);
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        return dir;
    }

    _normalizeCapifranceUrl(u) {
        try {
            const url = new URL(u);
            if (url.hostname.endsWith('capifrance.fr') && !url.pathname.startsWith('/fr/')) {
                url.pathname = '/fr' + (url.pathname.startsWith('/') ? url.pathname : '/' + url.pathname);
            }
            return url.toString();
        } catch { return u; }
    }
}

module.exports = ScraperPlaywright;
