'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const EventEmitter = require('node:events');

class AdapterStub extends EventEmitter {
    constructor() {
        super();
        this.config = { email: 'synthetic@example.net', password: 'not-a-real-password', pollInterval: 15 };
        this.objects = new Map();
        this.states = new Map();
        this.log = { warn: () => {} };
    }
    async setObjectNotExistsAsync(id, object) {
        if (!this.objects.has(id)) this.objects.set(id, object);
    }
    async setStateAsync(id, state) {
        this.states.set(id, state);
    }
    async getObjectAsync(id) {
        return this.objects.get(id);
    }
    async getStateAsync(id) {
        return this.states.get(id);
    }
    async delObjectAsync(id) {
        this.objects.delete(id);
        this.states.delete(id);
    }
    subscribeStates() {}
}

const previousLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '@iobroker/adapter-core') return { Adapter: AdapterStub };
    return previousLoad.call(this, request, parent, isMain);
};
let makeAdapter;
try {
    makeAdapter = require('../main');
} finally {
    Module._load = previousLoad;
}

test('creates read-only ioBroker states for connected machine', async () => {
    const adapter = makeAdapter();
    adapter.client = {
        listDevices: async () => [{ dsn: 'SYNTHETIC-DEVICE-1', connection_status: 'Online' }],
        readProperties: async () => new Map([
            ['d706_tot_id2_coffee', { value: '42' }],
            ['d711_id8_lattmacc', { value: '12' }],
            ['d700_tot_bev_b', { value: '80', data_updated_at: '2026-10-01T10:00:00Z' }],
            ['d701_tot_bev_bw', { value: '25', data_updated_at: '2026-10-02T10:00:00Z' }],
            ['d556_water_hardness', { value: '96874' }],
        ]),
    };
    await adapter.refresh();
    assert.equal(adapter.states.get('info.connection').val, true);
    assert.equal(adapter.states.get('info.cloud.connected').val, true);
    assert.equal(adapter.states.get('info.deviceCount').val, 1);
    const coffeeId = [...adapter.states.keys()].find(x => x.endsWith('.cloud.counters.coffee'));
    assert.ok(coffeeId);
    assert.equal(adapter.states.get(coffeeId).val, 42);
    assert.equal(adapter.objects.get(coffeeId).common.write, false);
    const machine = coffeeId.slice(0, -'.cloud.counters.coffee'.length);
    assert.equal(adapter.objects.has(`${machine}.counters`), false);
    assert.equal(adapter.objects.has(`${machine}.diagnostics`), false);
    assert.equal(adapter.objects.has(`${machine}.status`), false);
    assert.equal([...adapter.states.keys()].some(x => x.includes('hardness')), false);
    assert.equal(coffeeId.includes('SYNTHETIC-DEVICE-1'), false);
    const blackTime = [...adapter.states.keys()].find(x => x.endsWith('.diagnostics.blackCoffeeCloudUpdatedAt'));
    const milkTime = [...adapter.states.keys()].find(x => x.endsWith('.diagnostics.milkCoffeeCloudUpdatedAt'));
    assert.ok(blackTime);
    assert.ok(milkTime);
    assert.equal(adapter.states.get(blackTime).val, '2026-10-01T10:00:00.000Z');
    assert.equal(adapter.states.get(milkTime).val, '2026-10-02T10:00:00.000Z');
    assert.equal(adapter.objects.get(blackTime).common.write, false);
});

test('moves legacy Cloud states while preserving canonical values and LAN objects', async () => {
    const adapter = makeAdapter();
    const root = 'machines.synthetic';
    await adapter.channel(`${root}.counters`, 'Old counters');
    await adapter.channel(`${root}.diagnostics`, 'Old diagnostics');
    await adapter.state(`${root}.counters.coffee`, 'Coffee', 'number', 'value', 12);
    await adapter.state(`${root}.cloud.counters.coffee`, 'Coffee', 'number', 'value', 15);
    await adapter.state(`${root}.counters.espresso`, 'Espresso', 'number', 'value', 7);
    await adapter.state(`${root}.status`, 'Status', 'string', 'text', 'ready');
    await adapter.state(`${root}.diagnostics.blackCoffeeCloudUpdatedAt`, 'Last update', 'string', 'text', '2026-10-01');
    await adapter.state(`${root}.lan.counters.coffee`, 'Coffee', 'number', 'value', 19);
    await adapter.migrateCloudStates(root);
    assert.deepEqual([...adapter.objects.keys()].sort(), [
        `${root}.cloud.counters.coffee`, `${root}.cloud.counters.espresso`, `${root}.cloud.diagnostics.blackCoffeeCloudUpdatedAt`,
        `${root}.cloud.status`, `${root}.lan.counters.coffee`,
    ]);
    assert.equal(adapter.states.get(`${root}.cloud.counters.coffee`).val, 15);
    assert.equal(adapter.states.get(`${root}.cloud.counters.espresso`).val, 7);
    assert.equal(adapter.states.get(`${root}.lan.counters.coffee`).val, 19);
});

test('cloud failure marks connection false without writing cloud values', async () => {
    const adapter = makeAdapter();
    adapter.client = { listDevices: async () => { throw Error('simulated outage'); } };
    await adapter.refresh();
    assert.equal(adapter.states.get('info.connection').val, false);
    assert.equal(adapter.states.get('info.cloud.connected').val, false);
});

test('records numeric LAN counters separately from cloud values', async () => {
    const adapter = makeAdapter();
    const root = 'machines.synthetic';
    const receivedAt = '2026-11-07T18:32:47.061Z';
    await adapter.recordLanCounters(root, new Map([
        ['d700_tot_bev_b', { value: 42 }],
        ['d701_tot_bev_bw', { value: '7' }],
        ['d706_tot_id2_coffee', { value: 'invalid' }],
    ]), receivedAt);
    assert.deepEqual(adapter.states.get(`${root}.lan.counters.blackCoffee`), { val: 42, ack: true });
    assert.deepEqual(adapter.states.get(`${root}.lan.counters.milkCoffee`), { val: 7, ack: true });
    assert.equal(adapter.objects.get(`${root}.lan.counters.blackCoffee`).common.write, false);
    assert.equal(adapter.states.get(`${root}.lan.receivedAt`).val, receivedAt);
    assert.equal(adapter.states.get('info.lan.lastAuthenticatedAt').val, receivedAt);
    assert.equal(adapter.states.has(`${root}.lan.counters.coffee`), false);
    assert.equal(adapter.states.has(`${root}.counters.blackCoffee`), false);
});

test('removes the legacy LAN counters for a Soul and keeps direct statistics as its only source', async () => {
    const adapter = makeAdapter();
    const root = 'machines.synthetic';
    adapter.activeLanDevice = root;
    adapter.soul = {};
    await adapter.channel(`${root}.lan.counters`, 'Old LAN counters');
    await adapter.state(`${root}.lan.counters.blackCoffee`, 'Black coffee', 'number', 'value', 10009);
    await adapter.state(`${root}.lan.statistics.blackCoffee`, 'Black coffee', 'number', 'value', 10077);
    await adapter.removeLegacyLanCounters(root);
    await adapter.recordLanCounters(root, new Map([['d700_tot_bev_b', { value: 10009 }]]), '2026-11-07T20:35:12.549Z');
    assert.equal(adapter.objects.has(`${root}.lan.counters`), false);
    assert.equal(adapter.states.has(`${root}.lan.counters.blackCoffee`), false);
    assert.equal(adapter.states.get(`${root}.lan.statistics.blackCoffee`).val, 10077);
    assert.equal(adapter.states.get('info.lan.lastAuthenticatedAt').val, '2026-11-07T20:35:12.549Z');
});

test('routes only recent, explicit control writes for the opted-in LAN machine', async () => {
    const adapter = makeAdapter();
    adapter.namespace = 'coffeelink.0';
    adapter.activeLanDevice = 'machines.synthetic';
    const root = 'machines.synthetic.lan.control';
    const calls = [];
    adapter.soul = {
        button: async name => { calls.push(name); return 'sent'; },
        setSetting: async (name, value) => { calls.push([name, value]); return value; },
    };
    const click = { val: true, ack: false, ts: Date.now() };
    const button = `coffeelink.0.${root}.coffee`;
    await adapter.onControlState(button, click);
    adapter.config.lanControlEnabled = true;
    await adapter.onControlState(button, { ...click, ack: true });
    await adapter.onControlState(button, { ...click, ts: click.ts - 10000 });
    await adapter.onControlState('coffeelink.0.machines.other.lan.control.coffee', click);
    await adapter.onControlState(button, click);
    assert.deepEqual(calls, ['coffee']);
    assert.deepEqual(adapter.states.get(`${root}.coffee`), { val: false, ack: true });
    assert.equal(adapter.states.get(`${root}.result`).val, 'coffee: sent');
    await adapter.onControlState(`coffeelink.0.${root}.autoOff`, { val: 1, ack: false, ts: Date.now() });
    assert.deepEqual(calls, ['coffee', ['autoOff', 1]]);
    assert.deepEqual(adapter.states.get(`${root}.autoOff`), { val: 1, ack: true });
    assert.equal(adapter.states.get(`${root}.autoOffResult`).val, 'confirmed');
    assert.equal(adapter.states.get(`${root}.result`).val, 'autoOff: confirmed');
    adapter.lanReceiver = { sessionVerified: true };
    adapter.soul.readStatistics = async () => ({
        statistics: [{ id: 'blackCoffee', label: 'Black coffee beverages', value: 10075 }], missingPages: [],
    });
    await adapter.onControlState(`coffeelink.0.${root}.readStatistics`, { ...click, ts: Date.now() });
    assert.equal(adapter.states.get('machines.synthetic.lan.statistics.blackCoffee').val, 10075);
    assert.equal(adapter.states.get(`${root}.result`).val, 'readStatistics: confirmed');
    adapter.soul.readSettings = async () => new Map([['autoOff', 2], ['waterHardness', 1]]);
    await adapter.onControlState(`coffeelink.0.${root}.readSettings`, { ...click, ts: Date.now() });
    assert.deepEqual(adapter.states.get(`${root}.autoOff`), { val: 2, ack: true });
    assert.deepEqual(adapter.states.get(`${root}.waterHardness`), { val: 1, ack: true });
    assert.equal(adapter.states.get(`${root}.result`).val, 'readSettings: confirmed');
});

test('a mismatched setting clears the pending input with the machine value and reports the failure', async () => {
    const adapter = makeAdapter();
    adapter.namespace = 'coffeelink.0';
    adapter.activeLanDevice = 'machines.synthetic';
    adapter.config.lanControlEnabled = true;
    adapter.soul = { setSetting: async () => {
        throw Object.assign(new Error('setting-readback-mismatch'), { actual: 3 });
    } };
    const root = 'machines.synthetic.lan.control';
    await adapter.onControlState(`coffeelink.0.${root}.autoOff`, { val: 1, ack: false, ts: Date.now() });
    assert.deepEqual(adapter.states.get(`${root}.autoOff`), { val: 3, ack: true });
    assert.equal(adapter.states.get(`${root}.autoOffResult`).val, 'setting-readback-mismatch');
    assert.equal(adapter.states.get(`${root}.result`).val, 'autoOff: setting-readback-mismatch');
});

test('replaces the old standby control with off', async () => {
    const adapter = makeAdapter();
    const id = 'machines.synthetic.lan.control.standby';
    const off = 'machines.synthetic.lan.control.off';
    await adapter.setObjectNotExistsAsync(id, { type: 'state', common: { name: 'Switch to standby', write: true } });
    await adapter.setupControls('machines.synthetic');
    assert.equal(adapter.objects.has(id), false);
    assert.equal(adapter.objects.get(off).common.name, 'Switch machine off');
    assert.equal(adapter.objects.get(off).common.write, true);
    assert.deepEqual(adapter.states.get(off), { val: false, ack: true });
});
