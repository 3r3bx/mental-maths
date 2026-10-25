/* Daily streak reminder: sends one Web Push to each saved iPad.
   The push carries no personal data — the app's service worker decides
   what the notification says from progress stored on the device.
   No dependencies: RFC 8291 encryption and RFC 8292 (VAPID) via node:crypto. */
import crypto from 'node:crypto';

const VAPID_PUBLIC = 'BDUPLBYyW5KlagXawTpVR8zdyR_DfjEmLAOEBReZWyvnS-6ZJv4A15s8Hr7XoSY52vGv9vjyEwK4xapE-LNQs30';
const SUBJECT = 'https://3r3bx.github.io/mental-maths/';

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(s, 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

export function vapidHeader(endpoint, privateKey, publicKey = VAPID_PUBLIC, now = Math.floor(Date.now() / 1000)){
  const head = b64u(JSON.stringify({typ: 'JWT', alg: 'ES256'}));
  const claims = b64u(JSON.stringify({aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: SUBJECT}));
  const pub = fromB64u(publicKey);
  const key = crypto.createPrivateKey({format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65))
  }});
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), {key, dsaEncoding: 'ieee-p1363'});
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

/* aes128gcm content encoding. `fixed` pins the sender key and salt for tests. */
export function encrypt(payload, p256dh, auth, fixed = {}){
  const uaPublic = fromB64u(p256dh);
  const ecdh = crypto.createECDH('prime256v1');
  if(fixed.asPrivate) ecdh.setPrivateKey(fromB64u(fixed.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed.salt ? fromB64u(fixed.salt) : crypto.randomBytes(16);

  const prkKey = hmac(fromB64u(auth), ecdh.computeSecret(uaPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/* The app shows each iPad's code as "MM1.<base64 of the subscription JSON>". */
export function parseSubscriptions(raw){
  return raw.split(/\s+/).filter(Boolean).map(code => {
    const json = code.startsWith('MM1.') ? Buffer.from(code.slice(4), 'base64').toString('utf8') : code;
    const s = JSON.parse(json);
    if(!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) throw new Error('A saved reminder code is incomplete.');
    return s;
  });
}

async function main(){
  const raw = (process.env.PUSH_SUBSCRIPTIONS || '').trim();
  if(!raw){ console.log('No reminder codes saved yet, so there is nothing to send.'); return; }
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if(!privateKey) throw new Error('The VAPID_PRIVATE_KEY secret is missing.');

  let failed = 0;
  for(const [i, sub] of parseSubscriptions(raw).entries()){
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '14400',
        Urgency: 'normal',
        Authorization: vapidHeader(sub.endpoint, privateKey)
      },
      body: encrypt(JSON.stringify({kind: 'daily'}), sub.keys.p256dh, sub.keys.auth)
    });
    // Actions logs are public for this repo: report the push service host, never the endpoint
    const host = new URL(sub.endpoint).host;
    if(res.ok){ console.log(`Device ${i + 1} (${host}): sent, status ${res.status}`); continue; }
    failed++;
    const why = res.status === 404 || res.status === 410
      ? 'this iPad no longer accepts reminders. Turn reminders on again in the app and save the new code.'
      : (await res.text()).slice(0, 200);
    console.log(`Device ${i + 1} (${host}): failed, status ${res.status}: ${why}`);
  }
  if(failed) process.exitCode = 1;   // a failed run makes GitHub email the repo owner
}

if(import.meta.url === `file://${process.argv[1]}`) await main();
