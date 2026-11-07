'use strict';

// Coffee Link HTTP protocol client: original implementation for ioBroker.coffeelink.
// Talks to Gigya and Ayla directly. No dependency on another ioBroker adapter.
// The authentication endpoints and public mobile-client identifiers are unofficial
// and may change without notice.

const ENDPOINTS = Object.freeze({
    gigyaLogin: 'https://accounts.eu1.gigya.com/accounts.login',
    gigyaJwt: 'https://accounts.eu1.gigya.com/accounts.getJWT',
    aylaLogin: 'https://user-field-eu.aylanetworks.com/api/v1/token_sign_in',
    aylaApi: 'https://ads-eu.aylanetworks.com/apiv1',
});

// These are application identifiers used by the public Coffee Link mobile app;
// they are NOT individual users' account credentials.
const APP = Object.freeze({
    gigyaApiKey: '3_e5qn7USZK-QtsIso1wCelqUKAK_IVEsYshRIssQ-X-k55haiZXmKWDHDRul2e5Y2',
    aylaAppId: 'DLonghiCoffeeIdKit-sQ-id',
    aylaAppSecret: 'DLonghiCoffeeIdKit-HT6b0VNd4y6CSha9ivM5k8navLw',
});

class CoffeeCloudError extends Error {
    constructor(stage, description) {
        super(`${stage}: ${description}`);
        this.name = 'CoffeeCloudError';
    }
}

class CoffeeCloudClient {
    constructor({ email, password, fetchFn = globalThis.fetch, timeoutMs = 15000 }) {
        this.email = email;
        this.password = password;
        this.fetchFn = fetchFn;
        this.timeoutMs = timeoutMs;
        this.accessToken = null;
        this.expiresAt = 0;
    }

    async #request(stage, url, { method = 'GET', form, json, authorized = false, bearerToken = '' } = {}) {
        const headers = { accept: 'application/json' };
        let body;
        if (form) {
            headers['content-type'] = 'application/x-www-form-urlencoded';
            body = new URLSearchParams(form).toString();
        }
        if (json) {
            headers['content-type'] = 'application/json';
            body = JSON.stringify(json);
        }
        if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
        if (authorized) {
            if (!this.accessToken) throw new CoffeeCloudError(stage, 'missing access token');
            headers.authorization = `auth_token ${this.accessToken}`;
        }

        let response;
        try {
            response = await this.fetchFn(url, {
                method,
                headers,
                body,
                redirect: 'error',
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch {
            // Never include URLs, request bodies, responses or tokens in errors/logs.
            throw new CoffeeCloudError(stage, 'request failed or timed out');
        }
        if (!response.ok) {
            throw new CoffeeCloudError(stage, `HTTP ${response.status}`);
        }
        try {
            return await response.json();
        } catch {
            throw new CoffeeCloudError(stage, 'invalid JSON response');
        }
    }

    async login() {
        if (!this.email || !this.password) {
            throw new CoffeeCloudError('login', 'missing account configuration');
        }
        const result = await this.#request('Gigya login', ENDPOINTS.gigyaLogin, {
            method: 'POST',
            form: {
                apiKey: APP.gigyaApiKey,
                loginID: this.email,
                password: this.password,
                include: 'profile,id_token,data,preferences',
                targetEnv: 'mobile',
                sessionExpiration: '3600',
                httpStatusCodes: 'true',
            },
        });
        if (result.errorCode !== 0 || !result.sessionInfo?.sessionToken || !result.sessionInfo?.sessionSecret) {
            const code = Number.isInteger(result.errorCode) ? ` (code ${result.errorCode})` : '';
            throw new CoffeeCloudError('Gigya login', `login rejected${code}`);
        }
        const jwtResponse = await this.#request('Gigya JWT', ENDPOINTS.gigyaJwt, {
            method: 'POST',
            form: {
                apiKey: APP.gigyaApiKey,
                secret: result.sessionInfo.sessionSecret,
                expiration: '3600',
                httpStatusCodes: 'true',
            },
            bearerToken: result.sessionInfo.sessionToken,
        });
        if (jwtResponse.errorCode && jwtResponse.errorCode !== 0) {
            throw new CoffeeCloudError('Gigya JWT', `request rejected (code ${jwtResponse.errorCode})`);
        }
        if (!jwtResponse.id_token) {
            throw new CoffeeCloudError('Gigya JWT', 'missing identity token');
        }
        const ayla = await this.#request('Ayla login', ENDPOINTS.aylaLogin, {
            method: 'POST',
            json: {
                app_id: APP.aylaAppId,
                app_secret: APP.aylaAppSecret,
                token: jwtResponse.id_token,
            },
        });
        if (typeof ayla.access_token !== 'string' || !ayla.access_token) {
            throw new CoffeeCloudError('Ayla login', 'missing access token');
        }
        this.accessToken = ayla.access_token;
        // Reauthenticate well before the short-lived token expires.
        this.expiresAt = Date.now() + Math.max(300, Math.min(3000, Number(ayla.expires_in) || 3000)) * 1000;
    }

    async #authorizedGet(stage, url) {
        if (!this.accessToken || Date.now() >= this.expiresAt) await this.login();
        try {
            return await this.#request(stage, url, { authorized: true });
        } catch (error) {
            if (error instanceof CoffeeCloudError && error.message === `${stage}: HTTP 401`) {
                // A single retry on expired/revoked token. Do not loop on bad credentials.
                this.accessToken = null;
                await this.login();
                return await this.#request(stage, url, { authorized: true });
            }
            throw error;
        }
    }

    async listDevices() {
        const devices = await this.#authorizedGet('devices', `${ENDPOINTS.aylaApi}/devices.json`);
        if (!Array.isArray(devices)) throw new CoffeeCloudError('devices', 'invalid device list');
        return devices.map(item => item?.device).filter(d => d && typeof d.dsn === 'string');
    }

    async readProperties(dsn) {
        if (typeof dsn !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(dsn)) {
            throw new CoffeeCloudError('properties', 'invalid device identifier');
        }
        const data = await this.#authorizedGet(
            'properties', `${ENDPOINTS.aylaApi}/dsns/${encodeURIComponent(dsn)}/properties.json`);
        if (!Array.isArray(data)) throw new CoffeeCloudError('properties', 'invalid properties list');
        return new Map(data.filter(x => x?.property && typeof x.property.name === 'string')
            .map(x => [x.property.name, x.property]));
    }
}

module.exports = { CoffeeCloudClient, CoffeeCloudError };
