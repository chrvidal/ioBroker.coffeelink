'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {derive,encode,decode}=require('../lib/lan-protocol');
const {CoffeeLanSession}=require('../lib/lan-session');

test('LAN key derivation returns five keys with correct AES lengths',()=>{
    const k=derive('abcdefghij','device-random','server-random','123456','789012');
    assert.equal(k.toMachineKey.length,16);
    assert.equal(k.fromMachineIv.length,16);
    assert.equal(k.toMachineSign.length,32);
    assert.notDeepEqual(k.toMachineKey,k.fromMachineKey);
    assert.deepEqual(k,derive('abcdefghij','device-random','server-random','123456','789012'));
});

test('AES-CBC zero padding round trip including IV rotation',()=>{
    const key=Buffer.from('0123456789abcdef');
    const iv=Buffer.alloc(16,3);
    const sign=Buffer.alloc(32,9);
    const first=encode('{"seq_no":"0","data":{}}',key,iv,sign);
    assert.equal(typeof first.sign,'string');
    const decoded=decode(first.enc,key,iv);
    assert.equal(decoded.plaintext,'{"seq_no":"0","data":{}}');
    assert.deepEqual(decoded.iv,first.iv);
    const second=encode('{"seq_no":"1"}',key,first.iv,sign);
    assert.equal(decode(second.enc,key,first.iv).plaintext,'{"seq_no":"1"}');
});

test('rejects malformed encrypted payload and invalid LAN key',()=>{
    assert.throws(()=>derive('','x','y','a','b'));
    assert.throws(()=>decode('?!',Buffer.alloc(16),Buffer.alloc(16)));
    assert.throws(()=>new CoffeeLanSession({host:'0.0.0.0',port:10275,machineIp:'192.168.12.39'}));
    assert.throws(()=>new CoffeeLanSession({host:'127.0.0.1',port:10275,machineIp:'192.168.12.39'}));
});

test('active registration sends only explicit local callback setup once',async()=>{
    const calls=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        fetchFn:async(url,params)=>{calls.push({url,params});return {ok:true};},
    });
    transport.configure({dsn:'testdsn',key:'dontlogthiskey'});
    transport.server={listening:true};
    await transport.registerOnce();
    await transport.registerOnce();
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,'http://192.168.12.39/local_reg.json?dsn=testdsn');
    assert.equal(calls[0].params.method,'POST');
    assert.equal(calls[0].params.headers['content-type'],'application/json');
    assert.equal(calls[0].params.redirect,'error');
    assert.deepEqual(JSON.parse(calls[0].params.body),{local_reg:{ip:'192.168.12.33',notify:1,port:10275,uri:'/local_lan'}});
});


test('failed registration reports safe HTTP status without leaking response body',async()=>{
    const statuses=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        fetchFn:async()=>({ok:false,status:404,text:async()=> 'SECRET-NEVER-LOG'}),
        onStatus:s=>statuses.push(s),
    });
    transport.configure({dsn:'testdsn',key:'secret-key-not-for-logs'});
    transport.server={listening:true};
    await transport.registerOnce();
    assert.deepEqual(statuses,['register-http-404']);
    assert.equal(transport.registered,false);
});

test('failed registration reports network failure category without secrets',async()=>{
    const statuses=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        fetchFn:async()=>{const error=new TypeError('secret');error.cause={code:'ECONNREFUSED'};throw error;},
        onStatus:s=>statuses.push(s),
    });
    transport.configure({dsn:'testdsn',key:'secret-key-not-for-logs'});
    transport.server={listening:true};
    await transport.registerOnce();
    assert.deepEqual(statuses,['register-connection-refused']);
});


test('ECAM612 HTTP 202 is recorded as registered, but encrypted session is not presumed',async()=>{
    const statuses=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        fetchFn:async(url,opts)=>({ok:true,status:202}),onStatus:status=>statuses.push(status),
    });
    transport.configure({dsn:'AC000W018140808',key:'secret-key'});
    transport.server={listening:true};
    await transport.registerOnce();
    assert.equal(transport.registered,true);
    assert.deepEqual(statuses,['registered']);
    assert.equal(transport.keys,null);
});

test('rejects invalid DSN before sending an active registration',async()=>{
    let called=false;
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        fetchFn:async()=>{called=true;return {ok:true,status:202};},
    });
    assert.throws(()=>transport.configure({dsn:'invalid?dsn',key:'secret-key'}));
    assert.equal(called,false);
});
