'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {derive,encode,decode}=require('../lib/lan-protocol');
const {CoffeeLanSession,lanAddressFor,postLocalRegistration}=require('../lib/lan-session');
const http=require('node:http');

test('LAN key derivation returns independent direction keys',()=>{
    const k=derive('abcdefghij','device-random','server-random','123456','789012');
    assert.equal(k.toMachineKey.length,32);
    assert.equal(k.fromMachineKey.length,32);
    assert.equal(k.fromMachineIv.length,16);
    assert.equal(k.toMachineSign.length,32);
    assert.equal(k.fromMachineSign.length,32);
    assert.notDeepEqual(k.toMachineSign,k.fromMachineSign);
    assert.notDeepEqual(k.toMachineKey,k.fromMachineKey);
    assert.deepEqual(k,derive('abcdefghij','device-random','server-random','123456','789012'));
});

test('matches chained app and device packets generated with aioecam', () => {
    // aioecam 60c980f, LanSession.seal() in both roles, with a padded nonce.
    const keys = derive('dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdA==', 'ZGV2aWNlIQ==', 'QUJDREVGR0hJSktM',
        '355921561731160', '1700000000000000');
    const vectors = [
        {
            command: { k: 'xxx' }, // block-aligned plaintext still requires a full zero block
            commandEnc: '9OtQBlQHXUHQc6RK/3ErUVK5FiMpb6S9dJLFL3TB0m16DEBIlojCh1VWyEYeenh8',
            commandSign: 'yFJPWkMiCHJx3MFnmOPXUiAnEt/9GFQitz+26WnSQCk=',
            push: { name: 'd700_tot_bev_b', value: 42 },
            pushEnc: 'gEQOulk7mvaM5Ao2/i9DtT9iRpX4KYh8o0pot1j26Cup91wjBep/g8AfO+IDEF1Ki/EQnukZqEKrmT4GU/UfSw==',
            pushSign: 'vwE44y5nQrM/UHQPGgD5zt9GNRJM7h55msA8yU6Qbxw=',
        },
        {
            command: { cmds: [1] },
            commandEnc: 'bCBTHEq4U3jgLd8MQiba6gNjgNjqeu/++wUD7jc5e0H4ddxDtlGTvcVNawdY1WV2',
            commandSign: 'AxmWUunY5uFFr6emtrOVzmE2QMkGIbNqdN8hj9ndam8=',
            push: { name: 'd701_tot_bev_bw', value: 7 },
            pushEnc: 'c5fSaQ819mRakQZ2T3wNyBU0WhuLhSWN5BM1HgdmC9dRaPcRlcqarY3uXqBT7oa6sbtbz6IqU7QofS4uC+N/AQ==',
            pushSign: 'cy7booOhLrUBWzsR3b0RTIzyfyZY3X/WhqXr0miMQMI=',
        },
    ];
    for (const [index, packet] of vectors.entries()) {
        const seq_no = String(index);
        const command = encode(JSON.stringify({ seq_no, data: packet.command }),
            keys.toMachineKey, keys.toMachineIv, keys.toMachineSign);
        assert.equal(command.enc, packet.commandEnc);
        assert.equal(command.sign, packet.commandSign);
        keys.toMachineIv = command.iv;
        const push = decode(packet.pushEnc, keys.fromMachineKey, keys.fromMachineIv, keys.fromMachineSign, packet.pushSign);
        assert.equal(push.plaintext, JSON.stringify({ seq_no, data: packet.push }));
        keys.fromMachineIv = push.iv;
    }
});

test('rejects malformed encrypted payload and invalid LAN key',()=>{
    assert.throws(()=>derive('','x','y','a','b'));
    assert.throws(()=>decode('?!',Buffer.alloc(32),Buffer.alloc(16)));
    assert.throws(()=>new CoffeeLanSession({host:'0.0.0.0',port:10275,machineIp:'192.168.12.39'}));
    assert.throws(()=>new CoffeeLanSession({host:'127.0.0.1',port:10275,machineIp:'192.168.12.39'}));
});

test('chooses the source IPv4 address from the route to the machine', async () => {
    assert.equal(await lanAddressFor('127.0.0.1'), '127.0.0.1');
    await assert.rejects(lanAddressFor('coffee-machine'), /Enter the coffee machine IPv4 address/);
});

test('ECAM612 registers the default callback port with POST, DSN and notify:0',async()=>{
    const calls=[];
    const transport=new CoffeeLanSession({
        host:'192.168.12.33',machineIp:'192.168.12.39',
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
    assert.deepEqual(calls[0].body,{local_reg:{ip:'192.168.12.33',notify:0,port:10275,uri:'/local_lan'}});
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
    await transport.registerOnce();
    assert.equal(transport.registrationAttempted,true);
    assert.deepEqual(statuses,['register-http-404']);
    assert.equal(transport.registered,false);
});

test('transient registration failures have a bounded budget without leaking details',async()=>{
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
    for (let attempt = 0; attempt < 5; attempt++) await transport.registerOnce();
    assert.equal(transport.registrationAttempted,true);
    assert.deepEqual(statuses,Array(5).fill('register-connection-refused'));
});

test('retries a transient registration failure promptly and stops after success', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const session = new CoffeeLanSession({
        host: '192.168.12.33', port: 10275, machineIp: '192.168.12.39',
        registrationRequestFn: async () => {
            if (++attempts === 1) throw Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' });
            return { ok: true, status: 202 };
        },
    });
    session.configure({ dsn: 'testdsn', key: 'synthetic-key' });
    session.server = { listening: true };
    await session.registerOnce();
    context.mock.timers.tick(2999);
    assert.equal(attempts, 1);
    context.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(session.registered, true);
    context.mock.timers.tick(15000);
    assert.equal(attempts, 2);
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
