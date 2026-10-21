'use strict';
// Loopback-only SMTP sink. It can receive synthetic mail; it never forwards mail.
const net = require('node:net');
const tls = require('node:tls');
const { once } = require('node:events');
async function startSmtpFixture({ cert, key, transientRejects = 0 }) {
  const messages = [], sockets = new Set();
  const result = { messages, rejections: 0, tlsConnections: 0 };
  const secureContext = tls.createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
  const server = net.createServer(raw => {
    sockets.add(raw); raw.on('close', () => sockets.delete(raw)); raw.on('error', () => {});
    const state = { socket: raw, buffer: '', secure: false, authed: false, data: null, authPending: false };
    const reply = text => { if (!state.socket.destroyed) state.socket.write(text + '\r\n'); };
    const auth = encoded => {
      const fields = Buffer.from(encoded || '', 'base64').toString('utf8').split('\0');
      state.authed = state.secure && fields.at(-2) === 'fixture' && fields.at(-1) === 'local-fixture-password';
      reply(state.authed ? '235 Authentication successful' : '535 Authentication failed');
    };
    const onData = chunk => {
      state.buffer += chunk.toString('utf8');
      if (state.buffer.length > 100000) { state.socket.destroy(); return; }
      let end;
      while ((end = state.buffer.indexOf('\r\n')) >= 0) {
        const line = state.buffer.slice(0, end); state.buffer = state.buffer.slice(end + 2);
        if (state.data) {
          if (line === '.') { messages.push(state.data.join('\r\n')); state.data = null; reply('250 Stored locally'); }
          else state.data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (state.authPending) { state.authPending = false; auth(line); continue; }
        const command = line.split(' ')[0].toUpperCase();
        if (command === 'EHLO' || command === 'HELO') {
          reply(state.secure ? '250-localhost\r\n250-AUTH PLAIN\r\n250 SIZE 100000' : '250-localhost\r\n250-STARTTLS\r\n250 SIZE 100000');
        } else if (command === 'STARTTLS' && !state.secure) {
          reply('220 Ready to start TLS'); raw.removeListener('data', onData);
          const secured = new tls.TLSSocket(raw, { isServer: true, secureContext });
          state.socket = secured; state.buffer = ''; state.secure = true; state.authed = false;
          secured.on('secure', () => { result.tlsConnections++; }); secured.on('error', () => {}); secured.on('data', onData);
          return;
        } else if (command === 'AUTH') {
          if (!state.secure) reply('530 TLS required');
          else { const token = line.split(' ')[2]; if (token) auth(token); else { state.authPending = true; reply('334 '); } }
        } else if (command === 'MAIL' || command === 'RCPT') {
          reply(state.secure && state.authed ? '250 OK' : '530 Authentication and TLS required');
        } else if (command === 'DATA') {
          if (!state.secure || !state.authed) reply('530 Authentication and TLS required');
          else if (result.rejections < transientRejects) { result.rejections++; reply('451 Temporary local fixture refusal'); }
          else { state.data = []; reply('354 End with dot'); }
        } else if (command === 'QUIT') { reply('221 Bye'); state.socket.end(); }
        else if (command === 'RSET' || command === 'NOOP') reply('250 OK');
        else reply('500 Unknown local fixture command');
      }
    };
    raw.on('data', onData); reply('220 localhost fixture SMTP');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); result.port = server.address().port;
  result.close = async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); };
  return result;
}
module.exports = { startSmtpFixture };
