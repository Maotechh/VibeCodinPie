/**
 * Mobile Control Feature Tests
 * Tests: force clamping, disconnect cleanup, stop_control all, slider_value_update, force_info
 *
 * Usage: Start the server first, then run: node test/mobile_control_test.js
 */

import { WebSocket } from 'ws';
import assert from 'assert';

const PORT = process.env.PORT || 3000;
const WS_URL = `ws://localhost:${PORT}/ws`;
const TIMEOUT_MS = 3000;

let testsPassed = 0;
let testsFailed = 0;

function log(msg, type = 'INFO') {
  const time = new Date().toISOString().split('T')[1].slice(0, -1);
  console.log(`[${time}] [${type}] ${msg}`);
}

function pass(msg) {
  log(msg, 'PASS');
  testsPassed++;
}

function fail(msg) {
  log(msg, 'FAIL');
  testsFailed++;
}

function connect(type, extra = '') {
  return new Promise((resolve, reject) => {
    const url = `${WS_URL}?type=${type}${extra}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`Connect timeout: ${url}`)), TIMEOUT_MS);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function waitForMessage(ws, typeName, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${typeName}`)), timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data);
      if (msg.type === typeName) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

function collectMessages(ws, typeName, durationMs) {
  return new Promise((resolve) => {
    const msgs = [];
    const handler = (data) => {
      const msg = JSON.parse(data);
      if (msg.type === typeName) msgs.push(msg);
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(msgs);
    }, durationMs);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const TEST_SLIDERS = [
  { id: 'test:0:100', name: 'TestSlider', value: 50, min: 0, max: 100 }
];

async function connectMaster() {
  const ws = await connect('screen', '&key=geekpie');
  await waitForMessage(ws, 'init');
  ws.send(JSON.stringify({ type: 'register_sliders', sliders: TEST_SLIDERS }));
  await sleep(200);
  return ws;
}

async function ensureMaster(current) {
  if (current && current.readyState === WebSocket.OPEN) return current;
  log('Reconnecting master...');
  return await connectMaster();
}

async function runTests() {
  log('Starting Mobile Control Tests...');

  let master = null;
  let mobile1 = null;
  let mobile2 = null;
  let mobile3 = null;

  try {
    // ── Setup: Connect master and register sliders ──
    master = await connectMaster();
    log('Master connected');

    // ══════════════════════════════════════════════
    // Test 1: Mobile connects and receives init with sliders
    // ══════════════════════════════════════════════
    log('Test 1: Mobile init with sliders');
    mobile1 = await connect('mobile', '&session=test-session-1');
    const initMsg = await waitForMessage(mobile1, 'init');
    assert.ok(initMsg.sliders, 'init should contain sliders');
    assert.strictEqual(initMsg.sliders.length, 1);
    assert.strictEqual(initMsg.sliders[0].id, 'test:0:100');
    pass('Mobile receives init with sliders');

    // ══════════════════════════════════════════════
    // Test 2: control_slider sends apply_force to master
    // ══════════════════════════════════════════════
    log('Test 2: control_slider -> apply_force');
    master = await ensureMaster(master);
    const forcePromise = waitForMessage(master, 'apply_force');
    mobile1.send(JSON.stringify({
      type: 'control_slider',
      id: 'test:0:100',
      force: 0.5
    }));
    const forceMsg = await forcePromise;
    assert.strictEqual(forceMsg.id, 'test:0:100');
    assert.ok(Math.abs(forceMsg.force - 0.5) < 0.01, `Expected ~0.5, got ${forceMsg.force}`);
    pass('control_slider produces apply_force on master');

    // Clear force
    mobile1.send(JSON.stringify({ type: 'stop_control', id: 'test:0:100' }));
    await sleep(200);

    // ══════════════════════════════════════════════
    // Test 3: Opposing forces cancel out
    // ══════════════════════════════════════════════
    log('Test 3: Opposing forces cancel out');
    mobile2 = await connect('mobile', '&session=test-session-2');
    await waitForMessage(mobile2, 'init');

    mobile1.send(JSON.stringify({ type: 'control_slider', id: 'test:0:100', force: 0.8 }));
    mobile2.send(JSON.stringify({ type: 'control_slider', id: 'test:0:100', force: -0.8 }));

    master = await ensureMaster(master);
    const cancelMsgs = await collectMessages(master, 'apply_force', 350);
    const allNearZero = cancelMsgs.every(m => Math.abs(m.force) < 0.05);
    assert.ok(cancelMsgs.length === 0 || allNearZero,
      `Opposing forces should cancel: got ${cancelMsgs.map(m => m.force)}`);
    pass('Opposing forces cancel each other out');

    mobile1.send(JSON.stringify({ type: 'stop_control', id: 'test:0:100' }));
    mobile2.send(JSON.stringify({ type: 'stop_control', id: 'test:0:100' }));
    await sleep(200);

    // ══════════════════════════════════════════════
    // Test 4: Net force is clamped to [-1, 1]
    // ══════════════════════════════════════════════
    log('Test 4: Force clamping');
    mobile3 = await connect('mobile', '&session=test-session-3');
    await waitForMessage(mobile3, 'init');

    mobile1.send(JSON.stringify({ type: 'control_slider', id: 'test:0:100', force: 1.0 }));
    mobile2.send(JSON.stringify({ type: 'control_slider', id: 'test:0:100', force: 1.0 }));
    mobile3.send(JSON.stringify({ type: 'control_slider', id: 'test:0:100', force: 1.0 }));

    master = await ensureMaster(master);
    const clampMsgs = await collectMessages(master, 'apply_force', 350);
    assert.ok(clampMsgs.length > 0, 'Should receive apply_force messages');
    for (const m of clampMsgs) {
      assert.ok(m.force <= 1.0 && m.force >= -1.0,
        `Force should be clamped to [-1,1], got ${m.force}`);
    }
    pass('Net force clamped to [-1, 1]');

    // ══════════════════════════════════════════════
    // Test 5: force_info broadcast to mobile
    // ══════════════════════════════════════════════
    log('Test 5: force_info broadcast');
    const infoMsgs = await collectMessages(mobile1, 'force_info', 350);
    assert.ok(infoMsgs.length > 0, 'Mobile should receive force_info');
    const info = infoMsgs[0];
    assert.ok(info.sliders && info.sliders.length > 0, 'force_info should have sliders');
    const sliderInfo = info.sliders.find(s => s.id === 'test:0:100');
    assert.ok(sliderInfo, 'Should have info for test slider');
    assert.ok(sliderInfo.participants >= 1, `Should have participants, got ${sliderInfo.participants}`);
    assert.ok(sliderInfo.netForce <= 1.0 && sliderInfo.netForce >= -1.0, 'netForce should be clamped');
    pass('force_info broadcast to mobile with participants and clamped netForce');

    mobile1.send(JSON.stringify({ type: 'stop_control', id: 'test:0:100' }));
    mobile2.send(JSON.stringify({ type: 'stop_control', id: 'test:0:100' }));
    mobile3.send(JSON.stringify({ type: 'stop_control', id: 'test:0:100' }));
    await sleep(200);

    // ══════════════════════════════════════════════
    // Test 6: Disconnect cleans up forces
    // ══════════════════════════════════════════════
    log('Test 6: Disconnect cleanup');
    mobile3.send(JSON.stringify({ type: 'control_slider', id: 'test:0:100', force: 0.9 }));
    await sleep(150);
    mobile3.close();
    // Wait long enough for close event + aggregation cycle to pass
    await sleep(500);

    master = await ensureMaster(master);
    const postDisconnect = await collectMessages(master, 'apply_force', 500);
    const allSmall = postDisconnect.every(m => Math.abs(m.force) < 0.05);
    assert.ok(postDisconnect.length === 0 || allSmall,
      `After disconnect, force should be gone: got ${postDisconnect.map(m => m.force)}`);
    pass('Forces cleaned up on disconnect');

    // ══════════════════════════════════════════════
    // Test 7: stop_control with all:true clears all sliders
    // ══════════════════════════════════════════════
    log('Test 7: stop_control all:true');
    mobile1.send(JSON.stringify({ type: 'control_slider', id: 'test:0:100', force: 0.7 }));
    await sleep(150);

    mobile1.send(JSON.stringify({ type: 'stop_control', all: true }));
    await sleep(300);

    master = await ensureMaster(master);
    const postStopAll = await collectMessages(master, 'apply_force', 350);
    const allCleared = postStopAll.every(m => Math.abs(m.force) < 0.05);
    assert.ok(postStopAll.length === 0 || allCleared,
      `After stop_control all, no forces: got ${postStopAll.map(m => m.force)}`);
    pass('stop_control all:true clears all forces');

    // ══════════════════════════════════════════════
    // Test 8: slider_value_update broadcast
    // ══════════════════════════════════════════════
    log('Test 8: slider_value_update broadcast');
    // Always reconnect master fresh for this test to guarantee it's the active master
    if (master && master.readyState === WebSocket.OPEN) master.close();
    await sleep(200);
    master = await connectMaster();
    const valuePromise = waitForMessage(mobile1, 'slider_value_update');
    await sleep(100);
    master.send(JSON.stringify({
      type: 'sync_slider',
      id: 'test:0:100',
      value: 75.5
    }));
    const valueMsg = await valuePromise;
    assert.strictEqual(valueMsg.id, 'test:0:100');
    assert.strictEqual(valueMsg.value, 75.5);
    pass('slider_value_update broadcast to mobile');

    // ── Results ──
    console.log('');
    log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
    if (testsFailed > 0) {
      process.exit(1);
    } else {
      log('All tests passed!');
      process.exit(0);
    }

  } catch (e) {
    fail(`Test error: ${e.message}`);
    console.error(e);
    process.exit(1);
  } finally {
    if (master) master.close();
    if (mobile1) mobile1.close();
    if (mobile2) mobile2.close();
    if (mobile3 && mobile3.readyState !== WebSocket.CLOSED) mobile3.close();
  }
}

runTests();
