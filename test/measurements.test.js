'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getCounters, counterValue, latestMonitor, crc16CcittAug, monitorStatus } = require('../lib/measurements');

function monitorPacket(code) {
    // Minimal valid MonitorV2: [header, length, cmd, sub, contents8, crcBE].
    const frame = Buffer.from([0xd0, 0x0d, 0x75, 0x00, 0, 0, 0, 0, 0, code, 0, 50]);
    const crc = crc16CcittAug(frame);
    return Buffer.concat([frame, Buffer.from([crc >> 8, crc & 255]), Buffer.alloc(4)]).toString('base64');
}

test('converts valid black and milk drink counters only', () => {
    const props = new Map([
        ['d706_tot_id2_coffee', { value: '42' }],
        ['d711_id8_lattmacc', { value: '12' }],
        ['d556_water_hardness', { value: '96874' }],
        ['d553_water_tot_qty', { value: '0' }],
    ]);
    assert.deepEqual(getCounters(props).map(x => [x.id, x.value]), [
        ['coffee', 42], ['latteMacchiato', 12],
    ]);
});

test('rejects malformed, negative, decimal and unsafe counter values', () => {
    for (const value of [-1, '-1', '1.2', 1.5, true, {}, 'NaN', '99999999999999999']) {
        assert.equal(counterValue(value), null);
    }
    assert.equal(counterValue(' 003 '), 3);
});

test('interprets fresh monitor and explicitly marks stale status', () => {
    const payload = monitorPacket(7);
    assert.equal(monitorStatus(payload), 'ready');
    const now = Date.parse('2026-11-07T07:00:00Z');
    let props = new Map([['d302_monitor', { value: payload, data_updated_at: '2026-11-07T06:58:00Z' }]]);
    assert.deepEqual(latestMonitor(props, now).status, 'ready');
    assert.equal(latestMonitor(props, now).fresh, true);
    props = new Map([['d302_monitor', { value: payload, data_updated_at: '2026-11-07T06:48:00Z' }]]);
    assert.equal(latestMonitor(props, now).status, 'stale');
    assert.equal(latestMonitor(props, now).lastKnown, 'ready');
    assert.equal(latestMonitor(props, now).fresh, false);
});

test('rejects altered CRC', () => {
    const bytes = Buffer.from(monitorPacket(7), 'base64');
    bytes[9] ^= 0x30;
    assert.equal(monitorStatus(bytes.toString('base64')), null);
});
