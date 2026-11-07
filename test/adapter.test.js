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
            ['d556_water_hardness', { value: '96874' }],
        ]),
    };
    await adapter.refresh();
    assert.equal(adapter.states.get('info.connection').val, true);
    assert.equal(adapter.states.get('info.deviceCount').val, 1);
    const coffeeId = [...adapter.states.keys()].find(x => x.endsWith('.counters.coffee'));
    assert.ok(coffeeId);
    assert.equal(adapter.states.get(coffeeId).val, 42);
    assert.equal(adapter.objects.get(coffeeId).common.write, false);
    assert.equal([...adapter.states.keys()].some(x => x.includes('hardness')), false);
    assert.equal(coffeeId.includes('SYNTHETIC-DEVICE-1'), false);
});

test('cloud failure marks connection false without writing cloud values', async () => {
    const adapter = makeAdapter();
    adapter.client = { listDevices: async () => { throw Error('simulated outage'); } };
    await adapter.refresh();
    assert.equal(adapter.states.get('info.connection').val, false);
});
