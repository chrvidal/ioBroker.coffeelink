'use strict';
const {createHmac,createCipheriv,createDecipheriv}=require('node:crypto');
const mac=(key,value)=>createHmac('sha256',key).update(value).digest();
const suffix=(bytes,type)=>Buffer.concat([bytes,Buffer.from(type)]);
function derive(lanKey,randomDevice,randomServer,timeDevice,timeServer){
 if(typeof lanKey!=='string'||!lanKey||lanKey.length>256)throw Error('Invalid LAN secret');
 for(const x of [randomDevice,randomServer,timeDevice,timeServer])if(typeof x!=='string'||!x||x.length>128)throw Error('Invalid key exchange fields');
 const key=Buffer.from(lanKey,'utf8');
 const digest=(data,marker)=>{const b=suffix(Buffer.from(data,'utf8'),marker);return mac(key,Buffer.concat([mac(key,b),b]));};
 const client=[randomDevice,randomServer,timeDevice,timeServer].join('');
 const server=[randomServer,randomDevice,timeServer,timeDevice].join('');
 return {toMachineSign:digest(client,'0'),toMachineKey:digest(client,'1'),toMachineIv:digest(client,'2').subarray(0,16),fromMachineKey:digest(server,'1'),fromMachineIv:digest(server,'2').subarray(0,16)};
}
function fromBase64(v){if(typeof v!=='string'||!v||v.length>262144||!/^[A-Za-z0-9+/]+={0,2}$/.test(v))throw Error('Malformed encrypted packet');const b=Buffer.from(v,'base64');if(!b.length||b.length%16)throw Error('Invalid ciphertext size');return b;}
function decode(enc,key,iv){const ciphertext=fromBase64(enc);const d=createDecipheriv('aes-256-cbc',key,iv);d.setAutoPadding(false);const plain=Buffer.concat([d.update(ciphertext),d.final()]);return {plaintext:plain.toString('utf8').replace(/\0+$/g,''),iv:ciphertext.subarray(-16)};}
function encode(value,key,iv,signKey){const data=Buffer.from(value,'utf8');const extra=16-data.length%16;const padded=Buffer.concat([data,Buffer.alloc(extra)]);const c=createCipheriv('aes-256-cbc',key,iv);c.setAutoPadding(false);const encrypted=Buffer.concat([c.update(padded),c.final()]);return {enc:encrypted.toString('base64'),sign:mac(signKey,data).toString('base64'),iv:encrypted.subarray(-16)};}
module.exports={derive,decode,encode};
