'use strict';

// Read-only fields verified against ECAM612.55 cloud data.
// Match complete property names: numeric ID prefixes alone are not reliable.
const COUNTERS = Object.freeze([
    ['blackCoffee', 'd700_tot_bev_b', 'Black coffee beverages'],
    ['milkCoffee', 'd701_tot_bev_bw', 'Coffee with milk beverages'],
    ['milkOnly', 'd703_tot_bev_w', 'Milk-only beverages'],
    ['otherDrinks', 'd702_tot_bev_other', 'Other beverages'],
    ['espresso', 'd705_tot_id1_espr', 'Espresso'],
    ['coffee', 'd706_tot_id2_coffee', 'Coffee'],
    ['longCoffee', 'd707_tot_id3_long', 'Long coffee'],
    ['doppio', 'd708_tot_id5_doppio_p', 'Doppio+'],
    ['americano', 'd709_id6_americano', 'Americano'],
    ['cappuccino', 'd710_tot_id7_capp', 'Cappuccino'],
    ['latteMacchiato', 'd711_id8_lattmacc', 'Latte macchiato'],
    ['caffeLatte', 'd712_id9_cafflatt', 'Caffè latte'],
    ['flatWhite', 'd713_id10_flatwhite', 'Flat white'],
    ['espressoMacchiato', 'd714_id11_esprmacc', 'Espresso macchiato'],
    ['hotMilk', 'd715_id12_hotmilk', 'Hot milk'],
    ['grounds', 'd551_cnt_coffee_fondi', 'Grounds counter'],
    ['descales', 'd552_cnt_calc_tot', 'Descaling cycles'],
    ['filters', 'd554_cnt_filter_tot', 'Filters used'],
]);

// These fields are intentionally NOT mapped yet: d553_water_tot_qty (0 despite
// 10k+ coffees), d555_water_filter_qty (34ml), d556_water_hardness (96874).
const STATUS = new Map([
    [0, 'standby'], [1, 'starting'], [2, 'stopping'], [4, 'descaling'],
    [5, 'heating_steam'], [6, 'recovering'], [7, 'ready'], [8, 'rinsing'],
    [10, 'preparing_milk'], [11, 'hot_water'], [12, 'cleaning_milk'],
    [16, 'preparing_chocolate'], [17, 'preparing_milk'],
]);

function counterValue(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d{1,13}$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}

function crc16CcittAug(buffer) {
    let result = 0x1d0f;
    for (const value of buffer) {
        result ^= value << 8;
        for (let bit = 0; bit < 8; bit++) {
            result = (result & 0x8000 ? (result << 1) ^ 0x1021 : result << 1) & 0xffff;
        }
    }
    return result;
}

function monitorStatus(encoded) {
    if (typeof encoded !== 'string' || !/^[a-zA-Z0-9+/\s]*={0,2}$/.test(encoded)) return null;
    const packet = Buffer.from(encoded.replace(/\s/g, ''), 'base64');
    if (packet.length < 16) return null;
    const end = packet[1];
    if (end < 13 || packet.length <= end) return null;
    const expectedCrc = packet.readUInt16BE(end - 1);
    if (expectedCrc !== crc16CcittAug(packet.subarray(0, end - 1))) return null;
    const payload = packet.subarray(2, end - 1);
    if (payload[0] !== 0x75 || payload.length < 10) return null;
    const code = payload[7]; // payload[2:] contents; contents[5] = status.
    return STATUS.get(code) || 'unknown';
}

function latestMonitor(properties, now = Date.now(), freshnessSeconds = 300) {
    const prop = properties.get('d302_monitor') || properties.get('d302_monitor_machine');
    if (!prop) return { status: 'unknown', lastKnown: 'unknown', fresh: false, updatedAt: '' };
    const lastKnown = monitorStatus(prop.value) || 'unknown';
    const timestamp = Date.parse(String(prop.data_updated_at || ''));
    const fresh = Number.isFinite(timestamp) && timestamp <= now && (now - timestamp) <= freshnessSeconds * 1000;
    return {
        status: fresh ? lastKnown : 'stale',
        lastKnown,
        fresh,
        updatedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '',
    };
}

function getCounters(properties) {
    const result = [];
    for (const [id, source, name] of COUNTERS) {
        const raw = properties.get(source);
        if (!raw) continue;
        const value = counterValue(raw.value);
        if (value !== null) result.push({ id, name, value });
    }
    return result;
}

module.exports = { COUNTERS, counterValue, getCounters, monitorStatus, latestMonitor, crc16CcittAug };
