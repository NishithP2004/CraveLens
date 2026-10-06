import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createAdminAccessVerifier } from '@cravelens/shared/access';
import { aggregateObservations, langfuseSummary } from '../src/admin-langfuse.js';
import { initializeAnalytics, recordConfirmedOrder, recordDevice, recordEvent } from '../src/analytics.js';
import { config } from '../src/config.js';

describe('Admin Access authorization',()=>{
  it('validates issuer, audience, expiry and the human email allowlist',async()=>{
    const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='test';
    const settings={teamDomain:'https://example.cloudflareaccess.com',audience:'admin-audience',emails:'admin@example.com'};
    const verify=createAdminAccessVerifier(settings,createLocalJWKSet({keys:[jwk]}));
    const token=async(overrides={})=>new SignJWT({email:'admin@example.com',...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(settings.teamDomain).setAudience(overrides.aud || settings.audience).setSubject('human').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    expect((await verify(await token())).email).toBe('admin@example.com');
    await expect(verify(await token({email:'visitor@example.com'}))).rejects.toMatchObject({statusCode:403});
    await expect(verify(await token({aud:'origin-service-audience'}))).rejects.toMatchObject({statusCode:403});
    const bad=new SignJWT({email:'admin@example.com'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(settings.teamDomain).setAudience(settings.audience).setSubject('human').setIssuedAt().setExpirationTime(1);
    await expect(verify(await bad.sign(privateKey))).rejects.toMatchObject({statusCode:403});
    await expect(verify('forged')).rejects.toMatchObject({statusCode:403});
    await expect(verify()).rejects.toMatchObject({statusCode:403});
    expect(()=>createAdminAccessVerifier({})).toThrow();
  });
});
it('counts actual generations, hybrid traces and failures without counting the fallback router or foreign traces',()=>{
  const base={traceId:'a',startTime:'2026-10-01T00:00:00Z',endTime:'2026-10-01T00:00:01Z'};
  const result=aggregateObservations([{...base,type:'SPAN',name:'cart.prepare'}, {...base,type:'GENERATION',name:'RemoteBrowserChatModel',level:'ERROR',metadata:{origin:'local',model:'gemma',provider:'litert'}},{...base,type:'GENERATION',name:'ChatGoogle',metadata:{origin:'hosted',model:'gemini',provider:'google'}},{...base,type:'GENERATION',name:'ApprovalFallbackChatModel'}, {...base,traceId:'foreign',type:'GENERATION',name:'ChatGoogle'}]);
  expect(result.hybrid).toBe(1);expect(result.hybridCalls).toBe(1);expect(result.models.reduce((n,r)=>n+r.count,0)).toBe(2);expect(result.failures[0].count).toBe(1);expect(result.models[0].averageMs).toBe(1000);
});
it('reports Langfuse failure as unavailable instead of zero usage',async()=>{
  vi.stubEnv('LANGFUSE_PUBLIC_KEY','test');vi.stubEnv('LANGFUSE_SECRET_KEY','test');
  const result=await langfuseSummary(7,async()=>new Response('{}',{status:403}));
  expect(result.status.available).toBe(false);expect(result.hybrid).toBeNull();vi.unstubAllEnvs();
});
it('deduplicates confirmed orders and stores no order/customer payloads',async()=>{
  const records=new Map();const indexes=[];const db={collection:name=>({createIndex:async(...args)=>indexes.push([name,...args]),updateOne:async(filter,update)=>{const key=name+filter._id;records.set(key,{...update.$setOnInsert,...records.get(key),...update.$set});}})};
  await initializeAnalytics(db);config.deviceSessionSigningKey='isolated-test-key-at-least-32-characters';
  await recordDevice('private-device',true);
  const thread={threadId:'thread-one',status:'ordered',order:{phone:'private-phone'},suggestion:{finalAmount:200,addressId:'private-address'},paymentMethod:'COD'};
  await recordConfirmedOrder(thread);await recordConfirmedOrder(thread);await recordConfirmedOrder({...thread,status:'payment_pending'});
  expect([...records.keys()].filter(k=>k.startsWith('analytics_orders'))).toHaveLength(1);
  expect(JSON.stringify([...records])).not.toMatch(/private-device|private-phone|private-address/);
  expect(indexes.some(([name,,opts])=>name==='analytics_events'&&opts.expireAfterSeconds===90*86400)).toBe(true);
  // Initialize normally, then simulate an event write failure without retrying business actions.
  db.collection=()=>({updateOne:async()=>{throw Error('offline');}});
  await expect(recordEvent({kind:'cart',outcome:'error'})).resolves.toBeUndefined();
});

it('falls back to legacy Langfuse pagination and strips payloads before returning aggregates', async()=>{
  vi.stubEnv('LANGFUSE_PUBLIC_KEY','test');vi.stubEnv('LANGFUSE_SECRET_KEY','test');vi.stubEnv('LANGFUSE_BASE_URL','https://legacy-test.example');
  const calls=[];const result=await langfuseSummary(30,async url=>{calls.push(url);if(url.pathname.includes('/v2/'))return new Response('{}',{status:404});return Response.json({data:[{id:'root',traceId:'trace',name:'cart.prepare',type:'SPAN',startTime:'2026-10-01T00:00:00Z',input:'private-input'},{id:'model',traceId:'trace',name:'ChatGoogle',type:'GENERATION',startTime:'2026-10-01T00:00:00Z',endTime:'2026-10-01T00:00:01Z',output:'private-response',metadata:{origin:'hosted',provider:'google',model:'gemini',private:'private-value'}}],meta:{totalPages:1}});});
  expect(result.status.available).toBe(true);expect(calls).toHaveLength(2);expect(result.modes).toEqual([{_id:'hosted',count:1}]);expect(JSON.stringify(result)).not.toContain('private-');vi.unstubAllEnvs();
});
