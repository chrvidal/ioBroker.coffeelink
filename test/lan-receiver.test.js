'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassiveLanReceiver } = require('../lib/lan-receiver');

async function request(port, path, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path, method, timeout: 3000 }, res => {
            const chunks = [];
            res.on('data', x => chunks.push(x));
            res.on('end', () => resolve({status:res.statusCode, body:Buffer.concat(chunks).toString()}));
        });
        req.on('error', reject);
        req.end();
    });
}

test('passive listener responds to local health but refuses device callback', async () => {
    // 0 can be used in test only via direct HTTP simulation, production rejects it.
    const receiver = new PassiveLanReceiver({ host:'127.0.0.1', port:20000 + (process.pid % 20000), machineIp:'127.0.0.1' });
    try {
        await receiver.start();
        const health = await request(receiver.port, '/health');
        assert.equal(health.status, 200);
        assert.match(health.body, /"registration":"disabled"/);
        const callback = await request(receiver.port, '/local_lan/key_exchange.json', 'POST');
        assert.equal(callback.status, 503);
    } finally { await receiver.stop(); }
});

test('passive listener does not accept callback from unconfigured device', async () => {
    const receiver = new PassiveLanReceiver({host:'127.0.0.1',port:20000+(process.pid % 20000)+1});
    try {
        await receiver.start();
        assert.equal((await request(receiver.port, '/local_lan/commands.json')).status,403);
    } finally { await receiver.stop(); }
});

test('rejects public wildcard bind and invalid port values', () => {
    assert.throws(() => new PassiveLanReceiver({host:'0.0.0.0',port:10275}),/IPv4/);
    assert.throws(() => new PassiveLanReceiver({host:'127.0.0.1',port:80}),/port/);
    assert.throws(() => new PassiveLanReceiver({host:'invalid',port:10275}),/IPv4/);
});
