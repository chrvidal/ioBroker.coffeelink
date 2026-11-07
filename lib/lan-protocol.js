'use strict';
// Independent implementation of the De'Longhi LAN session wire protocol.
// No network I/O in this module. Never log keys, plaintext or raw payloads.
const { createHmac, createCipheriv, createDecipheriv } = require('node:crypto');
const mac = (key, value) => createHmac('sha256', key).update(value).digest();
const suffix = (bytes, type) => Buffer.concat([bytes, Buffer.from(type)]);
function derive(lanKey, randomDevice, randomServer, timeDevice, timeServer) {
    if (typeof lanKey !== 'string' || !lanKey || lanKey.length > 256) throw Error('Invalid LAN secret');
    for (const x of [randomDevice,randomServer,timeDevice,timeServer]) {
        if (typeof x !== 'string' || !x || x.length > 128) throw Error('Invalid key exchange fields');
    }
    const key=Buffer.from(lanKey,'utf8');
    const digest=(data, marker)=>{const b=suffix(Buffer.from(data,'utf8'),marker);return mac(key,Buffer.concat([mac(key,b),b]));};
    const client=[randomDevice,randomServer,timeDevice,timeServer].join('');
    const server=[randomServer,randomDevice,timeServer,timeDevice].join('');
    return {
        toMachineSign:digest(client,'0'),
        toMachineKey:digest(client,'1').subarray(0,16),
        toMachineIv:digest(client,'2').subarray(0,16),
        fromMachineKey:digest(server,'1').subarray(0,16),
        fromMachineIv:digest(server,'2').subarray(0,16),
    };
}
function fromBase64(v) {
    if (typeof v!=='string' || !v || v.length>262144 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) throw Error('Malformed encrypted packet');
    const buf=Buffer.from(v,'base64');
    if(!buf.length || buf.length%16) throw Error('Invalid ciphertext size');
    return buf;
}
function decode(enc,key,iv){
    const ciphertext=fromBase64(enc);
    const decipher=createDecipheriv('aes-128-cbc',key,iv);
    decipher.setAutoPadding(false);
    const plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    // Protocol uses zero padding, not PKCS#7.
    return { plaintext:plain.toString('utf8').replace(/\0+$/g,''), iv:ciphertext.subarray(-16) };
}
function encode(value,key,iv,signKey){
    const data=Buffer.from(value,'utf8');
    const extra=16-data.length%16;
    const padded=Buffer.concat([data,Buffer.alloc(extra)]);
    const cipher=createCipheriv('aes-128-cbc',key,iv);
    cipher.setAutoPadding(false);
    const encrypted=Buffer.concat([cipher.update(padded),cipher.final()]);
    return {enc:encrypted.toString('base64'),sign:mac(signKey,data).toString('base64'),iv:encrypted.subarray(-16)};
}
module.exports={derive,decode,encode};
