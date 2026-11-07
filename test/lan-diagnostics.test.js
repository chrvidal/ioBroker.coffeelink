'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CoffeeLanSession, extractProperties } = require('../lib/lan-session');
const { derive, encode, decode } = require('../lib/lan-protocol');

function post(host, port, path, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = http.request({ host, port, path, method: 'POST', headers: {
            'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        } }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        req.end(body);
    });
}
function get(host, port, path, localAddress) {
    return new Promise((resolve, reject) => {
        http.get({ host, port, path, localAddress }, res => {
            let text = '';
            res.on('data', x => { text += x; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }));
        }).on('error', reject);
    });
}

test('recognizes bulk, single-name and property-wrapper LAN datapoints', () => {
    const values = extractProperties({ seq_no: 12, data: { properties: [
        { property: { name: 'd700_tot_bev_b', value: 10072 } },
        { name: 'd701_tot_bev_bw', value: 972 },
    ] } });
    assert.equal(values.get('d700_tot_bev_b').value, 10072);
    assert.equal(values.get('d701_tot_bev_bw').value, 972);
    assert.equal(extractProperties({ seq_no: 12, data: { name: 'd700_tot_bev_b', value: 10072 } }).size, 1);
    assert.equal(extractProperties({ property: { name: 'd701_tot_bev_bw', value: 972 } }).size, 1);
    assert.equal(extractProperties({ data: { name: '../../bad', value: 9 } }).size, 0);
});

test('accepts query-parameter callbacks, decodes payload, and exposes safe counters', async () => {
    const key = 'test-local-secret';
    const host = '127.0.0.2';
    const port = 30000 + process.pid % 20000;
    const packets = [];
    const session = new CoffeeLanSession({
        host, port, machineIp: '127.0.0.1',
        registrationRequestFn: async () => ({ status: 202, ok: true }),
        onProperties: values => packets.push(values),
    });
    try {
        session.configure({ dsn: 'testmachine123', key });
        await session.start();
        await session.registerOnce();
        const exchange = await post(host, port, '/local_lan/key_exchange.json', {
            key_exchange: { random_1: 'device-seed', time_1: '355921561731160', ver: 1, proto: 1, key_id: 123456 },
        });
        assert.equal(exchange.status, 200);
        assert.equal(Number.isSafeInteger(exchange.body.time_2), true);
        assert.equal(String(exchange.body.time_2).length, 16);
        const keys = derive(key, 'device-seed', exchange.body.random_2,
            '355921561731160', String(exchange.body.time_2));
        const commands = await get(host, port, '/local_lan/commands.json?test=1');
        assert.equal(commands.status, 200);
        assert.ok(commands.body.enc);
        const commandPayload = decode(commands.body.enc, keys.toMachineKey, keys.toMachineIv);
        assert.match(commandPayload.plaintext, /property.json/);
        const push = JSON.stringify({ seq_no: 1, data: { name: 'd700_tot_bev_b', value: 10072 } });
        const frame = encode(push, keys.fromMachineKey, keys.fromMachineIv, keys.toMachineSign);
        const response = await post(host, port,
            '/local_lan/property/datapoint.json?cmd_id=1&status=200', { enc: frame.enc });
        assert.equal(response.status, 200);
        assert.equal(packets.length, 1);
        assert.equal(packets[0].get('d700_tot_bev_b').value, 10072);
        const diag = await get(host, port, '/health', host);
        assert.equal(diag.body.exchangeCount, 1);
        assert.equal(diag.body.machineRequestCount, 3);
        assert.equal(diag.body.keyExchangeRepliesSent, 1);
        assert.deepEqual(diag.body.lastHandshakeFeatures, { time1Digits: 15, version: 1, protocol: 1, hasKeyId: true, responseStatus: 200, time2Digits: 16 });
        assert.equal(diag.body.pollCount, 1);
        assert.equal(diag.body.pushCount, 1);
        assert.equal(diag.body.decodedCount, 1);
        assert.equal(diag.body.propertiesCount, 1);
        assert.ok(diag.body.lastReceivedAt);
        assert.equal(JSON.stringify(diag.body).includes(key), false);
    } finally { await session.stop(); }
});

test('invalid encrypted push produces 200 but safe diagnostic, not a secret leak', async () => {
    const host = '127.0.0.2';
    const port = 35000 + process.pid % 20000;
    const session = new CoffeeLanSession({ host, port, machineIp: '127.0.0.1' });
    try {
        session.configure({ dsn: 'testmachine123', key: 'secret' });
        await session.start();
        const response = await post(host, port, '/local_lan/property/datapoint.json?cmd_id=4', { enc: 'bad' });
        assert.equal(response.status, 200);
        const diag = await get(host, port, '/health', host);
        assert.equal(diag.body.pushCount, 1);
        assert.equal(diag.body.lastError, 'push-before-handshake-or-missing-enc');
    } finally { await session.stop(); }
});
