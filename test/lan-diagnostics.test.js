'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CoffeeLanSession, extractProperties } = require('../lib/lan-session');
const { derive, encode, decode } = require('../lib/lan-protocol');

function post(host, port, path, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = http.request({ host, port, path, localAddress: '127.0.0.1', method: 'POST', headers: {
            'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        } }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        req.end(body);
    });
}
function get(host, port, path, localAddress = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        http.get({ host, port, path, localAddress }, res => {
            let text = '';
            res.on('data', x => { text += x; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text || '{}') }));
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

test('reads authenticated counters and recovers registration when callbacks stop', async context => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.UTC(2026, 10, 8) });
    const key = 'test-local-secret';
    const host = '127.0.0.2';
    const port = 30000 + process.pid % 20000;
    const packets = [];
    const notifications = [];
    let registrations = 0;
    const session = new CoffeeLanSession({
        host, port, machineIp: '127.0.0.1',
        registrationRequestFn: async (request) => {
            if (request.method === 'PUT') notifications.push(request.body.local_reg.notify);
            else registrations++;
            return { status: 202, ok: true };
        },
        onProperties: values => packets.push(values),
    });
    try {
        session.configure({ dsn: 'testmachine123', key, keyId: 123456 });
        await session.start();
        await session.registerOnce();
        const exchange = await post(host, port, '/local_lan/key_exchange.json', {
            key_exchange: { random_1: 'device-seed==', time_1: '355921561731160', ver: 1, proto: 1, key_id: 123456 },
        });
        assert.equal(exchange.status, 200);
        // HTTP/1.1 handshake uses a fixed Content-Length;
        // Node's implicit chunked responses can stall low-level device clients.
        assert.equal(exchange.headers['transfer-encoding'], undefined);
        assert.equal(Number(exchange.headers['content-length']),
            Buffer.byteLength(JSON.stringify(exchange.body)));
        assert.equal(exchange.headers['content-type'], 'application/json');
        assert.equal(Number.isSafeInteger(exchange.body.time_2), true);
        assert.equal(String(exchange.body.time_2).length, 16);
        const keys = derive(key, 'device-seed', exchange.body.random_2,
            '355921561731160', String(exchange.body.time_2));
        const commands = await get(host, port, '/local_lan/commands.json?test=1');
        assert.equal(commands.status, 200);
        assert.equal(commands.headers['transfer-encoding'], undefined);
        assert.equal(Number(commands.headers['content-length']),
            Buffer.byteLength(JSON.stringify(commands.body)));
        // Real ESP32/Ayla v1 command response contains exactly enc + sign.
        assert.deepEqual(Object.keys(commands.body), ['enc', 'sign']);
        assert.ok(commands.body.enc);
        assert.equal(typeof commands.body.sign, 'string');
        const commandPayload = decode(commands.body.enc, keys.toMachineKey, keys.toMachineIv,
            keys.toMachineSign, commands.body.sign);
        const command = JSON.parse(commandPayload.plaintext);
        assert.equal(command.seq_no, '0');
        assert.equal(command.data.cmds[0].cmd.method, 'GET');
        assert.equal(command.data.cmds[0].cmd.resource, 'property.json?name=d700_tot_bev_b');
        assert.equal(command.data.cmds[0].cmd.uri, '/local_lan/property/datapoint.json');
        let sequence = 0;
        const sendPush = (path, data, invalid = false) => {
            const push = JSON.stringify({ seq_no: String(sequence++), data });
            const frame = encode(push, keys.fromMachineKey, keys.fromMachineIv, keys.fromMachineSign);
            keys.fromMachineIv = frame.iv;
            return post(host, port, path, { enc: frame.enc, sign: invalid ? Buffer.alloc(32).toString('base64') : frame.sign });
        };
        const callbackPath = '/local_lan/property/datapoint.json?cmd_id=1&status=200';
        await sendPush(callbackPath, { name: 'd700_tot_bev_b', value: 999 }, true);
        assert.equal(packets.length, 0);
        assert.deepEqual(notifications, []);
        const rejected = await get(host, port, '/health', host);
        assert.equal(rejected.body.sessionVerified, false);
        assert.equal(rejected.body.lastError, 'invalid-signature');

        const response = await sendPush(callbackPath, { name: 'd700_tot_bev_b', value: 10072 });
        assert.equal(response.status, 200);
        assert.equal(packets.length, 1);
        assert.equal(packets[0].get('d700_tot_bev_b').value, 10072);
        assert.deepEqual(notifications, [1]);

        const second = await get(host, port, '/local_lan/commands.json');
        const secondFrame = decode(second.body.enc, keys.toMachineKey, commandPayload.iv,
            keys.toMachineSign, second.body.sign);
        const secondCommand = JSON.parse(secondFrame.plaintext);
        assert.equal(secondCommand.seq_no, '1');
        assert.equal(secondCommand.data.cmds[0].cmd.cmd_id, 2);
        assert.equal(secondCommand.data.cmds[0].cmd.resource, 'property.json?name=d701_tot_bev_bw');
        const ack = await sendPush('/local_lan/property/datapoint/ack.json?cmd_id=2&status=200',
            { name: 'd701_tot_bev_bw', value: '972' });
        assert.equal(ack.status, 200);
        assert.equal(packets[1].get('d701_tot_bev_bw').value, '972');
        const diag = await get(host, port, '/health', host);
        assert.equal(diag.body.exchangeCount, 1);
        assert.equal(diag.body.machineRequestCount, 6);
        assert.equal(diag.body.keyExchangeRepliesSent, 1);
        assert.equal(diag.body.commandRepliesSent, 2);
        assert.equal(diag.body.lastCommandKind, 'read-properties');
        assert.equal(diag.body.lastPollResponseBytes, Buffer.byteLength(JSON.stringify(second.body)));
        assert.deepEqual(diag.body.lastHandshakeFeatures, { time1Digits: 15, version: 1, protocol: 1, hasKeyId: true, responseStatus: 200, time2Digits: 16 });
        assert.equal(diag.body.cloudKeyId, 123456);
        assert.equal(diag.body.machineKeyId, 123456);
        assert.equal(diag.body.keyIdsMatch, true);
        assert.equal(diag.body.pollCount, 2);
        assert.equal(diag.body.pushCount, 3);
        assert.equal(diag.body.decodedCount, 2);
        assert.equal(diag.body.rejectedSignatureCount, 1);
        assert.equal(diag.body.propertiesCount, 2);
        assert.equal(diag.body.counterCount, 2);
        assert.equal(diag.body.sessionVerified, true);
        assert.ok(diag.body.lastReceivedAt);
        assert.equal(JSON.stringify(diag.body).includes(key), false);

        const operation = session.exchangeProperty('data_request', 'synthetic-frame\n');
        const third = await get(host, port, '/local_lan/commands.json');
        const thirdFrame = decode(third.body.enc, keys.toMachineKey, secondFrame.iv, keys.toMachineSign, third.body.sign);
        assert.deepEqual(JSON.parse(thirdFrame.plaintext).data, { properties: [{ property: {
            name: 'data_request', value: 'synthetic-frame\n', dsn: 'testmachine123', base_type: 'string',
        } }] });
        assert.equal(await operation, 'sent');
        const fourth = await get(host, port, '/local_lan/commands.json');
        const fourthFrame = decode(fourth.body.enc, keys.toMachineKey, thirdFrame.iv, keys.toMachineSign, fourth.body.sign);
        assert.equal(JSON.parse(fourthFrame.plaintext).data.cmds[0].cmd.method, 'GET');

        context.mock.timers.tick(300000);
        await get(host, port, '/local_lan/commands.json');
        context.mock.timers.tick(30000);
        assert.equal(registrations, 1);
        assert.equal(session.sessionVerified, true);

        context.mock.timers.tick(270000);
        await Promise.resolve();
        assert.equal(registrations, 1);
        context.mock.timers.tick(30000);
        await Promise.resolve();
        assert.equal(registrations, 2);
        assert.equal(session.sessionVerified, false);
        assert.equal((await get(host, port, '/local_lan/commands.json')).status, 404);

        const newExchange = await post(host, port, '/local_lan/key_exchange.json', {
            key_exchange: { random_1: 'new-seed==', time_1: '355921562000000', key_id: 123456 },
        });
        assert.equal(newExchange.status, 200);
        const newKeys = derive(key, 'new-seed', newExchange.body.random_2,
            '355921562000000', String(newExchange.body.time_2));
        const counter = { seq_no: '0', data: { name: 'd700_tot_bev_b', value: 10073 } };
        const { enc, sign } = encode(JSON.stringify(counter), newKeys.fromMachineKey,
            newKeys.fromMachineIv, newKeys.fromMachineSign);
        const reply = await post(host, port, '/local_lan/property/datapoint.json', { enc, sign });
        assert.equal(reply.status, 200);
        assert.equal(session.sessionVerified, true);
        assert.equal(packets.at(-1).get('d700_tot_bev_b').value, 10073);
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

// Key ID is non-secret metadata, never the key itself. Mismatch is observable.
test('diagnoses a cloud/device key ID mismatch safely', async () => {
    const host = '127.0.0.2';
    const port = 36000 + process.pid % 20000;
    const session = new CoffeeLanSession({ host, port, machineIp: '127.0.0.1' });
    try {
        session.configure({ dsn: 'testmachine123', key: 'PRIVATE-KEY-NOT-FOR-LOGS', keyId: 46965 });
        await session.start();
        const exchange = await post(host, port, '/local_lan/key_exchange.json', {
            key_exchange: { random_1: 'random-1==', time_1: '355921561731160', key_id: 46964 },
        });
        assert.equal(exchange.status, 400);
        const health = await get(host, port, '/health', host);
        assert.equal(health.body.cloudKeyId, 46965);
        assert.equal(health.body.machineKeyId, 46964);
        assert.equal(health.body.keyIdsMatch, false);
        assert.equal(health.body.connected, false);
        assert.equal(health.body.lastError, 'lan-key-id-mismatch');
        assert.equal(JSON.stringify(health.body).includes('PRIVATE-KEY-NOT-FOR-LOGS'), false);
    } finally { await session.stop(); }
});
