import {expect,it,vi} from 'vitest';
import {localAdminAccess} from '../src/local-admin-access.js';
import {initializeAnalytics,recordEvent} from '../src/analytics.js';
function request(overrides={}) {const headers={host:'127.0.0.1:8032',...overrides.headers};return {method:overrides.method || 'GET',socket:{remoteAddress:overrides.peer || '127.0.0.1'},get:name=>headers[name]};}
function allowed(req) {const next=vi.fn();const res={status:vi.fn().mockReturnThis(),json:vi.fn()};localAdminAccess(8032)(req,res,next);return {next,res};}
it('allows same-origin loopback reads, denies rebinding, external peers and writes',()=>{
 expect(allowed(request()).next).toHaveBeenCalledOnce();
 for(const req of [request({headers:{host:'attacker.example:8032'}}),request({peer:'192.168.1.2'}),request({headers:{'sec-fetch-site':'cross-site'}}),request({headers:{origin:'https://attacker.example'}}),request({method:'POST'})]) expect(allowed(req).next).not.toHaveBeenCalled();
});
it('attaches the local analytics database without indexes or writes',async()=>{
 const collection=vi.fn();await initializeAnalytics({collection},{readOnly:true});await recordEvent({kind:'detection'});expect(collection).not.toHaveBeenCalled();
});
