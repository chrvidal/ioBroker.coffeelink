'use strict';
// Experimental, opt-in, read-only LAN transport. Local registration does
// modify the machine's callback destination and may affect the Coffee Link app.
// Never enable this transport unless the user explicitly opts in.
const http = require('node:http');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { derive, decode, encode } = require('./lan-protocol');

const MAX_BODY = 256 * 1024;
function ipOf(req) {
    const ip=req.socket.remoteAddress || '';
    return ip.startsWith('::ffff:')?ip.slice(7):ip;
}
function reject(res, status) { res.writeHead(status, {'cache-control':'no-store'});res.end(); }
function json(res, status, data) {
    res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(data));
}
async function readJson(req) {
    const chunks=[]; let size=0;
    for await (const chunk of req) {
        size+=chunk.length;
        if(size>MAX_BODY) throw Error('Body too large');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
class CoffeeLanSession {
    constructor({host,port,machineIp,fetchFn=globalThis.fetch,onProperties=()=>{},onStatus=()=>{}}) {
        if(![host,machineIp].every(x=>net.isIP(x)===4) || host==='0.0.0.0' || host==='127.0.0.1') {
            throw Error('Active LAN requires specific non-loopback IPv4 addresses');
        }
        if(!Number.isInteger(port) || port<1024 || port>65535) throw Error('Invalid LAN port');
        this.host=host;this.port=port;this.machineIp=machineIp;
        this.fetchFn=fetchFn;this.onProperties=onProperties;this.onStatus=onStatus;
        this.server=null;this.key=null;this.dsn=null;this.keys=null;
        this.registrationAttempted=false;this.registered=false;this.sequence=0;
        this.queue=[];this.lastRequestedAt=0;this.lastReceivedAt='';
    }
    configure({dsn,key}) {
        if(typeof dsn!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(dsn) || typeof key!=='string' || !key || key.length>256) throw Error('Invalid LAN configuration');
        this.dsn=dsn;this.key=key;
    }
    async start() {
        if(this.server) throw Error('LAN already started');
        this.server=http.createServer((req,res)=>{void this.#handle(req,res).catch(()=>reject(res,400));});
        this.server.requestTimeout=5000;this.server.headersTimeout=6000;this.server.maxRequestsPerSocket=50;
        try { await new Promise((ok,fail)=>{this.server.once('error',fail);this.server.listen(this.port,this.host,ok);}); }
        catch(e){this.server=null;throw Error(`LAN listen failed: ${e.code||'unknown'}`);}
    }
    async stop(){const s=this.server;this.server=null;if(s?.listening) await new Promise(resolve=>s.close(resolve));this.keys=null;this.key=null;}
    async registerOnce() {
        if(!this.server?.listening || !this.key || !this.dsn) throw Error('LAN session not ready');
        if(this.registrationAttempted) return;
        this.registrationAttempted=true;
        // ECAM612.55: POST + DSN + notify:0 received HTTP 202 on the real device.
        // notify:1 received HTTP 400 on the same machine. Independent Ayla LAN
        // captures show notify:0 can still initiate an encrypted key exchange.
        // Registration may change the Coffee Link app's callback destination.
        const body={local_reg:{ip:this.host,notify:0,port:this.port,uri:'/local_lan'}};
        const endpoint=`http://${this.machineIp}/local_reg.json?dsn=${encodeURIComponent(this.dsn)}`;
        let response;
        try {
            response=await this.fetchFn(endpoint,{
                method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
                signal:AbortSignal.timeout(5000),redirect:'error',
            });
        } catch (error) {
            // Network failure category only; never expose URLs, credentials, or keys.
            const code = error?.cause?.code;
            const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
                ? 'register-timeout'
                : code === 'ECONNREFUSED' ? 'register-connection-refused'
                : code === 'ENETUNREACH' || code === 'EHOSTUNREACH' ? 'register-network-unreachable'
                : 'register-network-error';
            this.onStatus(reason);
            return;
        }
        this.registered=response.ok;
        const statusCode = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status : 'unknown';
        this.onStatus(response.ok ? 'registered' : `register-http-${statusCode}`);
    }
    #scheduleProperties(){
        if(!this.keys || !this.dsn || Date.now()-this.lastRequestedAt<30000 || this.queue.length) return;
        // Pure GET: no drinks, power events or settings writes.
        const cmd={seq_no:String(this.sequence),data:{cmds:[{cmd:{cmd_id:1,data:'',method:'GET',resource:"property.json?name=''",uri:'/local_lan/property/datapoint.json'}}]}};
        this.queue.push(cmd);
        this.lastRequestedAt=Date.now();
    }
    #poll(res){
        if(!this.keys){json(res,200,{enc:'',sign:'',seq:this.sequence});return;}
        this.#scheduleProperties();
        const current=this.sequence++;
        const data=this.queue.shift() || {seq_no:String(current),data:{}};
        data.seq_no=String(current);
        const value=JSON.stringify(data);
        const enc=encode(value,this.keys.toMachineKey,this.keys.toMachineIv,this.keys.toMachineSign);
        this.keys.toMachineIv=enc.iv;
        json(res,200,{enc:enc.enc,sign:enc.sign,seq:current});
    }
    #datapoint(body,res){
        if(!this.keys || typeof body.enc!=='string'){reject(res,503);return;}
        const decoded=decode(body.enc,this.keys.fromMachineKey,this.keys.fromMachineIv);
        this.keys.fromMachineIv=decoded.iv;
        const parsed=JSON.parse(decoded.plaintext);
        const properties=parsed?.data?.properties;
        if(Array.isArray(properties)) {
            const values=new Map();
            for(const entry of properties) {
                const p=entry?.property;
                if(p && typeof p.name==='string' && /^[a-zA-Z0-9_]{1,120}$/.test(p.name)) values.set(p.name,p);
            }
            this.lastReceivedAt=new Date().toISOString();
            try {this.onProperties(values,this.lastReceivedAt);} catch { /* receiver stays alive */ }
        }
        json(res,200,{});
    }
    async #handle(req,res){
        if(req.method==='GET' && req.url==='/health' && ipOf(req)===this.host){
            json(res,200,{listener:'encrypted',registration:this.registered?'sent':'not-sent',connected:!!this.keys,lastReceivedAt:this.lastReceivedAt});return;
        }
        if(ipOf(req)!==this.machineIp){reject(res,403);return;}
        if(!this.key){reject(res,503);return;}
        if(req.url==='/local_lan/key_exchange.json' && req.method==='POST') {
            const body=await readJson(req);
            const exchanged=body?.key_exchange;
            if(!exchanged || typeof exchanged.random_1!=='string' || !['string','number'].includes(typeof exchanged.time_1)) {reject(res,400);return;}
            const randomServer=randomBytes(12).toString('base64');
            const timeServer=String(Date.now());
            this.keys=derive(this.key,exchanged.random_1,randomServer,String(exchanged.time_1),timeServer);
            this.sequence=0;this.queue=[];this.lastRequestedAt=0;
            this.onStatus('encrypted');
            json(res,202,{random_2:randomServer,time_2:Number(timeServer)});return;
        }
        if(req.url==='/local_lan/commands.json' && ['GET','POST'].includes(req.method)){
            if(req.method==='POST') await readJson(req).catch(()=>{});
            this.#poll(res);return;
        }
        if(req.url==='/local_lan/property/datapoint.json' && req.method==='POST'){
            const body=await readJson(req);this.#datapoint(body,res);return;
        }
        reject(res,404);
    }
}
module.exports={CoffeeLanSession};
