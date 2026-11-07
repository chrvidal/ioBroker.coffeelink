'use strict';
// Experimental, opt-in LAN transport. Registration changes the callback endpoint
// and can affect the official Coffee Link app. No beverage or settings commands.
const http = require('node:http');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { derive, decode, encode } = require('./lan-protocol');

const MAX_BODY = 256 * 1024;
const REG_TIMEOUT_MS = 5000;
const NUDGE_AFTER_MS = 25000;

// ECAM612.55 tested: native HTTP/1.1 POST with curl-style headers receives 202;
// undici/fetch receives 400 for the same JSON. Never disclose response bodies.
function postLocalRegistration({ machineIp, dsn, body, port = 80, timeoutMs = REG_TIMEOUT_MS }) {
    if (net.isIP(machineIp) !== 4 || !/^[A-Za-z0-9_-]{1,128}$/.test(dsn)) {
        throw new TypeError('Invalid LAN registration target');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid LAN port');
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: machineIp,
            port,
            path: `/local_reg.json?dsn=${encodeURIComponent(dsn)}`,
            method: 'POST',
            headers: {
                'User-Agent': 'curl/8.0.1',
                Accept: '*/*',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                Connection: 'close',
            },
            timeout: timeoutMs,
        }, res => {
            res.resume();
            res.once('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300 }));
            res.once('error', reject);
            res.once('aborted', () => reject(new Error('Connection aborted')));
        });
        req.once('error', reject);
        req.once('timeout', () => {
            const error = new Error('LAN registration timeout');
            error.name = 'TimeoutError';
            req.destroy(error);
        });
        req.end(payload);
    });
}

function ipOf(req) {
    const ip = req.socket.remoteAddress || '';
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
function pathname(raw) {
    try { return new URL(raw, 'http://internal.invalid').pathname; } catch { return ''; }
}
function reject(res, status) {
    if (!res.headersSent) res.writeHead(status, { 'cache-control': 'no-store' });
    res.end();
}
function json(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
}
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw Error('Request too large');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Different Ayla firmware versions send bulk, individual, and wrapped datapoints.
// Never retain raw packets: return only the named values required by counters.
function extractProperties(message) {
    const values = new Map();
    const add = (entry) => {
        const p = entry?.property && typeof entry.property === 'object' ? entry.property : entry;
        if (p && typeof p.name === 'string' && /^[a-zA-Z0-9_]{1,120}$/.test(p.name)
            && Object.hasOwn(p, 'value')) values.set(p.name, { name: p.name, value: p.value });
    };
    const scan = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        add(obj);
        if (Array.isArray(obj.properties)) for (const p of obj.properties) add(p);
    };
    scan(message);
    scan(message?.data);
    return values;
}

class CoffeeLanSession {
    constructor({ host, port, machineIp, registrationRequestFn = postLocalRegistration,
        onProperties = () => {}, onStatus = () => {}, onContact = () => {} }) {
        if (![host, machineIp].every(x => net.isIP(x) === 4) || host === '0.0.0.0' || host === '127.0.0.1') {
            throw Error('Active LAN requires specific non-loopback IPv4 addresses');
        }
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid LAN port');
        this.host = host;
        this.port = port;
        this.machineIp = machineIp;
        this.registrationRequestFn = registrationRequestFn;
        this.onProperties = onProperties;
        this.onStatus = onStatus;
        this.onContact = onContact;
        this.server = null;
        this.key = null;
        this.dsn = null;
        this.keys = null;
        this.registrationAttempted = false;
        this.registered = false;
        this.sequence = 0;
        this.queue = [];
        this.lastRequestedAt = 0;
        this.lastReceivedAt = '';
        this.lastExchangeAt = '';
        this.lastPollAt = '';
        this.lastPushAt = '';
        this.lastDecodedAt = '';
        this.lastError = '';
        this.lastNudgeStatus = '';
        this.exchangeCount = 0;
        this.pollCount = 0;
        this.pushCount = 0;
        this.decodedCount = 0;
        this.propertiesCount = 0;
        this.nudgeCount = 0;
        this.nudgeTimer = null;
        this.stopping = false;
    }
    configure({ dsn, key }) {
        if (typeof dsn !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(dsn) ||
            typeof key !== 'string' || !key || key.length > 256) throw Error('Invalid LAN configuration');
        this.dsn = dsn;
        this.key = key;
    }
    async start() {
        if (this.server) throw Error('LAN already started');
        this.stopping = false;
        this.server = http.createServer((req, res) => {
            void this.#handle(req, res).catch(() => {
                this.lastError = 'request-handler-failed';
                if (!res.writableEnded) reject(res, 400);
            });
        });
        this.server.requestTimeout = 5000;
        this.server.headersTimeout = 6000;
        this.server.maxRequestsPerSocket = 50;
        try {
            await new Promise((ok, fail) => {
                this.server.once('error', fail);
                this.server.listen(this.port, this.host, ok);
            });
        } catch (e) {
            this.server = null;
            throw Error(`LAN listen failed: ${e.code || 'unknown'}`);
        }
    }
    async stop() {
        this.stopping = true;
        if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
        this.nudgeTimer = null;
        const s = this.server;
        this.server = null;
        if (s?.listening) await new Promise(resolve => s.close(resolve));
        this.keys = null;
        this.key = null;
    }
    #registrationBody() {
        return { local_reg: { ip: this.host, notify: 0, port: this.port, uri: '/local_lan' } };
    }
    async registerOnce() {
        if (!this.server?.listening || !this.key || !this.dsn) throw Error('LAN session not ready');
        if (this.registrationAttempted) return;
        this.registrationAttempted = true;
        let response;
        try {
            response = await this.registrationRequestFn({
                machineIp: this.machineIp, dsn: this.dsn, body: this.#registrationBody(), timeoutMs: REG_TIMEOUT_MS,
            });
        } catch (error) {
            const code = error?.code || error?.cause?.code;
            const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
                ? 'register-timeout'
                : code === 'ECONNREFUSED' ? 'register-connection-refused'
                : code === 'ENETUNREACH' || code === 'EHOSTUNREACH' ? 'register-network-unreachable'
                : 'register-network-error';
            this.lastError = reason;
            this.onStatus(reason);
            return;
        }
        this.registered = response.ok;
        const code = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status : 'unknown';
        if (!response.ok) this.lastError = `register-http-${code}`;
        this.onStatus(response.ok ? 'registered' : `register-http-${code}`);
    }
    #scheduleProperties() {
        if (!this.keys || !this.dsn || Date.now() - this.lastRequestedAt < 30000 || this.queue.length) return;
        const cmd = { seq_no: String(this.sequence), data: { cmds: [{ cmd: {
            cmd_id: 1, data: '', method: 'GET', resource: "property.json?name=''",
            uri: '/local_lan/property/datapoint.json',
        } }] } };
        this.queue.push(cmd);
        this.lastRequestedAt = Date.now();
    }
    #poll(res) {
        this.pollCount++;
        this.lastPollAt = new Date().toISOString();
        if (!this.keys) { json(res, 200, { enc: '', sign: '', seq: this.sequence }); return; }
        this.#scheduleProperties();
        const current = this.sequence++;
        const data = this.queue.shift() || { seq_no: String(current), data: {} };
        data.seq_no = String(current);
        const encrypted = encode(JSON.stringify(data), this.keys.toMachineKey,
            this.keys.toMachineIv, this.keys.toMachineSign);
        this.keys.toMachineIv = encrypted.iv;
        json(res, 200, { enc: encrypted.enc, sign: encrypted.sign, seq: current });
    }
    #datapoint(body, res) {
        this.pushCount++;
        this.lastPushAt = new Date().toISOString();
        if (!this.keys || typeof body.enc !== 'string') {
            this.lastError = 'push-before-handshake-or-missing-enc';
            json(res, 200, {});
            return;
        }
        let decoded;
        try {
            decoded = decode(body.enc, this.keys.fromMachineKey, this.keys.fromMachineIv);
            this.keys.fromMachineIv = decoded.iv;
        } catch {
            // Never return 4xx to an already authenticated machine on decode error:
            // firmware may back off further datapoint pushes.
            this.lastError = 'decrypt-failed';
            json(res, 200, {});
            return;
        }
        let parsed;
        try { parsed = JSON.parse(decoded.plaintext); } catch {
            this.lastError = 'decoded-json-invalid';
            json(res, 200, {});
            return;
        }
        this.decodedCount++;
        this.lastDecodedAt = new Date().toISOString();
        const values = extractProperties(parsed);
        if (values.size > 0) {
            this.propertiesCount += values.size;
            this.lastReceivedAt = this.lastDecodedAt;
            try { this.onProperties(values, this.lastReceivedAt); } catch { this.lastError = 'on-properties-failed'; }
        } else {
            this.lastError = 'no-named-properties';
        }
        json(res, 200, {});
    }
    #scheduleOneNudge() {
        if (this.nudgeTimer || this.nudgeCount || !this.registered) return;
        this.nudgeTimer = setTimeout(async () => {
            this.nudgeTimer = null;
            if (this.stopping || !this.server?.listening || this.pollCount > 0 || !this.registered || this.nudgeCount) return;
            // One bounded registration reminder if machine exchanges keys but
            // never asks for commands. Not an unbounded polling loop.
            this.nudgeCount = 1;
            try {
                const answer = await this.registrationRequestFn({
                    machineIp: this.machineIp, dsn: this.dsn, body: this.#registrationBody(), timeoutMs: REG_TIMEOUT_MS,
                });
                this.lastNudgeStatus = answer.ok ? 'accepted' : `http-${answer.status || 'unknown'}`;
            } catch {
                this.lastNudgeStatus = 'network-error';
            }
        }, NUDGE_AFTER_MS);
        this.nudgeTimer.unref?.();
    }
    async #handle(req, res) {
        const path = pathname(req.url);
        if (req.method === 'GET' && path === '/health' && ipOf(req) === this.host) {
            json(res, 200, {
                listener: 'encrypted', registration: this.registered ? 'sent' : 'not-sent',
                connected: !!this.keys, lastReceivedAt: this.lastReceivedAt,
                exchangeCount: this.exchangeCount, pollCount: this.pollCount,
                pushCount: this.pushCount, decodedCount: this.decodedCount,
                propertiesCount: this.propertiesCount,
                lastExchangeAt: this.lastExchangeAt, lastPollAt: this.lastPollAt,
                lastPushAt: this.lastPushAt, lastDecodedAt: this.lastDecodedAt,
                lastError: this.lastError, nudgeCount: this.nudgeCount,
                lastNudgeStatus: this.lastNudgeStatus,
            });
            return;
        }
        if (ipOf(req) !== this.machineIp) { reject(res, 403); return; }
        if (!this.key) { reject(res, 503); return; }
        if (path.startsWith('/local_lan/')) {
            try { this.onContact({ at: new Date().toISOString() }); } catch { /* no secrets */ }
        }
        if (path === '/local_lan/key_exchange.json' && req.method === 'POST') {
            const body = await readJson(req);
            const exchange = body?.key_exchange;
            if (!exchange || typeof exchange.random_1 !== 'string' ||
                !['string', 'number'].includes(typeof exchange.time_1)) { reject(res, 400); return; }
            const randomServer = randomBytes(12).toString('base64');
            const timeServer = String(Date.now());
            this.keys = derive(this.key, exchange.random_1, randomServer, String(exchange.time_1), timeServer);
            this.sequence = 0;
            this.queue = [];
            this.lastRequestedAt = 0;
            this.exchangeCount++;
            this.lastExchangeAt = new Date().toISOString();
            this.onStatus('encrypted'); // key exchange only, not proof of decrypted data
            json(res, 202, { random_2: randomServer, time_2: Number(timeServer) });
            this.#scheduleOneNudge();
            return;
        }
        if (path === '/local_lan/commands.json' && (req.method === 'GET' || req.method === 'POST')) {
            if (req.method === 'POST') await readJson(req).catch(() => {});
            this.#poll(res);
            return;
        }
        // Query strings (e.g. ?cmd_id=1&status=200) are common on Ayla callbacks.
        if (path === '/local_lan/property/datapoint.json' && req.method === 'POST') {
            const body = await readJson(req);
            this.#datapoint(body, res);
            return;
        }
        reject(res, 404);
    }
}
module.exports = { CoffeeLanSession, postLocalRegistration, extractProperties };
