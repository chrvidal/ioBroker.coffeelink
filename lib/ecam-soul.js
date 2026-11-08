'use strict';

const { COUNTERS, crc16CcittAug } = require('./measurements');
const { setTimeout: delay } = require('node:timers/promises');

const BUTTONS = Object.freeze({
    wake: 'Wake from standby',
    off: 'Switch off',
    coffee: 'Start Coffee',
    espresso: 'Start Espresso',
    stopDrink: 'Stop drink',
    readStatus: 'Check machine readiness',
});
const MONITOR = 'd302_monitor';
const MONITOR_MAX_AGE = 10;
const TRANSIENT_PREFLIGHT_ERRORS = new Set(['session-ended', 'lan-unavailable', 'not-delivered']);
const SETTINGS = Object.freeze({
    autoOff: { id: 0x003e, label: 'Auto-off delay', property: 'd282_mchn_sett_aoff', options: { 0: '15 min', 1: '30 min', 2: '1 h', 3: '3 h' } },
    waterHardness: { id: 0x0032, label: 'Water hardness', options: { 0: 'Level 1', 1: 'Level 2', 2: 'Level 3', 3: 'Level 4' } },
});

const STOP_DRINK = Buffer.from('10020f00fa1b0106', 'hex');
// Recipe property suffixes and beverage IDs. Hidden and display-only recipes are omitted.
const PROFILE_RECIPES = {
    coffee: ['regular', 0x02],
    espresso: ['espresso', 0x01],
    longCoffee: ['long_coffee', 0x03, 'Long Coffee'],
    doubleEspresso: ['2x_espresso', 0x04, '2× Espresso'],
    doppio: ['doppio', 0x05, 'Doppio+'],
    americano: ['americano', 0x06, 'Americano'],
    cappuccino: ['cappuccino', 0x07, 'Cappuccino'],
    latteMacchiato: ['latte_macchiato', 0x08, 'Latte Macchiato'],
    caffeLatte: ['caffelatte', 0x09, 'Caffè Latte'],
    flatWhite: ['flat_white', 0x0a, 'Flat White'],
    espressoMacchiato: ['espr_macchiato', 0x0b, 'Espresso Macchiato'],
    hotMilk: ['hot_milk', 0x0c, 'Hot Milk'],
    cappuccinoPlus: ['capp_doppio', 0x0d, 'Cappuccino+'],
    cappuccinoMix: ['capp_reverse', 0x0f, 'Cappuccino Mix'],
    hotWater: ['hot_water', 0x10, 'Hot Water'],
    cortado: ['cortado', 0x18, 'Cortado'],
};
const PROFILE_DRINK_BUTTONS = Object.fromEntries(Object.entries(PROFILE_RECIPES)
    .filter(([, [, , label]]) => label)
    .map(([action, [, , label]]) => [action, `Start ${label}`]));
const RECIPE_QUANTITY_TAGS = new Set([0x01, 0x09, 0x0f]);
const EXTRA_PREPARE_TAGS = new Set([0x1b, 0x1c, 0x1f, 0x21, 0x26, 0x27]);
const COUNTER_LABELS = new Map(COUNTERS.map(([id, , label]) => [id, label]));
const A2_DRINK_COUNTERS = [
    [3002, 'otherDrinks'], [3005, 'espresso'], [3006, 'coffee'], [3007, 'longCoffee'],
    [3008, 'doppio'], [3009, 'americano'], [3010, 'cappuccino'], [3011, 'latteMacchiato'],
    [3012, 'caffeLatte'], [3013, 'flatWhite'], [3014, 'espressoMacchiato'], [3015, 'hotMilk'],
];
const STATISTICS = new Map([
    [105, { id: 'descales', label: 'Descaling cycles' }],
    [106, { id: 'waterLitres', label: 'Total water', unit: 'l', divisor: 2000 }],
    [108, { id: 'filters', label: 'Filters used' }],
    [115, { id: 'grounds', label: 'Grounds container cleans' }],
    [3000, { id: 'blackCoffee', label: 'Black coffee beverages' }],
    [3001, { id: 'milkCoffee', label: 'Coffee with milk beverages' }],
    [3003, { id: 'milkOnly', label: 'Milk-only beverages' }],
    ...A2_DRINK_COUNTERS.map(([number, id]) => [number, { id, label: COUNTER_LABELS.get(id) }]),
]);
const STATISTICS_PAGES = [
    [3000, 2, [3000, 3001]], [3003, 1, [3003]], [105, 4, [105, 106, 108]], [115, 1, [115]],
    [3002, 1, [3002]], [3005, 5, [3005, 3006, 3007, 3008, 3009]],
    [3010, 6, [3010, 3011, 3012, 3013, 3014, 3015]],
];

function supportsSoul(device, properties) {
    return properties.has('data_request') && properties.has('d302_monitor') &&
        [device.model, device.oem_model, device.product_name].some(value => typeof value === 'string' &&
            /ECAM\s*61[023](?!\d)|prima\s*donna\s*soul|^dl-(?:pd-soul|millcore)$/i.test(value));
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

function requestValue(opcode, flags, payload, timestamp) {
    const body = Buffer.concat([Buffer.from([0x0d, payload.length + 5, opcode, flags]), payload]);
    const value = Buffer.alloc(body.length + 6);
    body.copy(value);
    value.writeUInt16BE(crc16CcittAug(body), body.length);
    value.writeUInt32BE(timestamp, body.length + 2);
    return `${value.toString('base64')}\n`;
}

function responseFrame(value, opcode) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) return;
    const frame = Buffer.from(value.trim(), 'base64');
    const end = frame[1] + 1;
    if (frame[0] !== 0xd0 || frame[2] !== opcode || end < 6 || end > frame.length) return;
    const checksum = end - 2;
    if (frame.readUInt16BE(checksum) !== crc16CcittAug(frame.subarray(0, checksum))) return;
    return {
        data: frame.subarray(4, checksum),
        flags: frame[3],
        timestamp: frame.length >= end + 4 ? frame.readUInt32BE(end) : null,
    };
}

function getProfileNames(properties) {
    const names = new Map();
    for (const [key, { value }] of properties) {
        if (!/^d\d+_profiles_\d_\d$/.test(key)) continue;
        const frame = responseFrame(value, 0xa4);
        if (!frame || frame.flags !== 0xf0) continue;
        const { data } = frame;
        const first = data[0];
        const last = data[1];
        if (!(first >= 1 && last >= first && last <= 5)) continue;
        const entriesEnd = 2 + (last - first + 1) * 21;
        // Some Soul firmware appends one zero byte after the profile entries.
        if (data.length !== entriesEnd && !(data.length === entriesEnd + 1 && data[entriesEnd] === 0)) continue;
        for (let slot = first; slot <= last; slot++) {
            const offset = 2 + (slot - first) * 21;
            const name = Buffer.from(data.subarray(offset, offset + 20)).swap16().toString('utf16le').split('\0', 1)[0].trim();
            if (name && !/[\x00-\x1f\x7f]/.test(name)) names.set(slot, name);
        }
    }
    return names;
}

function parseProfileDrink(frame, profile, beverage) {
    if (!frame || frame.flags !== 0xf0 || frame.data[0] !== profile || frame.data[1] !== beverage) return;
    const recipe = frame.data;
    const fields = [];
    const seen = new Set();
    let visible = false;
    let hasQuantity = false;
    let coffeeMl;
    for (let offset = 2; offset < recipe.length;) {
        const tag = recipe[offset];
        const quantity = RECIPE_QUANTITY_TAGS.has(tag);
        const end = offset + (quantity ? 3 : 2);
        if (end > recipe.length || seen.has(tag)) return;
        seen.add(tag);
        if (tag === 0x19) visible = recipe[offset + 1] === 1;
        if (quantity && recipe.readUInt16BE(offset + 1) > 0) hasQuantity = true;
        if (tag === 0x01) coffeeMl = recipe.readUInt16BE(offset + 1);
        // Keep the machine's tag order. Drop recipe metadata and the legacy double flag.
        if ((tag < 23 && tag !== 0x08) || EXTRA_PREPARE_TAGS.has(tag)) fields.push(recipe.subarray(offset, end));
        offset = end;
    }
    if (!visible || !hasQuantity || (beverage <= 2 && !coffeeMl)) return;
    // The profile occupies the upper bits. Operation 2 prepares without saving.
    return Buffer.concat([Buffer.from([beverage, 0x01]), ...fields, Buffer.from([(profile << 2) | 2])]);
}

class EcamSoul {
    constructor(session, properties = new Map()) {
        this.session = session;
        this.profileNames = getProfileNames(properties);
        this.drinksByProfile = new Map();
        const recipeDefinitions = new Map(Object.entries(PROFILE_RECIPES).map(([action, [suffix, beverage]]) => [suffix, { action, beverage }]));
        for (const [key, { value }] of properties) {
            const match = /^d\d+_([1-5])_rec_(\w+)$/.exec(key);
            const definition = match && recipeDefinitions.get(match[2]);
            if (!definition) continue;
            const slot = Number(match[1]);
            if (!this.profileNames.has(slot)) continue;
            if (!parseProfileDrink(responseFrame(value, 0xa6), slot, definition.beverage)) continue;
            if (!this.drinksByProfile.has(slot)) this.drinksByProfile.set(slot, new Set());
            this.drinksByProfile.get(slot).add(definition.action);
        }
        this.operation = null;
        this.pendingSetting = null;
    }

    async #run(task, priority = 1) {
        if (this.operation && priority > this.operation.priority) {
            this.operation.controller.abort();
            await this.operation.done.catch(() => {});
        }
        if (this.operation) throw new Error('busy');
        const controller = new AbortController();
        const done = task(controller.signal);
        this.operation = { controller, done, priority };
        try { return await done; } finally { this.operation = null; }
    }

    async #request(opcode, flags, payload, signal, accept, timeoutMs, readBack) {
        const timestamp = nowSeconds();
        const match = accept && (properties => {
            for (const { value } of properties.values()) {
                const frame = responseFrame(value, opcode);
                if (!frame || (frame.timestamp !== null && frame.timestamp < timestamp - 1)) continue;
                const result = accept(frame);
                if (result !== undefined) return result;
            }
        });
        try {
            return await this.session.exchangeProperty('data_request', requestValue(opcode, flags, payload, timestamp),
                { signal, match, timeoutMs });
        } catch (error) {
            if (!readBack || error.message !== 'unconfirmed') throw error;
            // The LAN module can retain a reply without publishing a push.
            return this.session.readProperty(readBack, { signal, match, timeoutMs: 4000 });
        }
    }

    async #monitor(signal, operatorConfirmed = false) {
        let unavailable = 'monitor-no-response';
        const parse = properties => {
            const monitor = properties.get(MONITOR);
            if (!monitor) return;
            const frame = responseFrame(monitor.value, 0x75);
            if (!frame || frame.data.length < 8) {
                unavailable = 'monitor-invalid';
                return;
            }
            if (frame.timestamp === null || frame.timestamp === 0) {
                unavailable = 'monitor-no-timestamp';
                return;
            }
            const { data } = frame;
            return { status: data[5], action: data[6], timestamp: frame.timestamp };
        };
        let baseline;
        try {
            baseline = await this.session.readProperty(MONITOR, { signal, timeoutMs: 2000, match: parse });
        } catch (error) {
            if (error.message !== 'unconfirmed') throw error;
        }
        const fresh = monitor => {
            const age = nowSeconds() - monitor.timestamp;
            if (age >= -2 && age <= MONITOR_MAX_AGE) return monitor;
            const reason = age < -2 ? 'monitor-clock-skew' : 'monitor-stale';
            unavailable = `${reason} (age=${age}s status=${monitor.status} action=${monitor.action})`;
        };
        if (baseline && ((operatorConfirmed && baseline.status === 7 && baseline.action === 0) || fresh(baseline))) return baseline;
        const match = properties => {
            const monitor = parse(properties);
            if (!monitor) return;
            // A newer report from the same signed property also proves freshness
            // when the machine and ioBroker clocks disagree.
            if (baseline && monitor.timestamp > baseline.timestamp) return monitor;
            return fresh(monitor);
        };
        try {
            const value = requestValue(0x75, 0x0f, Buffer.alloc(0), nowSeconds());
            return await this.session.exchangeProperty('data_request', value, { match, signal, timeoutMs: 2500 });
        } catch (error) {
            if (error.message !== 'unconfirmed') throw error;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                return await this.session.readProperty(MONITOR, { signal, timeoutMs: 2000, match });
            } catch (error) {
                if (error.message !== 'unconfirmed') throw error;
            }
        }
        throw new Error(unavailable);
    }

    async #readProfileDrink(profile, beverage, signal) {
        try {
            return await this.#request(0xa6, 0xf0, Buffer.from([profile, beverage]), signal,
                frame => parseProfileDrink(frame, profile, beverage), 5000);
        } catch (error) {
            if (error.message === 'unconfirmed') throw Error('recipe-unconfirmed');
            throw error;
        }
    }

    async #prepareDrink(profile, beverage, signal) {
        for (let attempt = 0; ; attempt++) {
            try {
                const { status, action } = await this.#monitor(signal, true);
                if (status !== 7 || action !== 0) throw new Error('machine-not-ready');
                return await this.#readProfileDrink(profile, beverage, signal);
            } catch (error) {
                if (attempt === 1 || !TRANSIENT_PREFLIGHT_ERRORS.has(error.message)) throw error;
                await delay(900, undefined, { signal });
            }
        }
    }

    button(name, { profile } = {}) {
        const isDrink = Object.hasOwn(PROFILE_RECIPES, name);
        if (!isDrink && !Object.hasOwn(BUTTONS, name)) {
            return Promise.reject(new Error('unsupported-command'));
        }
        if (isDrink && !this.profileNames.has(profile)) {
            return Promise.reject(new Error('profile-unavailable'));
        }
        return this.#run(async signal => {
            if (name === 'readStatus') {
                const { status, action } = await this.#monitor(signal);
                if (status === 7) return action === 0 ? 'ready' : 'busy';
                return status === 0 ? 'standby' : `status-${status}`;
            }
            if (name === 'wake' || name === 'off') {
                return this.#request(0x84, 0x0f, Buffer.from([name === 'wake' ? 2 : 1, 1]), signal);
            }
            if (name === 'stopDrink') return this.#request(0x83, 0xf0, STOP_DRINK, signal);
            const payload = await this.#prepareDrink(profile, PROFILE_RECIPES[name][1], signal);
            return this.#request(0x83, 0xf0, payload, signal);
        }, name === 'stopDrink' ? 2 : 1);
    }

    #readSetting(name, signal) {
        const { id, property, options } = SETTINGS[name];
        const param = Buffer.alloc(2);
        param.writeUInt16BE(id);
        return this.#request(0x95, 0xf0, param, signal, ({ data }) => {
            if (data.length < 6) return;
            const offset = 2 + (id - data.readUInt16BE(0)) * 4;
            if (offset < 2 || offset + 4 > data.length) return;
            const value = data.readUInt32BE(offset);
            if (Object.hasOwn(options, value)) return value;
        }, 5000, property || 'data_response');
    }

    readSettings() {
        return this.#run(async signal => {
            const values = new Map();
            for (const name of Object.keys(SETTINGS)) {
                try {
                    values.set(name, await this.#readSetting(name, signal));
                } catch (error) {
                    if (error.message !== 'unconfirmed') throw error;
                }
            }
            return values;
        });
    }

    setSetting(name, value) {
        if (!Object.hasOwn(SETTINGS, name) || !Number.isInteger(value) || !Object.hasOwn(SETTINGS[name].options, value)) {
            return Promise.reject(new Error('invalid-setting'));
        }
        if (this.pendingSetting) {
            const pending = this.pendingSetting;
            return pending.name === name && pending.value === value ? pending.done : Promise.reject(new Error('busy'));
        }
        const { id } = SETTINGS[name];
        const done = this.#run(async signal => {
            await this.session.exchangeProperty('device_connected', String(nowSeconds()), { signal });
            const write = Buffer.alloc(6);
            write.writeUInt16BE(id);
            write.writeUInt32BE(value, 2);
            try {
                const accepted = await this.#request(0x90, 0x0f, write, signal, ({ data }) => {
                    if (data.length >= 3 && data.readUInt16BE(0) === id) return data[2] === 0;
                }, 5000, 'data_response');
                if (!accepted) throw new Error('machine-rejected-setting');
            } catch (error) {
                // A missing acknowledgement still allows readback of the write.
                if (error.message !== 'unconfirmed') throw error;
            }
            let actual;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt) await delay(700, undefined, { signal });
                try {
                    actual = await this.#readSetting(name, signal);
                    if (actual === value) return actual;
                } catch (error) {
                    if (error.message !== 'unconfirmed') throw error;
                }
            }
            const error = new Error(actual === undefined ? 'setting-unconfirmed' : 'setting-readback-mismatch');
            error.actual = actual;
            throw error;
        }).finally(() => { this.pendingSetting = null; });
        this.pendingSetting = { name, value, done };
        return done;
    }

    readStatistics() {
        return this.#run(async signal => {
            const values = new Map();
            const missingPages = [];
            for (const [start, count, required] of STATISTICS_PAGES) {
                const payload = Buffer.from([start >> 8, start & 0xff, count]);
                try {
                    const page = await this.#request(0xa2, 0x0f, payload, signal, ({ data }) => {
                        if (!data.length || data.length % 6 || data.length > count * 6 || data.readUInt16BE(0) < start) return;
                        const entries = new Map();
                        for (let offset = 0; offset < data.length; offset += 6) {
                            entries.set(data.readUInt16BE(offset), data.readUInt32BE(offset + 2));
                        }
                        if (required.every(id => entries.has(id))) return entries;
                    }, 5000, 'data_response');
                    for (const id of required) values.set(id, page.get(id));
                } catch (error) {
                    if (error.message !== 'unconfirmed') throw error;
                    missingPages.push(start);
                }
            }
            const results = Array.from(values, ([id, raw]) => {
                const item = STATISTICS.get(id);
                return { ...item, value: raw / (item.divisor || 1) };
            });
            if (values.has(3001) && values.has(3003)) {
                results.push({ id: 'withMilk', label: 'All beverages with milk', value: values.get(3001) + values.get(3003) });
            }
            return { statistics: results, missingPages };
        }, 0);
    }
}

module.exports = { BUTTONS, PROFILE_DRINK_BUTTONS, SETTINGS, EcamSoul, supportsSoul };
