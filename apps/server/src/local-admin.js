import express from 'express';
import {MongoClient} from 'mongodb';
import {config} from './config.js';
import {initializeAnalytics} from './analytics.js';
import {mountAdmin} from './admin.js';
import {localAdminAccess} from './local-admin-access.js';
const port = Number(process.env.ADMIN_LOCAL_PORT || 8032);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('ADMIN_LOCAL_PORT must be between 1024 and 65535');
let client;
let connection;
async function connectAnalytics() {
  if (!config.mongoUri) throw Error('Set MONGODB_URI in the repository .env to read local analytics.');
  client = new MongoClient(config.mongoUri, {serverSelectionTimeoutMS:10000});
  try {await client.connect(); await initializeAnalytics(client.db(config.mongoDatabase), {readOnly:true});}
  catch (error) {await client.close(); client = undefined; throw error;}
}
const app = express();
app.disable('x-powered-by');
app.use(localAdminAccess(port));
app.use('/api/admin', async(req,res,next) => {
  try {
    connection ||= connectAnalytics().catch(error => {connection=undefined;throw error;});
    await connection;next();
  } catch {res.status(503).set('Cache-Control','no-store').json({error:'MongoDB analytics unavailable. Check MONGODB_URI, database access and network connectivity.'});}
});
mountAdmin(app, {authorize:(_req,_res,next)=>next()});
app.use((_req,res)=>res.status(404).end());
app.use((error,_req,res,_next)=>res.status(error.statusCode || error.status || 500).json({error:'Local admin request failed.'}));
const server=app.listen(port,'127.0.0.1',()=>console.log(`CraveLens local admin: http://127.0.0.1:${port}/admin/ (read-only MongoDB + Langfuse)`));
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(async()=>{await client?.close();process.exit(0);}));
