'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {derive,encode,decode}=require('../lib/lan-protocol');
const {CoffeeLanSession,postLocalRegistration}=require('../lib/lan-session');
const http=require('node:http');

test('LAN key derivation returns five keys with correct AES lengths',()=>{
    const k=derive('abcdefghij','device-random','server-random','123456','789012');
    assert.equal(k.toMachineKey.length,32);
    assert.equal(k.fromMachineKey.length,32);
    assert.equal(k.fromMachineIv.length,16);
    assert.equal(k.toMachineSign.length,32);
    assert.notDeepEqual(k.toMachineKey,k.fromMachineKey);
    assert.deepEqual(k,derive('abcdefghij','device-random','server-random','123456','789012'));
});

test('AES-CBC zero padding round trip including IV rotation',()=>{
    const key=Buffer.from('0123456789abcdef0123456789abcdef');
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
    assert.throws(()=>decode('?!',Buffer.alloc(32),Buffer.alloc(16)));
    assert.throws(()=>new CoffeeLanSession({host:'0.0.0.0',port:10275,machineIp:'192.168.12.39'}));
    assert.throws(()=>new CoffeeLanSession({host:'127.0.0.1',port:10275,machineIp:'192.168.12.39'}));
});

test('ECAM612 uses POST+DSN+notify:1 exactly once on success',async()=>{
    const calls=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        registrationRequestFn:async(params)=>{calls.push(params);return {ok:true,status:202};},
    });
    transport.configure({dsn:'testdsn',key:'dontlogthiskey'});
    transport.server={listening:true};
    await transport.registerOnce();
    await transport.registerOnce();
    assert.equal(calls.length,1);
    assert.equal(calls[0].machineIp,'192.168.12.39');
    assert.equal(calls[0].dsn,'testdsn');
    assert.equal(calls[0].timeoutMs,5000);
    assert.deepEqual(calls[0].body,{local_reg:{ip:'192.168.12.33',notify:1,port:10275,uri:'/local_lan'}});
});


test('failed registration reports safe HTTP status without leaking response body',async()=>{
    const statuses=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        registrationRequestFn:async()=>({ok:false,status:404,text:async()=> 'SECRET-NEVER-LOG'}),
        onStatus:s=>statuses.push(s),
    });
    transport.configure({dsn:'testdsn',key:'secret-key-not-for-logs'});
    transport.server={listening:true};
    await transport.registerOnce();
    assert.equal(transport.registrationAttempted,false);
    assert.deepEqual(statuses,['register-http-404']);
    assert.equal(transport.registered,false);
});

test('failed registration reports network failure category without secrets',async()=>{
    const statuses=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        registrationRequestFn:async()=>{const error=new TypeError('secret');error.cause={code:'ECONNREFUSED'};throw error;},
        onStatus:s=>statuses.push(s),
    });
    transport.configure({dsn:'testdsn',key:'secret-key-not-for-logs'});
    transport.server={listening:true};
    await transport.registerOnce();
    assert.equal(transport.registrationAttempted,false);
    assert.deepEqual(statuses,['register-connection-refused']);
});


test('ECAM612 HTTP 202 is recorded as registered, but encrypted session is not presumed',async()=>{
    const statuses=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        registrationRequestFn:async()=>({ok:true,status:202}),onStatus:status=>statuses.push(status),
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
        registrationRequestFn:async()=>{called=true;return {ok:true,status:202};},
    });
    assert.throws(()=>transport.configure({dsn:'invalid?dsn',key:'secret-key'}));
    assert.equal(called,false);
});

// Wire-level test on the loopback interface only: no real coffee machine.
test('registration HTTP transport sends tested HTTP/1.1 headers and JSON body',async()=>{
    const received=[];
    const server=http.createServer((req,res)=>{
        const chunks=[];
        req.on('data',chunk=>chunks.push(chunk));
        req.on('end',()=>{
            received.push({method:req.method,url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString('utf8')});
            res.writeHead(202,{'Content-Type':'text/plain'});res.end('accepted');
        });
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
        const registration={local_reg:{ip:'192.168.12.33',notify:0,port:10275,uri:'/local_lan'}};
        const result=await postLocalRegistration({machineIp:'127.0.0.1',dsn:'testdsn',body:registration,port:server.address().port});
        assert.deepEqual(result,{status:202,ok:true});
        assert.equal(received.length,1);
        assert.equal(received[0].method,'POST');
        assert.equal(received[0].url,'/local_reg.json?dsn=testdsn');
        assert.equal(received[0].headers['user-agent'],'curl/8.0.1');
        assert.equal(received[0].headers.accept,'*/*');
        assert.equal(received[0].headers['content-type'],'application/json');
        assert.equal(received[0].headers.connection,'close');
        assert.equal(Number(received[0].headers['content-length']),Buffer.byteLength(received[0].body));
        assert.equal(received[0].headers['transfer-encoding'],undefined);
        assert.deepEqual(JSON.parse(received[0].body),registration);
    } finally {
        await new Promise(resolve=>server.close(resolve));
    }
});

test('registration HTTP transport does not follow redirects',async()=>{
    const server=http.createServer((req,res)=>{req.resume();res.writeHead(302,{location:'http://127.0.0.1/other'});res.end();});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
        const result=await postLocalRegistration({machineIp:'127.0.0.1',dsn:'testdsn',body:{local_reg:{}},port:server.address().port});
        assert.deepEqual(result,{status:302,ok:false});
    } finally {
        await new Promise(resolve=>server.close(resolve));
    }
});

test('native HTTP socket errors remain safely categorized',async()=>{
    const statuses=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',port:10275,machineIp:'192.168.12.39',
        registrationRequestFn:async()=>{const err=new Error('private diagnostic');err.code='EHOSTUNREACH';throw err;},
        onStatus:status=>statuses.push(status),
    });
    transport.configure({dsn:'testdsn',key:'private_key'});
    transport.server={listening:true};
    await transport.registerOnce();
    assert.deepEqual(statuses,['register-network-unreachable']);
});
