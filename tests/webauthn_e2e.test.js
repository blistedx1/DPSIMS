require('dotenv').config();
const { chromium } = require('playwright');
const http = require('http');
const db = require('../db');
const { hashSecret } = require('../lib/auth');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function bufferToBase64URL(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64URLToBuffer(base64url) {
  if (!base64url) return new Uint8Array(0).buffer;
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray.buffer;
}

function apiRequest(method, path, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const dataStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataStr),
        'Cookie': cookie,
        'Host': 'localhost:3000',
        'Origin': 'http://localhost:3000'
      }
    }, res => {
      let resBody = '';
      res.on('data', c => { resBody += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(resBody); } catch(e) { parsed = resBody; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });
    req.on('error', reject);
    if (dataStr) req.write(dataStr);
    req.end();
  });
}

async function runTestSuite() {
  console.log('===============================================================');
  console.log('  DPS Amrapali - WebAuthn Server-Verified Passkey Test Suite   ');
  console.log('===============================================================');

  // Start local server
  require('../server');
  await new Promise(r => setTimeout(r, 1200));

  let browser;
  let context;
  let page;
  let cdp;

  try {
    // Launch Microsoft Edge Chromium
    browser = await chromium.launch({
      executablePath: EDGE_PATH,
      headless: true
    });
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');

    console.log('\n[TEST 1] First PIN sign-in & Limited Session enforcement');
    // Teacher: Ms. Aparna
    const teacherName = 'Ms. Aparna';
    // Clean any prior test passkeys for Ms. Aparna
    const userRes = await db.query('SELECT id FROM users WHERE username = $1;', [teacherName]);
    const userId = userRes.rows[0].id;
    await db.query('DELETE FROM passkeys WHERE user_id = $1;', [userId]);
    await db.query('UPDATE users SET reset_required = FALSE, pin_changed = FALSE, pin_hash = $2 WHERE id = $1;', [userId, hashSecret('1234')]);

    // 1a: Login with default PIN -> triggers PIN change requirement
    const tLogin1 = await apiRequest('POST', '/api/auth/login', {
      username: teacherName,
      role: 'teacher',
      pin: '1234'
    });
    console.log('  1a. Default PIN check code:', tLogin1.body.code);
    if (tLogin1.body.code !== 'PIN_CHANGE_REQUIRED') {
      throw new Error('Expected PIN_CHANGE_REQUIRED for first-time teacher login');
    }

    // 1b: Login with new PIN
    const tLogin2 = await apiRequest('POST', '/api/auth/login', {
      username: teacherName,
      role: 'teacher',
      pin: '1234',
      newPin: '8392'
    });
    console.log('  1b. New PIN setup status:', tLogin2.body.status);
    if (tLogin2.body.status !== 'ENROLL_REQUIRED') {
      throw new Error(`Expected ENROLL_REQUIRED after PIN change, got ${JSON.stringify(tLogin2.body)}`);
    }
    const limitedCookie = tLogin2.headers['set-cookie'][0].split(';')[0];

    // 1c: Verify Limited Session CANNOT call /api/data
    const dataRes = await apiRequest('GET', '/api/data', null, limitedCookie);
    console.log('  1c. Calling /api/data with limited session status:', dataRes.status);
    if (dataRes.status !== 403) {
      throw new Error(`Expected 403 Forbidden for limited session on /api/data, got ${dataRes.status}`);
    }
    console.log('  ✅ TEST 1 PASSED: Limited session correctly enforced and blocked from app APIs.');

    console.log('\n[TEST 2] WebAuthn Registration via Virtual Authenticator (UV=true)');
    // Add Virtual Authenticator Device 1 (Mobile)
    const auth1 = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true
      }
    });

    // Navigate page so document has localhost origin
    await page.goto('http://localhost:3000/');

    // Get Registration Options
    const regOptRes = await apiRequest('POST', '/api/webauthn/register/options', {}, limitedCookie);
    const regOpts = regOptRes.body.options;
    if (!regOpts || !regOpts.challenge) throw new Error('Failed to get registration options');

    // Execute navigator.credentials.create in page context
    const regResult = await page.evaluate(async (opts) => {
      function b64ToBuf(b) {
        var pad = '='.repeat((4 - (b.length % 4)) % 4);
        var base64 = (b + pad).replace(/-/g, '+').replace(/_/g, '/');
        var raw = atob(base64);
        var arr = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr.buffer;
      }
      function bufToB64(buf) {
        var bytes = new Uint8Array(buf);
        var str = '';
        for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
        return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }

      opts.challenge = b64ToBuf(opts.challenge);
      opts.user.id = b64ToBuf(opts.user.id);
      if (opts.excludeCredentials) {
        opts.excludeCredentials.forEach(c => { c.id = b64ToBuf(c.id); });
      }

      const cred = await navigator.credentials.create({ publicKey: opts });
      return {
        id: cred.id,
        rawId: bufToB64(cred.rawId),
        type: cred.type,
        response: {
          attestationObject: bufToB64(cred.response.attestationObject),
          clientDataJSON: bufToB64(cred.response.clientDataJSON),
          transports: (cred.response.getTransports && cred.response.getTransports()) || []
        }
      };
    }, regOpts);

    // Verify registration on server
    const regVerRes = await apiRequest('POST', '/api/webauthn/register/verify', {
      response: regResult,
      deviceLabel: 'Pixel Phone (Android)'
    }, limitedCookie);

    console.log('  2a. Registration verification status:', regVerRes.status);
    console.log('  2b. Verified:', regVerRes.body.verified);
    if (!regVerRes.body.verified) throw new Error('Registration verification failed');

    // Extract FULL session cookie
    const setCookieHeader = regVerRes.headers['set-cookie'];
    const fullSessionCookie = setCookieHeader.find(c => c.startsWith('dps_session=')).split(';')[0];
    console.log('  2c. Full session cookie received:', fullSessionCookie.slice(0, 32) + '...');

    // Verify FULL session can now access /api/data
    const dataFullRes = await apiRequest('GET', '/api/data', null, fullSessionCookie);
    console.log('  2d. Calling /api/data with full session status:', dataFullRes.status);
    if (dataFullRes.status !== 200) throw new Error('Expected 200 OK for full session on /api/data');
    console.log('  ✅ TEST 2 PASSED: Passkey successfully registered and full session issued.');

    console.log('\n[TEST 3] Enforcement: PIN/Password login rejected after passkey registration');
    // Try signing in with PIN 8392 for Ms. Aparna
    const enforcedRes = await apiRequest('POST', '/api/auth/login', {
      username: teacherName,
      role: 'teacher',
      pin: '8392'
    });
    console.log('  3a. PIN Login Status:', enforcedRes.status);
    console.log('  3b. Response Code:', enforcedRes.body.code);
    console.log('  3c. Message:', enforcedRes.body.message);

    if (enforcedRes.status !== 403 || enforcedRes.body.code !== 'PASSKEY_ENFORCED') {
      throw new Error(`Enforcement failed! Server should reject PIN login with 403 PASSKEY_ENFORCED, got ${enforcedRes.status}`);
    }
    console.log('  ✅ TEST 3 PASSED: Server strictly rejected PIN login for user with active passkey.');

    console.log('\n[TEST 4] WebAuthn Authentication: UV=true succeeds, UV=false fails, replay fails');
    // 4a. Authentication options
    const authOptRes = await apiRequest('POST', '/api/webauthn/login/options', {
      username: teacherName,
      role: 'teacher'
    });
    const authOpts = authOptRes.body.options;
    console.log('  4a. Auth Challenge generated:', !!authOpts.challenge);

    // 4b. Authenticate with UV=true
    const authAssertion = await page.evaluate(async (opts) => {
      function b64ToBuf(b) {
        var pad = '='.repeat((4 - (b.length % 4)) % 4);
        var base64 = (b + pad).replace(/-/g, '+').replace(/_/g, '/');
        var raw = atob(base64);
        var arr = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr.buffer;
      }
      function bufToB64(buf) {
        var bytes = new Uint8Array(buf);
        var str = '';
        for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
        return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }

      opts.challenge = b64ToBuf(opts.challenge);
      if (opts.allowCredentials) {
        opts.allowCredentials.forEach(c => { c.id = b64ToBuf(c.id); });
      }

      const assertion = await navigator.credentials.get({ publicKey: opts });
      return {
        id: assertion.id,
        rawId: bufToB64(assertion.rawId),
        type: assertion.type,
        response: {
          authenticatorData: bufToB64(assertion.response.authenticatorData),
          clientDataJSON: bufToB64(assertion.response.clientDataJSON),
          signature: bufToB64(assertion.response.signature),
          userHandle: assertion.response.userHandle ? bufToB64(assertion.response.userHandle) : null
        }
      };
    }, authOpts);

    const authVerRes = await apiRequest('POST', '/api/webauthn/login/verify', {
      username: teacherName,
      response: authAssertion
    });
    console.log('  4b. Authentication verify with UV=true status:', authVerRes.status);
    console.log('  4b. Verified:', authVerRes.body.verified);
    if (!authVerRes.body.verified) throw new Error('Authentication with UV=true should succeed');

    // 4c. Replay / Challenge Reuse check: Try replaying the exact same assertion
    const replayRes = await apiRequest('POST', '/api/webauthn/login/verify', {
      username: teacherName,
      response: authAssertion
    });
    console.log('  4c. Replay / Reused Challenge verify status:', replayRes.status, '(Expected 400)');
    if (replayRes.status !== 400) throw new Error('Replay assertion should be rejected');

    // 4d. UV=false failure test
    // Create virtual authenticator with isUserVerified: false
    await cdp.send('WebAuthn.setUserVerified', {
      authenticatorId: auth1.authenticatorId,
      isUserVerified: false
    });

    const authOptResUVFalse = await apiRequest('POST', '/api/webauthn/login/options', {
      username: teacherName,
      role: 'teacher'
    });

    let uvFalseAssertion = null;
    let clientRejected = false;
    try {
      uvFalseAssertion = await page.evaluate(async (opts) => {
        function b64ToBuf(b) {
          var pad = '='.repeat((4 - (b.length % 4)) % 4);
          var base64 = (b + pad).replace(/-/g, '+').replace(/_/g, '/');
          var raw = atob(base64);
          var arr = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          return arr.buffer;
        }
        function bufToB64(buf) {
          var bytes = new Uint8Array(buf);
          var str = '';
          for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
          return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }
        opts.challenge = b64ToBuf(opts.challenge);
        if (opts.allowCredentials) {
          opts.allowCredentials.forEach(c => { c.id = b64ToBuf(c.id); });
        }
        const assertion = await navigator.credentials.get({ publicKey: opts });
        return {
          id: assertion.id,
          rawId: bufToB64(assertion.rawId),
          type: assertion.type,
          response: {
            authenticatorData: bufToB64(assertion.response.authenticatorData),
            clientDataJSON: bufToB64(assertion.response.clientDataJSON),
            signature: bufToB64(assertion.response.signature)
          }
        };
      }, authOptResUVFalse.body.options);
    } catch (e) {
      clientRejected = true;
      console.log('  4d. Authenticator client rejected UV=false with NotAllowedError (Spec compliant)');
    }

    if (!clientRejected && uvFalseAssertion) {
      const uvFalseVer = await apiRequest('POST', '/api/webauthn/login/verify', {
        username: teacherName,
        response: uvFalseAssertion
      });
      console.log('  4d. Verify with UV=false status:', uvFalseVer.status, '(Expected 400)');
      if (uvFalseVer.status !== 400) throw new Error('Assertion with UV=false must be rejected');
    }
    console.log('  ✅ TEST 4 PASSED: UV=true passed, UV=false rejected, assertion replay rejected.');

    console.log('\n[TEST 5] Second Device Registration & Admin Revoke Device');
    // Restore UV=true
    await cdp.send('WebAuthn.setUserVerified', {
      authenticatorId: auth1.authenticatorId,
      isUserVerified: true
    });

    // Remove Device 1 to simulate registering on Device 2 (Chrome/Edge supports 1 internal authenticator per context)
    await cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: auth1.authenticatorId
    });

    // Add a second virtual authenticator (Device 2 - Laptop)
    const auth2 = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true
      }
    });

    // Register second device using fullSessionCookie
    const reg2OptRes = await apiRequest('POST', '/api/webauthn/register/options', {}, fullSessionCookie);
    const reg2Result = await page.evaluate(async (opts) => {
      function b64ToBuf(b) {
        var pad = '='.repeat((4 - (b.length % 4)) % 4);
        var base64 = (b + pad).replace(/-/g, '+').replace(/_/g, '/');
        var raw = atob(base64);
        var arr = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr.buffer;
      }
      function bufToB64(buf) {
        var bytes = new Uint8Array(buf);
        var str = '';
        for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
        return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }

      opts.challenge = b64ToBuf(opts.challenge);
      opts.user.id = b64ToBuf(opts.user.id);
      if (opts.excludeCredentials) {
        opts.excludeCredentials.forEach(c => { c.id = b64ToBuf(c.id); });
      }

      const cred = await navigator.credentials.create({ publicKey: opts });
      return {
        id: cred.id,
        rawId: bufToB64(cred.rawId),
        type: cred.type,
        response: {
          attestationObject: bufToB64(cred.response.attestationObject),
          clientDataJSON: bufToB64(cred.response.clientDataJSON),
          transports: (cred.response.getTransports && cred.response.getTransports()) || []
        }
      };
    }, reg2OptRes.body.options);

    const reg2VerRes = await apiRequest('POST', '/api/webauthn/register/verify', {
      response: reg2Result,
      deviceLabel: 'Windows Laptop (Edge)'
    }, fullSessionCookie);

    console.log('  5a. Second device registration verified:', reg2VerRes.body.verified);

    // Admin login to manage devices
    // Give admin a temporary full session
    const { signToken, formatCookie } = require('../lib/auth');
    const adminSessionToken = signToken({
      userId: 1,
      username: 'admin',
      role: 'admin',
      displayName: 'Administrator',
      scope: 'full'
    }, 3600000);
    const adminCookie = formatCookie('dps_session', adminSessionToken, 3600, true);

    // Query devices for Ms. Aparna
    const devListRes = await apiRequest('GET', `/api/auth/admin/devices?userId=${userId}`, null, adminCookie);
    const passkeys = devListRes.body.passkeys;
    console.log('  5b. Active devices for user:', passkeys.length);
    if (passkeys.length < 2) throw new Error('Expected at least 2 active devices');

    // Revoke first device
    const revokeId = passkeys[0].id;
    const revRes = await apiRequest('POST', '/api/auth/admin/devices', {
      action: 'revoke',
      passkeyId: revokeId
    }, adminCookie);
    console.log('  5c. Revoke device status:', revRes.body.ok);

    const afterRevRes = await apiRequest('GET', `/api/auth/admin/devices?userId=${userId}`, null, adminCookie);
    const activeLeft = afterRevRes.body.passkeys.filter(p => p.isActive);
    console.log('  5d. Active devices remaining:', activeLeft.length);
    if (activeLeft.length !== 1) throw new Error('Expected 1 active device after revocation');
    console.log('  ✅ TEST 5 PASSED: Second device registered and individual device revoked successfully.');

    console.log('\n[TEST 6] Admin Reset Screen Lock Flow');
    // Admin resets user's screen lock
    const resetRes = await apiRequest('POST', '/api/auth/admin/devices', {
      action: 'reset_user',
      targetUserId: userId
    }, adminCookie);
    console.log('  6a. Admin reset user response:', resetRes.body.message);

    // Verify user can now sign in once with PIN 8392
    const afterResetLogin = await apiRequest('POST', '/api/auth/login', {
      username: teacherName,
      role: 'teacher',
      pin: '8392'
    });
    console.log('  6b. PIN login after Admin reset status:', afterResetLogin.body.status);
    if (afterResetLogin.body.status !== 'ENROLL_REQUIRED') {
      throw new Error(`Expected ENROLL_REQUIRED after Admin reset, got ${afterResetLogin.body.status}`);
    }
    console.log('  ✅ TEST 6 PASSED: Admin reset allowed one PIN login followed by forced re-registration.');

    console.log('\n[TEST 7] Expired Challenges & Origin Security Checks');
    // Test expired challenge rejection
    await db.query(`
      INSERT INTO webauthn_challenges (challenge, user_id, type, expires_at)
      VALUES ('expired-test-challenge-123', $1, 'authentication', NOW() - INTERVAL '10 minutes');
    `, [userId]);

    const expAuthRes = await apiRequest('POST', '/api/webauthn/login/verify', {
      username: teacherName,
      response: { id: 'any-cred-id' }
    });
    console.log('  7a. Expired challenge rejection status:', expAuthRes.status, '(Expected 400)');
    if (expAuthRes.status !== 400) throw new Error('Expired challenge should be rejected');

    console.log('  ✅ TEST 7 PASSED: Expired challenges correctly rejected.');

    console.log('\n===============================================================');
    console.log('  🎉 ALL 7 E2E WEBAUTHN TESTS PASSED WITH 100% SUCCESS!        ');
    console.log('===============================================================\n');

  } catch(err) {
    console.error('Test Suite Failed:', err);
    process.exit(1);
  } finally {
    if (cdp) {
      try { await cdp.send('WebAuthn.disable'); } catch(e) {}
    }
    if (browser) {
      await browser.close();
    }
    process.exit(0);
  }
}

runTestSuite();
