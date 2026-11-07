'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EcamSoul, supportsSoul } = require('../lib/ecam-soul');

// Frame and CRC fixtures generated with aioecam 60c980f. Timestamp is outside the CRC.
const READY = 'd012750f00000000000700000000000000d6a3';
const READY_SHORT = 'd00d750000000000000700005a3a';
const BUSY = 'd012750f000000000007040000000000001765';
const seconds = () => Math.floor(Date.now() / 1000);
const A2_DRINK_PAGES = [
    ['data_request', '0d08a20f0bba015425', 'd00ba20f0bba000000039a0d'],
    ['data_request', '0d08a20f0bbd058d36', 'd023a20f0bbd0000007f0bbe0000261a0bbf000000010bc0000000000bc100000003590c'],
    ['data_request', '0d08a20f0bc206a532', 'd029a20f0bc2000000400bc3000002bb0bc4000000030bc5000000ad0bc60000000d0bc700000006bd18'],
];

function properties(hex, timestamp = seconds()) {
    const value = Buffer.concat([Buffer.from(hex, 'hex'), Buffer.alloc(4)]);
    value.writeUInt32BE(timestamp, value.length - 4);
    const name = value[2] === 0x75 ? 'd302_monitor' : 'reply';
    return new Map([[name, { value: value.toString('base64') }]]);
}

function simulatedSoul(steps) {
    const session = {
        async exchangeProperty(name, value, { match }) {
            const next = steps.shift();
            assert.ok(next, 'unexpected ECAM operation');
            const [expectedName, request, reply, timestamp] = next;
            assert.equal(name, expectedName);
            if (name === 'device_connected') {
                assert.match(value, /^\d{10}$/);
            } else {
                assert.ok(value.endsWith('\n'));
                assert.equal(Buffer.from(value, 'base64').subarray(0, -4).toString('hex'), request);
            }
            if (!reply && !match) return 'sent';
            if (!reply) throw Error('unconfirmed');
            const result = match(properties(reply, timestamp));
            if (result === undefined) throw Error('unconfirmed');
            return result;
        },
        async readProperty(name, { match }) {
            if (steps[0]?.[0] === name) {
                const [, reply, timestamp] = steps.shift();
                const result = match(properties(reply, timestamp));
                if (result !== undefined) return result;
            }
            if (name === 'data_response') throw Error('unconfirmed');
            assert.equal(name, 'd302_monitor');
            throw Error('unconfirmed');
        },
    };
    return new EcamSoul(session);
}

test('enables Soul commands only for detected Soul models with the expected properties', () => {
    const values = new Map([['data_request', {}], ['d302_monitor', {}]]);
    assert.equal(supportsSoul({ oem_model: 'DL-pd-soul' }, values), true);
    assert.equal(supportsSoul({ model: 'ECAM 612.55' }, values), true);
    assert.equal(supportsSoul({ model: 'ECAM452' }, values), false);
    assert.equal(supportsSoul({ model: 'ECAM612' }, new Map()), false);
});

test('sends one validated power frame and supports coffee, espresso and stop presets', async () => {
    const steps = [
        ['data_request', '0d07840f02015512'], ['data_request', '0d07840f01010041'],
        ['data_request', '0d05750fda25', READY], ['data_request', '0d1183f002011b040100f002030400060ab7'],
        ['data_request', '0d05750fda25', READY], ['data_request', '0d1183f0010101007e1b030202040006afe2'],
        ['data_request', '0d0d83f010020f00fa1b010659a6'],
    ];
    const soul = simulatedSoul(steps);
    for (const action of ['wake', 'off', 'coffee', 'espresso', 'stopDrink']) {
        assert.equal(await soul.button(action), 'sent');
    }
    await assert.rejects(soul.button('factoryReset'), /unsupported-command/);
    await assert.rejects(soul.button('standby'), /unsupported-command/);
    assert.equal(steps.length, 0);
});

test('rejects brew when the ready response is busy, stale or CRC-invalid', async () => {
    for (const [reply, timestamp, error] of [
        [BUSY, seconds(), /machine-not-ready/],
        [READY, seconds() - 60, /monitor-stale/],
        [`${READY.slice(0, -2)}00`, seconds(), /monitor-invalid/],
    ]) {
        const steps = [['data_request', '0d05750fda25', reply, timestamp]];
        await assert.rejects(simulatedSoul(steps).button('coffee'), error);
        assert.equal(steps.length, 0);
    }
});

test('checks readiness without brewing and accepts a short fresh monitor after a stale reply', async () => {
    const steps = [
        ['data_request', '0d05750fda25', READY, seconds() - 60],
        ['d302_monitor', READY_SHORT],
    ];
    assert.equal(await simulatedSoul(steps).button('readStatus'), 'ready');
    assert.equal(steps.length, 0);
});

test('recognizes a new signed monitor even when the device clock runs behind', async () => {
    const earlier = seconds() - 60;
    const steps = [
        ['d302_monitor', READY_SHORT, earlier],
        ['data_request', '0d05750fda25', READY_SHORT, earlier + 1],
    ];
    assert.equal(await simulatedSoul(steps).button('readStatus'), 'ready');
    assert.equal(steps.length, 0);
});

test('explicit at-machine controls accept a cached idle monitor and reject a cached busy monitor', async () => {
    const timestamp = seconds() - 4700;
    const ready = [
        ['d302_monitor', READY_SHORT, timestamp],
        ['data_request', '0d1183f0010101007e1b030202040006afe2'],
    ];
    assert.equal(await simulatedSoul(ready).button('espressoAtMachine'), 'sent');
    assert.equal(ready.length, 0);
    const busy = [['d302_monitor', BUSY, timestamp]];
    await assert.rejects(simulatedSoul(busy).button('coffeeAtMachine'), /machine-not-ready/);
    assert.equal(busy.length, 0);
});

test('stop cancels an in-flight readiness check before a brew can be sent', async () => {
    const commands = [];
    const soul = new EcamSoul({ readProperty: async () => { throw Error('unconfirmed'); }, exchangeProperty(name, value, { signal, match }) {
        const opcode = Buffer.from(value, 'base64')[2];
        commands.push(opcode);
        if (!match) return Promise.resolve('sent');
        return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
        });
    } });
    const brew = assert.rejects(soul.button('coffee'), /cancelled/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await soul.button('stopDrink'), 'sent');
    await brew;
    assert.deepEqual(commands, [0x75, 0x83]);
});

test('writes an allowed setting only after announcing the session and verifies the readback', async () => {
    const steps = [
        ['device_connected'],
        ['data_request', '0d0b900f003e0000000191c2', 'd008900f003e0080a0'],
        ['data_request', '0d0795f0003e56bc', 'd00b95f0003e00000001f68e'],
    ];
    const soul = simulatedSoul(steps);
    await assert.rejects(soul.setSetting('autoOff', 4), /invalid-setting/);
    await assert.rejects(soul.setSetting('waterHardness', '1'), /invalid-setting/);
    assert.equal(await soul.setSetting('autoOff', 1), 1);
    assert.equal(steps.length, 0);
});

test('waits for the new setting after a missing write ACK and an old readback without writing twice', async () => {
    const steps = [
        ['device_connected'],
        ['data_request', '0d0b900f003e0000000191c2'],
        ['data_request', '0d0795f0003e56bc', 'd00b95f0003e00000003d6cc'],
        ['data_request', '0d0795f0003e56bc', 'd00b95f0003e00000001f68e'],
    ];
    const soul = simulatedSoul(steps);
    const first = soul.setSetting('autoOff', 1);
    assert.equal(soul.setSetting('autoOff', 1), first);
    assert.equal(await first, 1);
    assert.equal(steps.length, 0);
});

test('reads both settings without sending a setting write', async () => {
    const steps = [
        ['data_request', '0d0795f0003e56bc'],
        ['d282_mchn_sett_aoff', 'd00b95f0003e00000001f68e'],
        ['data_request', '0d0795f000329730', 'd00b95f00032000000024dc6'],
    ];
    assert.deepEqual(await simulatedSoul(steps).readSettings(), new Map([['autoOff', 1], ['waterHardness', 2]]));
    assert.equal(steps.length, 0);
});

test('decodes direct A2 pages into separate display statistics', async () => {
    const steps = [
        ['data_request', '0d08a20f0bb8020224', 'd011a20f0bb80000275b0bb9000003c6810a'],
        ['data_request', '0d08a20f0bbb016714', 'd00ba20f0bbb0000000660f9'],
        ['data_request', '0d08a20f006904b405'],
        ['data_response', 'd017a20f006900000027006a00575760006c000000239b4e'],
        ['data_request', '0d08a20f0073010818', 'd00ba20f0073000002954776'],
        ...A2_DRINK_PAGES,
    ];
    const { statistics: values, missingPages } = await simulatedSoul(steps).readStatistics();
    assert.deepEqual(missingPages, []);
    assert.deepEqual(Object.fromEntries(values.map(({ id, value }) => [id, value])), {
        descales: 39, waterLitres: 2862, filters: 35, grounds: 661, blackCoffee: 10075, milkCoffee: 966,
        milkOnly: 6, withMilk: 972,
        otherDrinks: 3, espresso: 127, coffee: 9754, longCoffee: 1, doppio: 0, americano: 3,
        cappuccino: 64, latteMacchiato: 699, caffeLatte: 3, flatWhite: 173, espressoMacchiato: 13, hotMilk: 6,
    });
    assert.equal(steps.length, 0);
});

test('rejects an old A2 reply and still reads the remaining statistics pages', async () => {
    const steps = [
        ['data_request', '0d08a20f0bb8020224', 'd011a20f0bb80000275b0bb9000003c6810a'],
        ['data_request', '0d08a20f0bbb016714', 'd00ba20f0bbb0000000660f9'],
        ['data_request', '0d08a20f006904b405'],
        ['data_response', 'd017a20f006900000027006a00575760006c000000239b4e', seconds() - 60],
        ['data_request', '0d08a20f0073010818', 'd00ba20f0073000002954776'],
        ...A2_DRINK_PAGES,
    ];
    const { statistics: values, missingPages } = await simulatedSoul(steps).readStatistics();
    assert.deepEqual(missingPages, [105]);
    assert.equal(values.find(item => item.id === 'withMilk').value, 972);
    assert.equal(values.some(item => item.id === 'waterLitres'), false);
    assert.equal(steps.length, 0);
});
