'use strict';

// Passive listener only: NOT a LAN integration or an authentication server.
// In particular, it NEVER calls /local_reg.json or modifies the machine.
// It refuses the machine's callbacks until a reviewed encrypted handshake
// is implemented. The only successful endpoint is a localhost-only health check.
const http = require('node:http');
const net = require('node:net');

function validIp(value) {
    // First local prototype intentionally supports IPv4 only.
    return typeof value === 'string' && net.isIP(value) === 4;
}

function remoteIp(req) {
    const ip = req.socket.remoteAddress || '';
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

class PassiveLanReceiver {
    constructor({ host = '127.0.0.1', port = 10275, machineIp, onContact = () => {} } = {}) {
        if (!validIp(host) || host === '0.0.0.0') throw new TypeError('LAN listen address must be a specific numeric IPv4 address');
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new TypeError('LAN listen port must be between 1024 and 65535');
        }
        if (machineIp && !validIp(machineIp)) throw new TypeError('Machine IP must be numeric IPv4');
        this.host = host;
        this.port = port;
        this.machineIp = machineIp || '';
        this.onContact = onContact;
        this.server = null;
    }

    async start() {
        if (this.server) throw new Error('LAN listener already started');
        this.server = http.createServer((req, res) => {
            res.setHeader('cache-control', 'no-store');
            const ip = remoteIp(req);
            if (req.method === 'GET' && req.url === '/health' && (ip === '127.0.0.1' || ip === this.host)) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ listener: 'passive', registration: 'disabled' }));
                return;
            }
            // Even a callback from the selected machine receives 503: we do
            // not acknowledge any unauthenticated encrypted LAN messages.
            if (!this.machineIp || ip !== this.machineIp) {
                res.writeHead(403);
                res.end();
                return;
            }
            if (req.url?.startsWith('/local_lan/')) {
                // Time + event type only; never record body, tokens, crypto material or serial.
                this.onContact({ at: new Date().toISOString(), type: 'unsupported-callback' });
            }
            res.writeHead(503, { 'retry-after': '60' });
            res.end();
        });
        this.server.requestTimeout = 3000;
        this.server.headersTimeout = 5000;
        this.server.maxRequestsPerSocket = 25;
        try {
            await new Promise((resolve, reject) => {
                this.server.once('error', reject);
                this.server.listen(this.port, this.host, () => {
                    this.server.off('error', reject);
                    resolve();
                });
            });
        } catch (error) {
            await this.stop();
            throw new Error(`LAN listener start failed (${error.code || 'unknown error'})`);
        }
    }

    async stop() {
        const server = this.server;
        this.server = null;
        if (server?.listening) await new Promise(resolve => server.close(resolve));
    }
}

module.exports = { PassiveLanReceiver };
