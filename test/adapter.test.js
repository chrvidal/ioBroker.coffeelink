'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const EventEmitter = require('node:events');
const { CoffeeLanSession } = require('../lib/lan-session');

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
    async extendObjectAsync(id, object) {
        Object.assign(this.objects.get(id).common, object.common);
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

test('moves legacy Cloud states and removes obsolete LAN buttons while preserving measurements', async () => {
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
    await adapter.channel(`${root}.lan.automation`, 'Automation');
    await adapter.channel(`${root}.lan.control.drinks`, 'Drinks');
    await adapter.state(`${root}.lan.control.drinks.coffee`, 'Coffee', 'boolean', 'button', false);
    await adapter.state(`${root}.lan.diagnostics.readCoffeeRecipe`, 'Read saved coffee amount', 'boolean', 'button', false);
    await adapter.state(`${root}.lan.automation.coffee`, 'Coffee', 'boolean', 'button', true);
    await adapter.state(`${root}.lan.automation.espresso`, 'Espresso', 'boolean', 'button', true);
    await adapter.state(`${root}.lan.receivedAt`, 'Old LAN timestamp', 'string', 'text', '2026-11-01');
    await adapter.migrateDeviceStates(root);
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

test('reports unsupported LAN models while keeping cloud data available', async () => {
    const adapter = makeAdapter();
    adapter.lanReceiver = new CoffeeLanSession({ host: '192.168.12.33', machineIp: '192.168.12.39' });
    adapter.client = {
        listDevices: async () => [{ dsn: 'OTHER-MODEL', model: 'ECAM450.65', connection_status: 'Online' }],
        readProperties: async () => new Map([['d706_tot_id2_coffee', { value: '42' }]]),
    };
    await adapter.refresh();
    assert.equal(adapter.states.get('info.lan.status').val, 'unsupported-model');
    assert.equal(adapter.states.get('info.cloud.connected').val, true);
    assert.equal([...adapter.objects.keys()].some(id => id.startsWith('machines.') && id.endsWith('.lan')), false);
});

test('upgrades read-only LAN without implicitly enabling controls', () => {
    const adapter = makeAdapter();
    assert.equal(adapter.lanEnabled, false);
    Object.assign(adapter.config, { lanReceiverEnabled: true, lanActiveEnabled: true, lanControlEnabled: false, lanEnabled: null });
    assert.equal(adapter.lanEnabled, true);
    assert.equal(adapter.lanControlsEnabled, false);
    adapter.config.lanControlEnabled = true;
    assert.equal(adapter.lanControlsEnabled, true);
    adapter.config.lanEnabled = false;
    assert.equal(adapter.lanEnabled, false);
    assert.equal(adapter.lanControlsEnabled, false);
    adapter.config.lanEnabled = true;
    adapter.config.lanControlEnabled = false;
    assert.equal(adapter.lanControlsEnabled, true);
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
    assert.equal(adapter.objects.has(`${root}.lan.counters`), false);
    assert.equal(adapter.states.has(`${root}.lan.counters.blackCoffee`), false);
    assert.equal(adapter.states.get(`${root}.lan.statistics.blackCoffee`).val, 10077);
});

test('routes only recent, explicit control writes for the opted-in LAN machine', async () => {
    const adapter = makeAdapter();
    adapter.namespace = 'coffeelink.0';
    adapter.activeLanDevice = 'machines.synthetic';
    const lan = 'machines.synthetic.lan';
    const root = `${lan}.control`;
    const drinks = `${root}.profiles.profile1`;
    const automation = `${lan}.automation`;
    const diagnostics = `${lan}.diagnostics`;
    const calls = [];
    adapter.soul = {
        profileNames: new Map([[1, 'Kitchen']]),
        button: async (name, { profile }) => { calls.push([name, profile]); return 'sent'; },
        setSetting: async (name, value) => { calls.push([name, value]); return value; },
    };
    const click = { val: true, ack: false, ts: Date.now() };
    const button = `coffeelink.0.${drinks}.coffee`;
    await adapter.onControlState(button, click);
    adapter.config.lanEnabled = true;
    await adapter.onControlState(button, { ...click, ack: true });
    await adapter.onControlState(button, { ...click, ts: click.ts - 10000 });
    await adapter.onControlState('coffeelink.0.machines.other.lan.control.profiles.profile1.coffee', click);
    await adapter.onControlState(`coffeelink.0.${root}.drinks.coffee`, click);
    await adapter.onControlState(`coffeelink.0.${root}.coffee`, click);
    await adapter.onControlState(`coffeelink.0.${root}.coffeeAtMachine`, click);
    await adapter.onControlState(`coffeelink.0.${automation}.coffee`, click);
    await adapter.onControlState(`coffeelink.0.${diagnostics}.off`, click);
    await adapter.onControlState(button, click);
    assert.deepEqual(calls, [['coffee', 1]]);
    assert.deepEqual(adapter.states.get(`${drinks}.coffee`), { val: false, ack: true });
    assert.equal(adapter.states.get(`${diagnostics}.result`).val, 'control.profiles.profile1.coffee: sent');
    await adapter.onControlState(`coffeelink.0.${root}.autoOff`, { val: 1, ack: false, ts: Date.now() });
    assert.deepEqual(calls, [['coffee', 1], ['autoOff', 1]]);
    assert.deepEqual(adapter.states.get(`${root}.autoOff`), { val: 1, ack: true });
    assert.equal(adapter.states.get(`${diagnostics}.autoOffResult`).val, 'confirmed');
    assert.equal(adapter.states.get(`${diagnostics}.result`).val, 'autoOff: confirmed');
    adapter.lanReceiver = { sessionVerified: true };
    adapter.soul.readStatistics = async () => ({
        statistics: [{ id: 'blackCoffee', label: 'Black coffee beverages', value: 10075 }], missingPages: [],
    });
    await adapter.onControlState(`coffeelink.0.${diagnostics}.readStatistics`, { ...click, ts: Date.now() });
    assert.equal(adapter.states.get('machines.synthetic.lan.statistics.blackCoffee').val, 10075);
    assert.equal(adapter.states.get(`${diagnostics}.result`).val, 'readStatistics: confirmed');
    adapter.soul.readSettings = async () => new Map([['autoOff', 2], ['waterHardness', 1]]);
    await adapter.onControlState(`coffeelink.0.${diagnostics}.readSettings`, { ...click, ts: Date.now() });
    assert.deepEqual(adapter.states.get(`${root}.autoOff`), { val: 2, ack: true });
    assert.deepEqual(adapter.states.get(`${root}.waterHardness`), { val: 1, ack: true });
    assert.equal(adapter.states.get(`${diagnostics}.result`).val, 'readSettings: confirmed');
});

test('a mismatched setting clears the pending input with the machine value and reports the failure', async () => {
    const adapter = makeAdapter();
    adapter.namespace = 'coffeelink.0';
    adapter.activeLanDevice = 'machines.synthetic';
    adapter.config.lanEnabled = true;
    adapter.soul = { setSetting: async () => {
        throw Object.assign(new Error('setting-readback-mismatch'), { actual: 3 });
    } };
    const root = 'machines.synthetic.lan.control';
    const diagnostics = 'machines.synthetic.lan.diagnostics';
    await adapter.onControlState(`coffeelink.0.${root}.autoOff`, { val: 1, ack: false, ts: Date.now() });
    assert.deepEqual(adapter.states.get(`${root}.autoOff`), { val: 3, ack: true });
    assert.equal(adapter.states.get(`${diagnostics}.autoOffResult`).val, 'setting-readback-mismatch');
    assert.equal(adapter.states.get(`${diagnostics}.result`).val, 'autoOff: setting-readback-mismatch');
});

test('a second drink press leaves the first command and its result pending', async () => {
    const adapter = makeAdapter();
    adapter.namespace = 'coffeelink.0';
    adapter.activeLanDevice = 'machines.synthetic';
    adapter.config.lanEnabled = true;
    const lan = 'machines.synthetic.lan';
    const button = `${lan}.control.profiles.profile1.coffee`;
    let complete;
    let calls = 0;
    adapter.soul = {
        profileNames: new Map([[1, 'Kitchen']]),
        button: () => {
            calls++;
            return new Promise(resolve => { complete = resolve; });
        },
    };
    const click = { val: true, ack: false, ts: Date.now() };
    const first = adapter.onControlState(`coffeelink.0.${button}`, click);
    await adapter.onControlState(`coffeelink.0.${button}`, click);
    assert.equal(calls, 1);
    assert.equal(adapter.states.get(`${lan}.diagnostics.result`).val, 'control.profiles.profile1.coffee: pending');
    complete('sent');
    await first;
    assert.equal(adapter.states.get(`${lan}.diagnostics.result`).val, 'control.profiles.profile1.coffee: sent');
});

test('replaces the old standby control with off', async () => {
    const adapter = makeAdapter();
    const id = 'machines.synthetic.lan.control.standby';
    const off = 'machines.synthetic.lan.control.off';
    await adapter.setObjectNotExistsAsync(id, { type: 'state', common: { name: 'Switch to standby', write: true } });
    await adapter.setupControls('machines.synthetic');
    assert.equal(adapter.objects.has(id), false);
    assert.equal(adapter.objects.get(off).common.name, 'Switch off');
    assert.equal(adapter.objects.get(off).common.write, true);
    assert.deepEqual(adapter.states.get(off), { val: false, ack: true });
});

test('migrates LAN buttons and results, keeping only direct controls and settings under control', async () => {
    const adapter = makeAdapter();
    const root = 'machines.synthetic';
    const prefix = `${root}.lan.control`;
    await adapter.channel(prefix, 'ECAM61x LAN control');
    await adapter.setObjectNotExistsAsync(`${prefix}.coffee`, { type: 'state', common: { name: 'Start coffee (preset)' } });
    await adapter.setObjectNotExistsAsync(`${prefix}.espresso`, { type: 'state', common: { name: 'My espresso button' } });
    await adapter.setObjectNotExistsAsync(`${prefix}.wake`, { type: 'state', common: { name: { en: 'Wake machine from standby', de: 'Maschine aus Standby wecken' } } });
    await adapter.setObjectNotExistsAsync(`${prefix}.coffeeAtMachine`, {
        type: 'state', common: { name: { en: 'Start coffee (at the machine)', de: 'Kaffee starten (an der Maschine)' } },
    });
    for (const id of ['readStatus', 'readSettings', 'readStatistics', 'result', 'autoOffResult', 'waterHardnessResult']) {
        await adapter.setObjectNotExistsAsync(`${prefix}.${id}`, { type: 'state', common: {} });
    }
    await adapter.setStateAsync(`${prefix}.coffee`, { val: true, ack: false });
    await adapter.setStateAsync(`${prefix}.autoOff`, { val: 2, ack: true });
    await adapter.setupControls(root);
    await adapter.setupControls(root);
    assert.equal(adapter.objects.get(prefix).common.name, 'Controls');
    assert.deepEqual([...adapter.objects.keys()].filter(id => id.startsWith(`${prefix}.`)).map(id => id.slice(prefix.length + 1)).sort(),
        ['autoOff', 'off', 'stopDrink', 'wake', 'waterHardness']);
    const diagnostics = `${root}.lan.diagnostics`;
    assert.equal(adapter.objects.has(`${root}.lan.automation`), false);
    assert.equal(adapter.objects.get(`${prefix}.wake`).common.name, 'Wake from standby');
    assert.deepEqual(adapter.states.get(`${prefix}.autoOff`), { val: 2, ack: true });
    for (const id of ['readStatus', 'readSettings', 'readStatistics']) {
        assert.equal(adapter.objects.get(`${diagnostics}.${id}`).common.role, 'button');
    }
    for (const id of ['result', 'autoOffResult', 'waterHardnessResult']) {
        assert.equal(adapter.objects.get(`${diagnostics}.${id}`).common.write, false);
    }
});

test('exposes available profile drinks as direct LAN buttons', async () => {
    const adapter = makeAdapter();
    const root = 'machines.synthetic';
    const profiles = `${root}.lan.control.profiles`;
    const cappuccino = `${profiles}.profile1.cappuccino`;
    const legacy = `${root}.lan.control.cappuccinoAtMachine`;
    const unavailable = `${profiles}.profile1.caffeLatte`;
    adapter.activeLanDevice = root;
    adapter.namespace = 'coffeelink.0';
    adapter.config.lanEnabled = true;
    await adapter.setObjectNotExistsAsync(root, { type: 'device', common: { name: 'Coffee Link machine' } });
    await adapter.setObjectNotExistsAsync(legacy, { type: 'state', common: { name: 'Start Cappuccino (at the machine)' } });
    await adapter.setObjectNotExistsAsync(unavailable, { type: 'state', common: {} });
    const recipe = Buffer.from('d017a6f001071c0219010100281b0102030900d20400778c', 'hex').toString('base64');
    const names = Buffer.from('d047a4f00103004b00690074006300680065006e0000000000000100470075006500730074000000000000000000000100540068006900720064000000000000000000000100e318', 'hex').toString('base64');
    const properties = new Map([
        ['data_request', {}], ['d302_monitor', {}], ['d045_1_rec_cappuccino', { value: recipe }],
        ['d034_profiles_1_3', { value: names }],
    ]);
    await adapter.prepareSoul(root, { model: 'ECAM612.55' }, properties);
    assert.equal(adapter.objects.get(root).common.name, 'PrimaDonna Soul');
    assert.equal(adapter.objects.get(cappuccino).common.name, 'Start Cappuccino');
    assert.equal(adapter.objects.get(cappuccino).common.write, true);
    assert.equal(adapter.objects.has(unavailable), false);
    assert.equal(adapter.objects.has(legacy), false);
    const calls = [];
    adapter.soul.button = async (action, { profile }) => { calls.push([action, profile]); return 'sent'; };
    await adapter.onControlState(`${adapter.namespace}.${cappuccino}`, { val: true, ack: false, ts: Date.now() });
    assert.equal(adapter.objects.get(`${profiles}.profile1`).common.name, 'Kitchen');
    assert.equal(adapter.objects.get(`${profiles}.profile2`).common.name, 'Guest');
    assert.equal(adapter.objects.get(`${profiles}.profile3`).common.name, 'Third');
    assert.equal(adapter.objects.has(`${profiles}.profile4`), false);
    assert.equal(adapter.objects.has(`${profiles}.profile1.cappuccino`), true);
    assert.equal(adapter.objects.has(`${profiles}.profile2.cappuccino`), false);
    for (const slot of [2, 4]) {
        await adapter.onControlState(`${adapter.namespace}.${profiles}.profile${slot}.coffee`, { val: true, ack: false, ts: Date.now() });
    }
    assert.equal(adapter.objects.has(`${root}.lan.control.drinks`), false);
    assert.deepEqual(calls, [['cappuccino', 1], ['coffee', 2]]);
    assert.deepEqual(adapter.states.get(cappuccino), { val: false, ack: true });
});
