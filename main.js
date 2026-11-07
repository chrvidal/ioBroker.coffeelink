'use strict';

const { createHash } = require('node:crypto');
const utils = require('@iobroker/adapter-core');
const { CoffeeCloudClient } = require('./lib/cloud-client');
const { getCounters, latestMonitor } = require('./lib/measurements');

const DEVICE_LIMIT = 5;

class CoffeeLink extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'coffeelink' });
        this.client = null;
        this.pollTimer = null;
        this.busy = false;
        this.stopping = false;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', { val: false, ack: true });
        await this.setObjectNotExistsAsync('info.deviceCount', {
            type: 'state',
            common: { name: 'Coffee Link devices', type: 'number', role: 'value', read: true, write: false, def: 0 },
            native: {},
        });
        if (!this.config.email || !this.config.password) {
            this.log.warn('Configure your Coffee Link account in the adapter settings.');
            return;
        }
        this.client = new CoffeeCloudClient({ email: this.config.email, password: this.config.password });
        const minutes = Math.min(1440, Math.max(5, Number(this.config.pollInterval) || 15));
        // Even when the first connection fails, the next scheduled attempt can recover.
        this.pollTimer = setInterval(() => { void this.refresh(); }, minutes * 60000);
        await this.refresh();
    }

    async state(id, name, type, role, value) {
        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: { name, type, role, read: true, write: false },
            native: {},
        });
        await this.setStateAsync(id, { val: value, ack: true });
    }

    async refresh() {
        if (this.stopping || !this.client || this.busy) return;
        this.busy = true;
        try {
            const devices = (await this.client.listDevices()).slice(0, DEVICE_LIMIT);
            await this.state('info.deviceCount', 'Coffee Link devices', 'number', 'value', devices.length);
            await this.setObjectNotExistsAsync('machines', {
                type: 'channel', common: { name: 'Coffee machines' }, native: {},
            });
            let online = false;
            for (const device of devices) {
                if (!/^[A-Za-z0-9_-]{1,128}$/.test(device.dsn)) continue;
                // Stable opaque ID; does not expose full device serial in object IDs.
                const id = `d${createHash('sha256').update(device.dsn).digest('hex').slice(0, 12)}`;
                const root = `machines.${id}`;
                const isOnline = String(device.connection_status || '').toLowerCase() === 'online';
                online ||= isOnline;
                await this.setObjectNotExistsAsync(root, {
                    type: 'device',
                    common: { name: 'Coffee Link machine' },
                    native: {},
                });
                await this.state(`${root}.online`, 'Machine reachable via cloud', 'boolean', 'indicator.reachable', isOnline);
                // The API can return stale monitor packets while the cloud says Online.
                const properties = await this.client.readProperties(device.dsn);
                const monitor = latestMonitor(properties);
                await this.state(`${root}.status`, 'Machine status (stale if not updated)', 'string', 'text', monitor.status);
                await this.state(`${root}.lastKnownStatus`, 'Last known machine status', 'string', 'text', monitor.lastKnown);
                await this.state(`${root}.statusFresh`, 'Machine status is current', 'boolean', 'indicator', monitor.fresh);
                await this.state(`${root}.statusUpdatedAt`, 'Monitor last updated at (UTC)', 'string', 'text', monitor.updatedAt);
                await this.setObjectNotExistsAsync(`${root}.counters`, {
                    type: 'channel', common: { name: 'Lifetime counters' }, native: {},
                });
                for (const item of getCounters(properties)) {
                    await this.state(`${root}.counters.${item.id}`, item.name, 'number', 'value', item.value);
                }
                // Diagnose only: when did the cloud last CHANGE the counter?
                // A fresh adapter poll does not imply fresh counter data.
                await this.setObjectNotExistsAsync(`${root}.diagnostics`, {
                    type: 'channel', common: { name: 'Cloud diagnostics (read-only)' }, native: {},
                });
                for (const [key, source, label] of [
                    ['blackCoffee', 'd700_tot_bev_b', 'Only-coffee total'],
                    ['milkCoffee', 'd701_tot_bev_bw', 'Coffee-with-milk total'],
                ]) {
                    const raw = properties.get(source)?.data_updated_at;
                    const timestamp = typeof raw === 'string' ? Date.parse(raw) : NaN;
                    await this.state(`${root}.diagnostics.${key}CloudUpdatedAt`,
                        `${label} last cloud change (UTC)`, 'string', 'text',
                        Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'unknown');
                }
            }
            await this.setStateAsync('info.connection', { val: online, ack: true });
        } catch (error) {
            await this.setStateAsync('info.connection', { val: false, ack: true });
            // Cloud errors contain only stage+HTTP status; no response body, URLs or secrets.
            this.log.warn(`Coffee Link sync failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            this.busy = false;
        }
    }

    async onUnload(callback) {
        try {
            this.stopping = true;
            if (this.pollTimer) clearInterval(this.pollTimer);
            await this.setStateAsync('info.connection', { val: false, ack: true });
        } catch {
            // ioBroker shutdown must still complete.
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new CoffeeLink(options);
} else {
    new CoffeeLink();
}
