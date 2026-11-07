'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CoffeeCloudClient, CoffeeCloudError } = require('../lib/cloud-client');

const ok = content => ({ ok: true, json: async () => content });
const err = code => ({ ok: false, status: code });
const mockFetch = calls => async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('accounts.login')) return ok({ errorCode: 0, sessionInfo: { sessionToken: 'private-session', sessionSecret: 'private-secret' } });
    if (url.endsWith('accounts.getJWT')) return ok({ errorCode: 0, id_token: 'private-id-token' });
    if (url.endsWith('token_sign_in')) return ok({ access_token: 'private-ayla-token', expires_in: 3600 });
    if (url.endsWith('devices.json')) return ok([{ device: { dsn: 'TEST123', connection_status: 'Online' } }]);
    if (url.endsWith('properties.json')) return ok([{ property: { name: 'd706_tot_id2_coffee', value: '42' } }]);
    throw Error('unexpected URL');
};

test('cloud client reads device list and counters, never sends machine write request', async () => {
    const calls = [];
    const client = new CoffeeCloudClient({ email: 'test@example.org', password: 'private-password', fetchFn: mockFetch(calls) });
    const devices = await client.listDevices();
    assert.equal(devices.length, 1);
    const props = await client.readProperties(devices[0].dsn);
    assert.equal(props.get('d706_tot_id2_coffee').value, '42');
    assert.deepEqual(calls.map(x => x.options.method), ['POST', 'POST', 'POST', 'GET', 'GET']);
    assert.equal(calls.some(x => x.options.method !== 'GET' && x.url.includes('/dsns/')), false);
    assert.equal(calls.some(x => x.options.headers.authorization?.includes('private-password')), false);
    assert.equal(calls[1].options.headers.authorization, 'Bearer private-session');
});

test('invalid DSN rejected without network request or secret leak', async () => {
    const calls = [];
    const client = new CoffeeCloudClient({ email: 'test@example.org', password: 'private-password', fetchFn: mockFetch(calls) });
    await assert.rejects(client.readProperties('../bad'), CoffeeCloudError);
    assert.equal(calls.length, 0);
});

test('HTTP errors do not leak credentials or API responses', async () => {
    const client = new CoffeeCloudClient({ email: 'test@example.org', password: 'private-password', fetchFn: async () => err(403) });
    await assert.rejects(client.listDevices(), e => {
        assert.match(e.message, /HTTP 403/);
        assert.doesNotMatch(e.message, /private-password|test@example.org/);
        return true;
    });
});

test('LAN access fetch is read-only and uses alternative local_key endpoint', async () => {
    const calls=[];
    const client=new CoffeeCloudClient({email:'test@example.org',password:'private-password',fetchFn:async(url,options)=>{
        calls.push({url,options});
        if(url.endsWith('accounts.login')) return ok({errorCode:0,sessionInfo:{sessionToken:'s',sessionSecret:'z'}});
        if(url.endsWith('accounts.getJWT')) return ok({errorCode:0,id_token:'jwt'});
        if(url.endsWith('token_sign_in')) return ok({access_token:'token',expires_in:3600});
        if(url.endsWith('/dsns/TEST123.json')) return ok({device:{lan_enabled:true}});
        if(url.endsWith('/devices/TEST123/connection_config.json')) return ok({local_key:'testing-secret',local_key_id:46964});
        throw Error('unexpected URL');
    }});
    const access=await client.readLanAccess('TEST123');
    assert.deepEqual(access,{enabled:true,key:'testing-secret',keyId:46964});
    assert.equal(calls.filter(x=>x.url.includes('ads-eu')).every(x=>x.options.method==='GET'),true);
    await assert.rejects(client.readLanAccess('../bad'), CoffeeCloudError);
});
