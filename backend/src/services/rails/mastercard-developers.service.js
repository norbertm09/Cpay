'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

const percent = (value) => encodeURIComponent(value).replace(/[!*()']/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const readPrivateKey = () => {
  const raw = process.env.MASTERCARD_DEVELOPERS_PRIVATE_KEY || process.env.MASTERCARD_PRIVATE_KEY;
  const path = process.env.MASTERCARD_DEVELOPERS_PRIVATE_KEY_PATH || process.env.MASTERCARD_PRIVATE_KEY_PATH;
  if (raw) return raw.replace(/\\n/g, '\n');
  if (path && fs.existsSync(path)) return fs.readFileSync(path, 'utf8');
  throw new Error('Mastercard Developers private key not configured');
};

const buildOAuthHeader = ({ method, url, body = null }) => {
  const consumerKey = process.env.MASTERCARD_DEVELOPERS_CONSUMER_KEY || process.env.MASTERCARD_CONSUMER_KEY;
  if (!consumerKey) throw new Error('Mastercard Developers consumer key not configured');

  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'RSA-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };

  const params = [];
  for (const [key, value] of new URL(url).searchParams.entries()) params.push([key, value]);
  for (const [key, value] of Object.entries(oauth)) params.push([key, value]);
  const normalizedParams = params
    .sort(([aKey, aVal], [bKey, bVal]) => aKey === bKey ? String(aVal).localeCompare(String(bVal)) : aKey.localeCompare(bKey))
    .map(([key, value]) => `${percent(key)}=${percent(value)}`)
    .join('&');

  const urlWithoutQuery = `${new URL(url).origin}${new URL(url).pathname}`;
  const baseString = [method.toUpperCase(), percent(urlWithoutQuery), percent(normalizedParams)].join('&');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(baseString);
  signer.end();
  oauth.oauth_signature = signer.sign(readPrivateKey(), 'base64');

  return 'OAuth ' + Object.entries(oauth)
    .map(([key, value]) => `${percent(key)}="${percent(value)}"`)
    .join(',');
};

const request = ({ method = 'GET', path, query = {}, body = null }) => new Promise((resolve, reject) => {
  const baseUrl = process.env.MASTERCARD_DEVELOPERS_BASE_URL || 'https://apiedge.mastercard.com/developers';
  const url = new URL(path, baseUrl);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    Authorization: buildOAuthHeader({ method, url: url.toString(), body: payload }),
    Accept: 'application/json',
    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
  };

  const req = https.request({
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method,
    headers,
    timeout: parseInt(process.env.MASTERCARD_DEVELOPERS_TIMEOUT_MS || '20000', 10),
  }, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', c => { raw += c; });
    res.on('end', () => {
      let parsed = {};
      try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw }; }
      resolve({ statusCode: res.statusCode, body: parsed });
    });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('Mastercard Developers API timeout')));
  if (payload) req.write(payload);
  req.end();
});

const ensureOk = (result, label) => {
  if (result.statusCode >= 200 && result.statusCode < 300) return result.body;
  const err = new Error(result.body?.Errors?.Error?.[0]?.Description || result.body?.message || `${label} failed`);
  err.statusCode = result.statusCode;
  err.response = result.body;
  throw err;
};

const getServices = async (query = {}) => ensureOk(await request({ path: '/services', query }), 'Mastercard get services');
const getService = async (serviceId) => ensureOk(await request({ path: `/services/${serviceId}` }), 'Mastercard get service');
const getProjects = async (query = {}) => ensureOk(await request({ path: '/projects', query }), 'Mastercard get projects');
const createProject = async (body) => ensureOk(await request({ method: 'POST', path: '/projects', body }), 'Mastercard create project');
const getProject = async (projectId) => ensureOk(await request({ path: `/projects/${projectId}` }), 'Mastercard get project');
const addServiceToProject = async (projectId, body) => ensureOk(await request({ method: 'POST', path: `/projects/${projectId}/services`, body }), 'Mastercard add service');
const addCredential = async (projectId, body) => ensureOk(await request({ method: 'POST', path: `/projects/${projectId}/credentials`, body }), 'Mastercard add credential');

module.exports = {
  request,
  getServices,
  getService,
  getProjects,
  createProject,
  getProject,
  addServiceToProject,
  addCredential,
};
