'use strict';

const { createHash } = require('node:crypto');
const utils = require('@iobroker/adapter-core');
const { CoffeeCloudClient } = require('./lib/cloud-client');
const { COUNTERS, getCounters, latestMonitor } = require('./lib/measurements');
const { PassiveLanReceiver } = require('./lib/lan-receiver');
const { CoffeeLanSession } = require('./lib/lan-session');
const { BUTTONS, SETTINGS, EcamSoul, supportsSoul } = require('./lib/ecam-soul');

const DEVICE_LIMIT = 5;
const READ_ACTIONS = Object.freeze({ readStatistics: 'Refresh machine display statistics', readSettings: 'Read current machine settings' });
const CLOUD_DIAGNOSTICS = [
    ['blackCoffeeCloudUpdatedAt', 'd700_tot_bev_b', 'Only-coffee total'],
    ['milkCoffeeCloudUpdatedAt', 'd701_tot_bev_bw', 'Coffee-with-milk total'],
];
const LEGACY_CLOUD_STATES = [
    'online', 'status', 'lastKnownStatus', 'statusFresh', 'statusUpdatedAt',
    ...COUNTERS.map(([id]) => `counters.${id}`),
    ...CLOUD_DIAGNOSTICS.map(([id]) => `diagnostics.${id}`),
];

class CoffeeLink extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'coffeelink' });
        this.client = null;
        this.pollTimer = null;
        this.lanReceiver = null;
        this.activeLanDevice = null;
        this.soul = null;
        this.statisticsPending = false;
        this.controlCommandId = 0;
        this.settingCommandIds = new Map();
        this.migratedCloudDevices = new Set();
        this.removedLegacyLanCounters = false;
        this.lanUpdates = Promise.resolve();
        this.busy = false;
        this.stopping = false;
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', (id, state) => {
            void this.onControlState(id, state).catch(() => this.log.warn('Could not update LAN control states'));
        });
    }

    async onReady() {
        await this.setStateAsync('info.connection', { val: false, ack: true });
        await this.channel('info.cloud', 'Coffee Link cloud');
        await this.channel('info.lan', 'Local network');
        await this.setCloudConnected(false);
        await this.state('info.lan.lastAuthenticatedAt', 'Last authenticated LAN property (UTC)', 'string', 'text', '');
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
        await this.setLanStatus('disabled');
        if (this.config.lanReceiverEnabled === true) {
            try {
                const activeMode = this.config.lanActiveEnabled === true;
                const listenerConfig = {
                    host: this.config.lanListenAddress || '127.0.0.1',
                    port: Number(this.config.lanListenPort) || 10275,
                    machineIp: this.config.lanMachineIp || '',
                    onProperties: (properties, receivedAt) => {
                        const root = this.activeLanDevice;
                        if (!this.stopping && root) {
                            this.lanUpdates = this.lanUpdates
                                .then(() => this.recordLanCounters(root, properties, receivedAt))
                                .catch(() => this.log.warn('LAN counters could not be recorded'));
                        }
                    },
                    onStatus: status => {
                        if (!this.stopping) {
                            void this.setLanStatus(status).catch(() => this.log.warn('Could not update LAN status'));
                            if (status === 'verified') void this.refreshStatistics();
                        }
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

    channel(id, name) {
        return this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
    }

    setCloudConnected(value) {
        return this.state('info.cloud.connected', 'Cloud API reachable at last sync', 'boolean', 'indicator.connected', value);
    }

    async setLanStatus(status) {
        await this.setStateAsync('info.lanStatus', { val: status, ack: true });
        await this.state('info.lan.status', 'LAN session status', 'string', 'text', status);
    }

    async migrateCloudStates(root) {
        if (this.migratedCloudDevices.has(root)) return;
        for (const id of LEGACY_CLOUD_STATES) {
            const oldId = `${root}.${id}`;
            const legacy = await this.getObjectAsync(oldId);
            if (legacy?.type !== 'state') continue;
            const newId = `${root}.cloud.${id}`;
            if (!await this.getStateAsync(newId)) {
                const previous = await this.getStateAsync(oldId);
                if (previous?.ack === true) {
                    const { name, type, role } = legacy.common;
                    await this.state(newId, name, type, role, previous.val);
                }
            }
            await this.delObjectAsync(oldId);
        }
        for (const branch of ['counters', 'diagnostics']) {
            const id = `${root}.${branch}`;
            if ((await this.getObjectAsync(id))?.type === 'channel') await this.delObjectAsync(id);
        }
        this.migratedCloudDevices.add(root);
    }

    async refresh() {
        if (this.stopping || !this.client || this.busy) return;
        this.busy = true;
        try {
            if (this.lanReceiver instanceof CoffeeLanSession) this.lanReceiver.refreshCounters();
            void this.refreshStatistics();
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
                const cloud = `${root}.cloud`;
                await this.channel(cloud, 'Cloud data (read-only)');
                await this.state(`${cloud}.online`, 'Machine reachable via cloud', 'boolean', 'indicator.reachable', isOnline);
                // Identify the LAN counter source before callbacks can arrive.
                const properties = await this.client.readProperties(device.dsn);
                if (this.lanReceiver instanceof CoffeeLanSession && !this.lanReceiver.registrationAttempted
                    && isOnline && this.config.lanMachineIp
                    && (!this.activeLanDevice || this.activeLanDevice === root)) {
                    try {
                        const access = await this.client.readLanAccess(device.dsn);
                        if (this.stopping) return;
                        if (!access.enabled || !access.key) {
                            await this.setLanStatus('no-lan-key');
                        } else {
                            this.lanReceiver.configure({ dsn: device.dsn, key: access.key, keyId: access.keyId });
                            this.activeLanDevice = root;
                            await this.prepareSoul(root, device, properties);
                            // Active mode opts in to registration for one device.
                            // This changes the machine's callback destination; the app may be affected.
                            await this.lanReceiver.registerOnce();
                        }
                    } catch {
                        await this.setLanStatus('connection-failed');
                    }
                }
                if (this.activeLanDevice === root) await this.prepareSoul(root, device, properties);
                // The API can return stale monitor packets while the cloud says Online.
                const monitor = latestMonitor(properties);
                await this.state(`${cloud}.status`, 'Machine status (stale if not updated)', 'string', 'text', monitor.status);
                await this.state(`${cloud}.lastKnownStatus`, 'Last known machine status', 'string', 'text', monitor.lastKnown);
                await this.state(`${cloud}.statusFresh`, 'Machine status is current', 'boolean', 'indicator', monitor.fresh);
                await this.state(`${cloud}.statusUpdatedAt`, 'Monitor last updated at (UTC)', 'string', 'text', monitor.updatedAt);
                await this.channel(`${cloud}.counters`, 'Cloud counters');
                for (const item of getCounters(properties)) {
                    await this.state(`${cloud}.counters.${item.id}`, item.name, 'number', 'value', item.value);
                }
                // Diagnose only: when did the cloud last CHANGE the counter?
                // A fresh adapter poll does not imply fresh counter data.
                await this.channel(`${cloud}.diagnostics`, 'Cloud diagnostics');
                for (const [key, source, label] of CLOUD_DIAGNOSTICS) {
                    const raw = properties.get(source)?.data_updated_at;
                    const timestamp = typeof raw === 'string' ? Date.parse(raw) : NaN;
                    await this.state(`${cloud}.diagnostics.${key}`,
                        `${label} last cloud change (UTC)`, 'string', 'text',
                        Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'unknown');
                }
                await this.migrateCloudStates(root);
            }
            await this.setStateAsync('info.connection', { val: online, ack: true });
            await this.setCloudConnected(true);
        } catch (error) {
            await this.setStateAsync('info.connection', { val: false, ack: true });
            await this.setCloudConnected(false);
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
        await this.state('info.lan.lastAuthenticatedAt', 'Last authenticated LAN property (UTC)', 'string', 'text', receivedAt);
        if (this.soul && this.activeLanDevice === root) return;
        await this.setObjectNotExistsAsync(`${root}.lan.counters`, {
            type: 'channel', common: { name: 'LAN counters (unverified)' }, native: {},
        });
        // Keep experimental counters separate until they match the machine display.
        for (const item of getCounters(properties)) {
            await this.state(`${root}.lan.counters.${item.id}`, item.name, 'number', 'value', item.value);
        }
    }

    async prepareSoul(root, device, properties) {
        if (this.soul || !supportsSoul(device, properties)) return;
        if (this.config.lanControlEnabled === true) await this.setupControls(root);
        this.soul = new EcamSoul(this.lanReceiver);
        const previous = await this.getStateAsync(`${root}.lan.statistics.blackCoffee`);
        if (previous?.ack === true && typeof previous.val === 'number') await this.removeLegacyLanCounters(root);
        void this.refreshStatistics();
    }

    async removeLegacyLanCounters(device) {
        if (this.removedLegacyLanCounters) return;
        const branch = `${device}.lan.counters`;
        for (const [id] of COUNTERS) {
            const oldId = `${branch}.${id}`;
            if ((await this.getObjectAsync(oldId))?.type === 'state') await this.delObjectAsync(oldId);
        }
        if ((await this.getObjectAsync(branch))?.type === 'channel') await this.delObjectAsync(branch);
        this.removedLegacyLanCounters = true;
    }

    async setupControls(root) {
        const prefix = `${root}.lan.control`;
        await this.setObjectNotExistsAsync(prefix, {
            type: 'channel', common: { name: 'ECAM61x LAN control' }, native: {},
        });
        for (const [id, name] of Object.entries({ ...BUTTONS, ...READ_ACTIONS })) {
            const stateId = `${prefix}.${id}`;
            await this.setObjectNotExistsAsync(stateId, {
                type: 'state', common: { name, type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {},
            });
            await this.setStateAsync(stateId, { val: false, ack: true });
        }
        const obsolete = `${prefix}.standby`;
        if (await this.getObjectAsync(obsolete)) await this.delObjectAsync(obsolete);
        for (const [id, { label, options }] of Object.entries(SETTINGS)) {
            await this.setObjectNotExistsAsync(`${prefix}.${id}`, {
                type: 'state', common: { name: label, type: 'number', role: 'level', read: true, write: true, states: options }, native: {},
            });
            await this.state(`${prefix}.${id}Result`, `${label} write result`, 'string', 'text', 'idle');
        }
        await this.state(`${prefix}.result`, 'Last control request result', 'string', 'text', 'idle');
        this.subscribeStates(`${prefix}.*`);
    }

    async onControlState(id, state) {
        if (this.stopping || this.config.lanControlEnabled !== true || !this.soul || !state || state.ack !== false) return;
        if (!Number.isFinite(state.ts) || Math.abs(Date.now() - state.ts) > 5000) return;
        const prefix = `${this.activeLanDevice}.lan.control`;
        const fullPrefix = `${this.namespace}.${prefix}.`;
        if (!id.startsWith(fullPrefix)) return;
        const action = id.slice(fullPrefix.length);
        const button = Object.hasOwn(READ_ACTIONS, action) || Object.hasOwn(BUTTONS, action);
        if (button ? state.val !== true : !Object.hasOwn(SETTINGS, action)) return;

        const commandId = ++this.controlCommandId;
        if (!button) this.settingCommandIds.set(action, commandId);
        // Enqueue synchronously to preserve arrival order and allow Stop to preempt.
        const operation = action === 'readStatistics' ? this.refreshStatistics()
            : action === 'readSettings' ? this.readControlSettings(prefix)
                : button ? this.soul.button(action) : this.soul.setSetting(action, state.val);
        const result = operation.then(value => ({ value }), error => ({ error: error.message, actual: error.actual }));
        if (button) await this.setStateAsync(`${prefix}.${action}`, { val: false, ack: true });
        else await this.setStateAsync(`${prefix}.${action}Result`, { val: 'pending', ack: true });
        const outcome = await result;
        if (this.stopping) return;
        if (!button && this.settingCommandIds.get(action) === commandId) {
            await this.setStateAsync(`${prefix}.${action}`, { val: outcome.error ? outcome.actual ?? null : outcome.value, ack: true });
            await this.setStateAsync(`${prefix}.${action}Result`, { val: outcome.error || 'confirmed', ack: true });
        }
        if (commandId !== this.controlCommandId) return;
        await this.setStateAsync(`${prefix}.result`, { val: `${action}: ${outcome.error || (button ? outcome.value : 'confirmed')}`, ack: true });
    }

    async readControlSettings(prefix) {
        const values = await this.soul.readSettings();
        if (this.stopping) return 'session-ended';
        for (const [name, value] of values) {
            await this.setStateAsync(`${prefix}.${name}`, { val: value, ack: true });
        }
        if (values.size === Object.keys(SETTINGS).length) return 'confirmed';
        return values.size ? 'partial' : 'unconfirmed';
    }

    async refreshStatistics() {
        if (this.stopping || !this.soul || !this.lanReceiver?.sessionVerified) return 'lan-unavailable';
        if (this.statisticsPending) return 'busy';
        const device = this.activeLanDevice;
        const root = `${device}.lan.statistics`;
        this.statisticsPending = true;
        try {
            const { statistics, missingPages } = await this.soul.readStatistics();
            if (this.stopping) return 'session-ended';
            if (missingPages.length) this.log.warn(`Machine statistics pages unconfirmed: ${missingPages.join(', ')}`);
            if (!statistics.length) return 'unconfirmed';
            await this.setObjectNotExistsAsync(root, {
                type: 'channel', common: { name: 'Machine display statistics (ECAM A2)' }, native: {},
            });
            for (const { id, label, value, unit } of statistics) {
                const name = `${root}.${id}`;
                await this.setObjectNotExistsAsync(name, {
                    type: 'state', common: { name: label, type: 'number', role: 'value', read: true, write: false, unit }, native: {},
                });
                await this.setStateAsync(name, { val: value, ack: true });
            }
            await this.state(`${root}.receivedAt`, 'Last machine statistics response (UTC)', 'string', 'text', new Date().toISOString());
            if (statistics.some(({ id }) => id === 'blackCoffee')) await this.removeLegacyLanCounters(device);
            return missingPages.length ? 'partial' : 'confirmed';
        } catch (error) {
            const safeStatuses = ['busy', 'cancelled', 'session-ended', 'lan-unavailable', 'not-delivered', 'unconfirmed'];
            const status = safeStatuses.includes(error.message) ? error.message : 'failed';
            if (!this.stopping && !['busy', 'cancelled'].includes(status)) this.log.warn(`Machine statistics: ${status}`);
            return status;
        } finally {
            this.statisticsPending = false;
        }
    }

    async onUnload(callback) {
        try {
            this.stopping = true;
            if (this.pollTimer) clearInterval(this.pollTimer);
            if (this.lanReceiver) await this.lanReceiver.stop();
            await this.lanUpdates;
            await this.setStateAsync('info.lanListener', { val: false, ack: true });
            await this.setStateAsync('info.connection', { val: false, ack: true });
            await this.setLanStatus('disabled');
            await this.setCloudConnected(false);
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
