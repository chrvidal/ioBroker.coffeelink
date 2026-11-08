'use strict';
// Experimental, opt-in LAN transport. Registration changes the callback endpoint
// and can affect the official Coffee Link app. No beverage or settings commands.
const http = require('node:http');
const net = require('node:net');
const { createSocket } = require('node:dgram');
const { randomBytes } = require('node:crypto');
const { derive, decode, encode } = require('./lan-protocol');
const { COUNTERS, counterValue, getCounters } = require('./measurements');

const MAX_BODY = 256 * 1024;
const REG_TIMEOUT_MS = 5000;
const DEFAULT_CALLBACK_PORT = 10275;
const REG_RETRY_DELAYS_MS = [3000, 12000];
const MAX_REG_ATTEMPTS = 3 + REG_RETRY_DELAYS_MS.length;
const REG_CHECK_MS = 30000;
const REG_BACKOFF_MS = 60000;
const LAN_IDLE_MS = 5 * 60000;
const READ_TIMEOUT_MS = 10000;
const POLL_NOTIFICATION_RETRY_MS = 800;
const MAX_POLL_NOTIFICATIONS = 3;
const DATAPOINT_PATH = '/local_lan/property/datapoint.json';
const ACK_PATH = '/local_lan/property/datapoint/ack.json';
const TRANSIENT_ERRORS = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE',
]);

function readCommand(name, cmdId) {
    return { cmds: [{ cmd: {
        cmd_id: cmdId, data: '', method: 'GET', resource: `property.json?name=${name}`, uri: DATAPOINT_PATH,
    } }] };
}

async function lanAddressFor(machineIp) {
    if (!net.isIPv4(machineIp)) throw Error('Enter the coffee machine IPv4 address');
    const socket = createSocket('udp4');
    try {
        // Connecting a UDP socket selects the source address without sending a packet.
        await new Promise((resolve, reject) => {
            socket.once('error', reject);
            socket.connect(80, machineIp, error => error ? reject(error) : resolve());
        });
        return socket.address().address;
    } finally {
        socket.close();
    }
}

// ECAM612.55 tested: native HTTP/1.1 POST with curl-style headers receives 202;
// undici/fetch receives 400 for the same JSON. Never disclose response bodies.
function postLocalRegistration({ machineIp, dsn, body, method = 'POST', port = 80, timeoutMs = REG_TIMEOUT_MS }) {
    if (net.isIP(machineIp) !== 4 || !/^[A-Za-z0-9_-]{1,128}$/.test(dsn)) {
        throw new TypeError('Invalid LAN registration target');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid LAN port');
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: machineIp,
            port,
            path: method === 'POST' ? `/local_reg.json?dsn=${encodeURIComponent(dsn)}` : '/local_reg.json',
            method,
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
            res.once('aborted', () => reject(Object.assign(new Error('Connection aborted'), { code: 'ECONNRESET' })));
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
function reject(res, status) {
    if (!res.headersSent) res.writeHead(status, { 'cache-control': 'no-store' });
    res.end();
}
function json(res, status, data) {
    const payload = JSON.stringify(data);
    // Embedded Ayla/ESP32 clients expect Content-Length: the old Node default
    // Transfer-Encoding: chunked may leave the machine stuck at key exchange.
    // A fixed length is used for every JSON callback, not just handshakes.
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
    });
    res.end(payload);
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
    constructor({ host, port = DEFAULT_CALLBACK_PORT, machineIp, registrationRequestFn = postLocalRegistration,
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
        this.cloudKeyId = null;
        this.machineKeyId = null;
        this.keyIdsMatch = null;
        this.keys = null;
        this.registrationAttempted = false;
        this.registrationInFlight = false;
        this.registrationAttempts = 0;
        this.registrationRetryTimer = null;
        this.registrationCheckTimer = null;
        this.lastRegistrationAt = 0;
        this.recoveryProbeAt = 0;
        this.registered = false;
        this.sequence = 0;
        this.sessionVerified = false;
        this.readCursor = 0;
        this.readsRemaining = 0;
        this.pendingRead = null;
        this.request = null;
        this.readTimer = null;
        this.notifyInFlight = false;
        this.lastNotifyStatus = '';
        this.lastReadResult = '';
        this.lastReceivedAt = '';
        this.lastExchangeAt = '';
        this.lastPollAt = '';
        this.lastPushAt = '';
        this.lastDecodedAt = '';
        this.lastError = '';
        this.lastNudgeStatus = '';
        this.exchangeCount = 0;
        this.keyExchangeRepliesSent = 0;
        this.commandRepliesSent = 0;
        this.lastCommandKind = '';
        this.lastPollResponseBytes = 0;
        this.machineRequestCount = 0;
        this.unknownMachineRequestCount = 0;
        this.lastMachineRequestKind = '';
        this.lastHandshakeFeatures = null;
        this.pollCount = 0;
        this.pushCount = 0;
        this.decodedCount = 0;
        this.rejectedSignatureCount = 0;
        this.propertiesCount = 0;
        this.counterCount = 0;
        this.stopping = false;
    }
    configure({ dsn, key, keyId = null }) {
        if (typeof dsn !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(dsn) ||
            typeof key !== 'string' || !key || key.length > 256) throw Error('Invalid LAN configuration');
        this.dsn = dsn;
        this.key = key;
        this.cloudKeyId = Number.isSafeInteger(keyId) && keyId >= 0 ? keyId : null;
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
        this.registrationCheckTimer = setInterval(() => {
            void this.recoverRegistration().catch(() => {});
        }, REG_CHECK_MS);
        this.registrationCheckTimer.unref();
    }
    async stop() {
        this.stopping = true;
        clearInterval(this.registrationCheckTimer);
        this.registrationCheckTimer = null;
        clearTimeout(this.registrationRetryTimer);
        this.registrationRetryTimer = null;
        this.request?.settle(new Error('session-ended'));
        this.#clearRead();
        const s = this.server;
        this.server = null;
        if (s?.listening) await new Promise(resolve => s.close(resolve));
        this.keys = null;
        this.key = null;
    }
    #registrationBody(notify) {
        return { local_reg: { ip: this.host, notify, port: this.port, uri: '/local_lan' } };
    }
    async recoverRegistration() {
        if (this.stopping || this.registrationAttempts === 0 || this.registrationRetryTimer || this.registrationInFlight
            || this.request || this.notifyInFlight) return;

        const now = Date.now();
        const lastActivity = this.keys ? Math.max(
            this.lastRegistrationAt,
            Date.parse(this.lastExchangeAt) || 0,
            Date.parse(this.lastPollAt) || 0,
            Date.parse(this.lastDecodedAt) || 0,
        ) : this.lastRegistrationAt;
        const wait = this.registered || this.keys ? LAN_IDLE_MS : REG_BACKOFF_MS;
        if (now - lastActivity < wait) {
            this.recoveryProbeAt = 0;
            return;
        }
        // An idle session may still be usable. Ask for a read before replacing it.
        if (this.sessionVerified && !this.recoveryProbeAt) {
            this.recoveryProbeAt = now;
            this.refreshCounters();
            return;
        }
        if (this.recoveryProbeAt && now - this.recoveryProbeAt < REG_CHECK_MS) return;

        this.#clearRead();
        this.readsRemaining = 0;
        this.sessionVerified = false;
        this.keys = null;
        this.registered = false;
        this.recoveryProbeAt = 0;
        this.registrationAttempted = false;
        await this.registerOnce();
    }
    async registerOnce() {
        if (!this.server?.listening || !this.key || !this.dsn) throw Error('LAN session not ready');
        if (this.registrationAttempted) return;
        clearTimeout(this.registrationRetryTimer);
        this.registrationRetryTimer = null;
        this.registrationAttempted = true;
        this.registrationAttempts++;
        this.registrationInFlight = true;
        this.lastRegistrationAt = Date.now();
        let response;
        try {
            response = await this.registrationRequestFn({
                machineIp: this.machineIp, dsn: this.dsn, body: this.#registrationBody(0), timeoutMs: REG_TIMEOUT_MS,
            });
        } catch (error) {
            if (this.stopping || this.keys) return;
            const code = error?.code || error?.cause?.code;
            const timeout = error?.name === 'TimeoutError' || code === 'ETIMEDOUT';
            if ((timeout || TRANSIENT_ERRORS.has(code)) && this.registrationAttempts < MAX_REG_ATTEMPTS) {
                this.registrationAttempted = false;
                const delay = REG_RETRY_DELAYS_MS[this.registrationAttempts - 1];
                if (delay) {
                    this.registrationRetryTimer = setTimeout(() => {
                        this.registrationRetryTimer = null;
                        if (!this.stopping && !this.keys) void this.registerOnce().catch(() => {});
                    }, delay);
                    this.registrationRetryTimer.unref?.();
                }
            }
            const reason = timeout
                ? 'register-timeout'
                : code === 'ECONNREFUSED' ? 'register-connection-refused'
                : code === 'ENETUNREACH' || code === 'EHOSTUNREACH' ? 'register-network-unreachable'
                : 'register-network-error';
            this.lastError = reason;
            this.onStatus(reason);
            return;
        } finally {
            this.registrationInFlight = false;
        }
        if (this.stopping) return;
        this.registered = response.ok;
        const code = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status : 'unknown';
        this.lastError = response.ok || this.keys ? '' : `register-http-${code}`;
        if (!this.keys) this.onStatus(response.ok ? 'registered' : `register-http-${code}`);
    }
    #clearRead() {
        clearTimeout(this.readTimer);
        this.readTimer = null;
        this.pendingRead = null;
    }
    refreshCounters() {
        if (!this.sessionVerified || this.pendingRead || this.notifyInFlight || this.stopping) return;
        this.readsRemaining = COUNTERS.length;
        void this.#notify();
    }
    exchangeProperty(name, value, { match, signal, timeoutMs = 8000 } = {}) {
        if (!this.sessionVerified || this.stopping) return Promise.reject(new Error('lan-unavailable'));
        if (signal?.aborted) return Promise.reject(new Error('cancelled'));
        if (this.request) return Promise.reject(new Error('busy'));
        return new Promise((resolve, reject) => {
            let nudgeTimer;
            const onAbort = () => settle(new Error('cancelled'));
            const settle = (error, result) => {
                clearTimeout(timer);
                clearTimeout(nudgeTimer);
                signal?.removeEventListener('abort', onAbort);
                this.request = null;
                if (error) reject(error);
                else resolve(result);
            };
            const request = { name, value, match, settle, sent: false };
            const timer = setTimeout(() => {
                settle(new Error(request.sent ? 'unconfirmed' : 'not-delivered'));
                void this.#notify();
            }, timeoutMs);
            timer.unref();
            this.request = request;
            signal?.addEventListener('abort', onAbort, { once: true });
            let notifications = 0;
            const nudge = () => {
                if (this.request !== request || request.sent) return;
                if (!this.notifyInFlight) {
                    notifications++;
                    void this.#notify();
                }
                if (notifications < MAX_POLL_NOTIFICATIONS) {
                    nudgeTimer = setTimeout(nudge, POLL_NOTIFICATION_RETRY_MS);
                    nudgeTimer.unref();
                }
            };
            // The module can accept the notification without polling immediately.
            // Retry only the notification while the command is still unsent.
            nudge();
        });
    }
    readProperty(name, options) {
        return this.exchangeProperty(name, undefined, options);
    }
    #hasPendingWork() {
        return this.request ? !this.request.sent : this.readsRemaining > 0 && !this.pendingRead;
    }
    async #notify() {
        if (!this.sessionVerified || !this.#hasPendingWork() || this.notifyInFlight || this.stopping) return;
        const keys = this.keys;
        const sequence = this.sequence;
        this.notifyInFlight = true;
        try {
            const response = await this.registrationRequestFn({
                machineIp: this.machineIp, dsn: this.dsn, body: this.#registrationBody(1), method: 'PUT',
            });
            if (this.keys === keys) this.lastNotifyStatus = response.ok ? 'accepted' : 'http-rejected';
        } catch {
            if (this.keys === keys) this.lastNotifyStatus = 'network-error';
        } finally {
            this.notifyInFlight = false;
            // The next callback can arrive before the HTTP notification reply.
            if (this.keys !== keys || this.sequence !== sequence) void this.#notify();
        }
    }
    #nextRead(cmdId) {
        if (!this.readsRemaining || this.pendingRead) return {};
        const [, name] = COUNTERS[this.readCursor];
        this.readCursor = (this.readCursor + 1) % COUNTERS.length;
        this.readsRemaining--;
        this.pendingRead = { name, cmdId };
        this.lastReadResult = 'waiting';
        this.readTimer = setTimeout(() => {
            this.#clearRead();
            this.lastReadResult = 'timeout';
            void this.#notify();
        }, READ_TIMEOUT_MS);
        this.readTimer.unref();
        return readCommand(name, cmdId);
    }
    #poll(res) {
        this.pollCount++;
        if (!this.keys) { reject(res, 404); return; }
        this.lastPollAt = new Date().toISOString();
        const current = this.sequence++;
        const request = this.request;
        const sendRequest = request && !request.sent;
        if (sendRequest) {
            request.sent = true;
            res.once('finish', () => {
                if (!request.match && this.request === request) request.settle(null, 'sent');
                void this.#notify();
            });
        }
        let payload = request ? {} : this.#nextRead(current + 1);
        if (sendRequest) {
            payload = request.value === undefined ? readCommand(request.name, current + 1) : { properties: [{ property: {
                name: request.name, value: request.value, dsn: this.dsn, base_type: 'string',
            } }] };
        }
        const data = { seq_no: String(current), data: payload };
        const encrypted = encode(JSON.stringify(data), this.keys.toMachineKey,
            this.keys.toMachineIv, this.keys.toMachineSign);
        this.keys.toMachineIv = encrypted.iv;
        // Ayla ESP32 v1 wire capture: command-poll reply has only enc + sign.
        // seq_no is inside the encrypted plaintext; no extra top-level seq.
        const reply = { enc: encrypted.enc, sign: encrypted.sign };
        this.lastCommandKind = payload.properties ? 'ecam-request' : payload.cmds ? 'read-properties' : 'heartbeat';
        this.lastPollResponseBytes = Buffer.byteLength(JSON.stringify(reply));
        // Socket completion only (not a device-level acknowledgement).
        res.once('finish', () => { this.commandRepliesSent++; });
        json(res, 200, reply);
    }
    #datapoint(body, res, query) {
        this.pushCount++;
        this.lastPushAt = new Date().toISOString();
        if (!this.keys || typeof body?.enc !== 'string') {
            this.lastError = 'push-before-handshake-or-missing-enc';
            json(res, 200, {});
            return;
        }
        let decoded;
        try {
            decoded = decode(body.enc, this.keys.fromMachineKey, this.keys.fromMachineIv,
                this.keys.fromMachineSign, body.sign);
            // The peer already advanced its CBC stream, even on a bad HMAC.
            this.keys.fromMachineIv = decoded.iv;
        } catch {
            // Never return 4xx to an already authenticated machine on decode error:
            // firmware may back off further datapoint pushes.
            this.lastError = 'decrypt-failed';
            json(res, 200, {});
            return;
        }
        if (decoded.plaintext === null) {
            this.rejectedSignatureCount++;
            this.lastError = typeof body.sign === 'string' ? 'invalid-signature' : 'missing-signature';
            json(res, 200, {});
            return;
        }
        let parsed;
        try { parsed = JSON.parse(decoded.plaintext); } catch {
            this.lastError = 'decoded-json-invalid';
            json(res, 200, {});
            return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            this.lastError = 'decoded-json-invalid';
            json(res, 200, {});
            return;
        }
        this.decodedCount++;
        if (!this.sessionVerified) {
            this.sessionVerified = true;
            this.onStatus('verified');
        }
        this.lastDecodedAt = new Date().toISOString();
        const values = extractProperties(parsed);
        const request = this.request;
        if (request?.sent && request.match) {
            const result = request.match(values);
            if (result !== undefined) {
                request.settle(null, result);
                res.once('finish', () => { void this.#notify(); });
            }
        }
        if (values.size > 0) {
            this.propertiesCount += values.size;
            this.counterCount += getCounters(values).length;
            this.lastReceivedAt = this.lastDecodedAt;
            this.lastError = '';
            try { this.onProperties(values, this.lastReceivedAt); } catch { this.lastError = 'on-properties-failed'; }
        } else {
            this.lastError = 'no-named-properties';
        }
        const pending = this.pendingRead;
        const status = query.get('status');
        const result = pending && values.has(pending.name)
            ? (counterValue(values.get(pending.name).value) === null ? 'invalid-counter-value' : 'counter')
            : pending && query.get('cmd_id') === String(pending.cmdId) && /^[45]\d\d$/.test(status)
                ? `http-${status}` : null;
        if (result) {
            this.#clearRead();
            this.lastReadResult = result;
            res.once('finish', () => { void this.#notify(); });
        }
        json(res, 200, {});
    }
    async #handle(req, res) {
        const { pathname: path, searchParams } = new URL(req.url, 'http://internal.invalid');
        if (req.method === 'GET' && path === '/health' && ipOf(req) === this.host) {
            json(res, 200, {
                listener: 'encrypted', registration: this.registered ? 'sent' : 'not-sent',
                connected: !!this.keys, sessionVerified: this.sessionVerified, lastReceivedAt: this.lastReceivedAt,
                exchangeCount: this.exchangeCount, pollCount: this.pollCount,
                pushCount: this.pushCount, decodedCount: this.decodedCount,
                rejectedSignatureCount: this.rejectedSignatureCount,
                propertiesCount: this.propertiesCount, counterCount: this.counterCount,
                lastExchangeAt: this.lastExchangeAt, lastPollAt: this.lastPollAt,
                lastPushAt: this.lastPushAt, lastDecodedAt: this.lastDecodedAt,
                lastError: this.lastError, registrationAttempts: this.registrationAttempts,
                lastNotifyStatus: this.lastNotifyStatus, lastReadResult: this.lastReadResult,
                machineRequestCount: this.machineRequestCount,
                unknownMachineRequestCount: this.unknownMachineRequestCount,
                lastMachineRequestKind: this.lastMachineRequestKind,
                keyExchangeRepliesSent: this.keyExchangeRepliesSent,
                commandRepliesSent: this.commandRepliesSent,
                lastCommandKind: this.lastCommandKind,
                lastPollResponseBytes: this.lastPollResponseBytes,
                lastHandshakeFeatures: this.lastHandshakeFeatures,
                cloudKeyId: this.cloudKeyId,
                machineKeyId: this.machineKeyId,
                keyIdsMatch: this.keyIdsMatch,
            });
            return;
        }
        if (ipOf(req) !== this.machineIp) { reject(res, 403); return; }
        // Counts only: no URLs, callback bodies, secrets, or device identifiers.
        this.machineRequestCount++;
        this.lastMachineRequestKind = path === '/local_lan/key_exchange.json' ? 'handshake'
            : path === '/local_lan/commands.json' ? 'poll'
                : path === DATAPOINT_PATH ? 'push' : path === ACK_PATH ? 'ack' : 'other';
        if (!this.key) { reject(res, 503); return; }
        if (path.startsWith('/local_lan/')) {
            try { this.onContact({ at: new Date().toISOString() }); } catch { /* no secrets */ }
        }
        if (path === '/local_lan/key_exchange.json' && req.method === 'POST') {
            const body = await readJson(req);
            const exchange = body?.key_exchange;
            if (!exchange || typeof exchange.random_1 !== 'string' ||
                !['string', 'number'].includes(typeof exchange.time_1)) { reject(res, 400); return; }
            const time1 = String(exchange.time_1);
            this.machineKeyId = Number.isSafeInteger(exchange.key_id) && exchange.key_id >= 0
                ? exchange.key_id : (typeof exchange.key_id === 'string' && /^\d+$/.test(exchange.key_id)
                    && Number.isSafeInteger(Number(exchange.key_id)) ? Number(exchange.key_id) : null);
            this.keyIdsMatch = this.cloudKeyId === null || this.machineKeyId === null
                ? null : this.cloudKeyId === this.machineKeyId;
            this.#clearRead();
            this.request?.settle(new Error('session-ended'));
            this.sessionVerified = false;
            this.keys = null;
            if (this.keyIdsMatch === false) {
                this.lastError = 'lan-key-id-mismatch';
                this.onStatus(this.lastError);
                reject(res, 400);
                return;
            }
            const randomServer = randomBytes(12).toString('base64');
            // Keep the ECAM612.55 v0.0.13 handshake that produced decoded callbacks.
            const timeServer = String(Date.now() * 1000);
            const deviceRandom = exchange.random_1.replace(/=+$/, '');
            this.keys = derive(this.key, deviceRandom, randomServer, time1, timeServer);
            this.lastError = '';
            this.lastReadResult = '';
            this.lastNotifyStatus = '';
            // Firmware fingerprint for diagnosing a stalled exchange.
            // Record only the format and non-secret key ID metadata.
            const smallInt = value => Number.isInteger(value) && value >= 0 && value <= 99 ? value : null;
            this.lastHandshakeFeatures = {
                time1Digits: time1.length,
                version: smallInt(exchange.ver),
                protocol: smallInt(exchange.proto),
                hasKeyId: Object.hasOwn(exchange, 'key_id'),
                responseStatus: 200,
                time2Digits: timeServer.length,
            };
            this.sequence = 0;
            this.readsRemaining = COUNTERS.length;
            this.exchangeCount++;
            this.lastExchangeAt = new Date().toISOString();
            this.onStatus('encrypted'); // key exchange only, not proof of decrypted data
            // 'finish' means handed to the socket, NOT acknowledged by the machine.
            res.once('finish', () => { this.keyExchangeRepliesSent++; });
            json(res, 200, { random_2: randomServer, time_2: Number(timeServer) });
            return;
        }
        if (path === '/local_lan/commands.json' && (req.method === 'GET' || req.method === 'POST')) {
            if (req.method === 'POST') await readJson(req).catch(() => {});
            this.#poll(res);
            return;
        }
        // Query strings (e.g. ?cmd_id=1&status=200) are common on Ayla callbacks.
        if ((path === DATAPOINT_PATH || path === ACK_PATH) && req.method === 'POST') {
            const body = await readJson(req);
            this.#datapoint(body, res, searchParams);
            return;
        }
        this.unknownMachineRequestCount++;
        reject(res, 404);
    }
}
module.exports = { CoffeeLanSession, lanAddressFor, postLocalRegistration, extractProperties };
