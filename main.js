'use strict';

const { createHash } = require('node:crypto');
const utils = require('@iobroker/adapter-core');
const { CoffeeCloudClient } = require('./lib/cloud-client');
const { getCounters, latestMonitor } = require('./lib/measurements');
const { PassiveLanReceiver } = require('./lib/lan-receiver');
const { CoffeeLanSession } = require('./lib/lan-session');

const DEVICE_LIMIT = 5;

class CoffeeLink extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'coffeelink' });
        this.client = null;
        this.pollTimer = null;
        this.lanReceiver = null;
        this.activeLanDevice = null;
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
        await this.setObjectNotExistsAsync('info.lanListener', {
            type: 'state',
            common: { name: 'Passive LAN receiver listening', type: 'boolean', role: 'indicator', read: true, write: false, def: false },
            native: {},
        });
        await this.setStateAsync('info.lanListener', { val: false, ack: true });
        await this.setObjectNotExistsAsync('info.lanLastContact', {
            type: 'state',
            common: { name: 'Last unsupported LAN callback', type: 'string', role: 'text', read: true, write: false, def: '' },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.lanStatus', {
            type: 'state', common: { name: 'LAN session status', type: 'string', role: 'text', read: true, write: false, def: 'disabled' }, native: {},
        });
        await this.setStateAsync('info.lanStatus', { val: 'disabled', ack: true });
        if (this.config.lanReceiverEnabled === true) {
            try {
                const activeMode = this.config.lanActiveEnabled === true;
                const listenerConfig = {
                    host: this.config.lanListenAddress || '127.0.0.1',
                    port: Number(this.config.lanListenPort) || 10275,
                    machineIp: this.config.lanMachineIp || '',
                    onProperties: (properties, receivedAt) => {
                        if (!this.stopping && this.activeLanDevice) {
                            void this.recordLanCounters(this.activeLanDevice, properties, receivedAt)
                                .catch(() => this.log.warn('LAN counters could not be recorded'));
                        }
                    },
                    onStatus: status => {
                        if (!this.stopping) void this.setStateAsync('info.lanStatus', { val: status, ack: true });
                    },
                    onContact: ({ at }) => {
                        if (!this.stopping) void this.setStateAsync('info.lanLastContact', { val: at, ack: true });
                    },
                };
                this.lanReceiver = activeMode ? new CoffeeLanSession(listenerConfig) : new PassiveLanReceiver(listenerConfig);
                await this.lanReceiver.start();
                await this.setStateAsync('info.lanListener', { val: true, ack: true });
                this.log.info(activeMode
                    ? 'Experimental LAN session ready; machine registration requires explicit opt-in.'
                    : 'Passive LAN listener ready; registration disabled; no machine commands.');
            } catch (error) {
                this.log.warn(`Passive LAN listener unavailable: ${error.message}`);
                this.lanReceiver = null;
            }
        }
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
                if (this.lanReceiver instanceof CoffeeLanSession && !this.lanReceiver.registrationAttempted
                    && isOnline && this.config.lanMachineIp) {
                    try {
                        const access = await this.client.readLanAccess(device.dsn);
                        if (!access.enabled || !access.key) {
                            await this.setStateAsync('info.lanStatus', { val: 'no-lan-key', ack: true });
                        } else {
                            this.lanReceiver.configure({ dsn: device.dsn, key: access.key });
                            this.activeLanDevice = root;
                            // Explicit active-mode checkbox opts in to ONE device registration attempt.
                            // This changes the machine's callback destination; the app may be affected.
                            await this.lanReceiver.registerOnce();
                        }
                    } catch {
                        await this.setStateAsync('info.lanStatus', { val: 'connection-failed', ack: true });
                    }
                }
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

    async recordLanCounters(root, properties, receivedAt) {
        await this.setObjectNotExistsAsync(`${root}.lan`, {
            type: 'channel', common: { name: 'Experimental local LAN data' }, native: {},
        });
        await this.state(`${root}.lan.receivedAt`, 'Last LAN property packet (UTC)', 'string', 'text', receivedAt);
        await this.setObjectNotExistsAsync(`${root}.lan.counters`, {
            type: 'channel', common: { name: 'LAN counters (unverified)' }, native: {},
        });
        // Keep experimental counters separate until they match the machine display.
        for (const item of getCounters(properties)) {
            await this.state(`${root}.lan.counters.${item.id}`, item.name, 'number', 'value', item.value);
        }
    }

    async onUnload(callback) {
        try {
            this.stopping = true;
            if (this.pollTimer) clearInterval(this.pollTimer);
            if (this.lanReceiver) await this.lanReceiver.stop();
            await this.setStateAsync('info.lanListener', { val: false, ack: true });
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
