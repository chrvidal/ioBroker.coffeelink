'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { tests } = require('@iobroker/testing');

tests.integration(path.join(__dirname, '..'), {
    controllerVersion: 'stable',
    loglevel: 'warn',
    defineAdditionalTests({ suite, it }) {
        suite('Default configuration', getHarness => {
            it('starts with Cloud disconnected and LAN disabled', async function () {
                this.timeout(15000);
                const harness = getHarness();
                await harness.startAdapterAndWait();
                const getState = id => harness.states.getStateAsync(`coffeelink.0.info.${id}`);
                // ioBroker marks the process alive before its ready handler finishes.
                for (let attempt = 0; attempt < 25; attempt++) {
                    if ((await getState('lan.status'))?.val === 'disabled') break;
                    await delay(200);
                }
                assert.equal((await getState('cloud.connected'))?.val, false);
                assert.equal((await getState('lan.status'))?.val, 'disabled');
                assert.equal((await getState('lanListener'))?.val, false);
            });
        });
    },
});
