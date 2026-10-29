// Pure-logic checks (no database, no network):  node test/unit.js
process.env.BRIDGE_ENV_FILE = '/nonexistent';
const assert = require('assert');
const { classify } = require('../src/mapping');
const { gaps } = require('../src/util');
const cameras = require('../src/cameraMap');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  -', name); };

t('panic button -> P9 panic_button', () => assert.deepStrictEqual(classify({ event_type: 'PANIC_BUTTON', severity: 'INFO' }), { forward: true, alert_type: 'panic_button', priority: 9 }));
t('AI event subtype is matched (smoke)', () => assert.strictEqual(classify({ event_type: 'AI_DETECTION', event_subtype: 'SMOKE_DETECTED', severity: 'WARNING' }).alert_type, 'smoke'));
t('system events are not forwarded', () => assert.strictEqual(classify({ event_type: 'RECORDING_FAILURE', severity: 'CRITICAL' }).forward, false));
t('unknown INFO event is not forwarded, WARNING is (P3)', () => { assert.strictEqual(classify({ event_type: 'FOO', severity: 'INFO' }).forward, false); const c = classify({ event_type: 'FOO', severity: 'WARNING' }); assert.ok(c.forward && c.priority === 3 && c.alert_type === 'foo'); });
t("event_data can set its own priority / type / opt-out", () => {
  const c = classify({ event_type: 'AI_DETECTION', severity: 'WARNING', event_data: '{"priority": 10, "alert_type": "Fire Detected"}' });
  assert.strictEqual(c.priority, 10); assert.strictEqual(c.alert_type, 'fire_detected');
  assert.strictEqual(classify({ event_type: 'PANIC_BUTTON', event_data: { cms_forward: false } }).forward, false);
});
t('priority is clamped to 1-10', () => assert.strictEqual(classify({ event_type: 'X', severity: 'WARNING', event_data: { priority: 99 } }).priority, 10));
t('M-NVR analytics: passenger fallen / leaning out / track obstacle are P9', () => {
  assert.deepStrictEqual(classify({ event_type: 'PASSENGER_FALLEN', event_subtype: 'fall_lean', severity: 'CRITICAL', title: 'Passenger fallen' }), { forward: true, alert_type: 'passenger_fallen', priority: 9 });
  assert.strictEqual(classify({ event_type: 'PASSENGER_LEANING_OUT', event_subtype: 'fall_lean', severity: 'CRITICAL', title: 'x' }).priority, 9);
  assert.deepStrictEqual(classify({ event_type: 'TRACK_OBSTACLE', event_subtype: 'rail_obstacle', severity: 'CRITICAL', title: 'x' }), { forward: true, alert_type: 'track_obstacle', priority: 9 });
});
t('M-NVR analytics: smoke -> smoke P8, crowd -> P4', () => {
  assert.deepStrictEqual(classify({ event_type: 'SMOKE_DETECTED', event_subtype: 'smoke', severity: 'CRITICAL', title: 'x' }), { forward: true, alert_type: 'smoke', priority: 8 });
  assert.strictEqual(classify({ event_type: 'CROWD_DENSITY', event_subtype: 'crowd', severity: 'WARNING', title: 'x' }).priority, 4);
});
t('M-NVR analytics: SHADOW-mode and AI_TEST events are never forwarded', () => {
  assert.strictEqual(classify({ event_type: 'PASSENGER_FALLEN', severity: 'INFO', title: '[SHADOW] Passenger fallen' }).forward, false);
  assert.strictEqual(classify({ event_type: 'AI_TEST', event_subtype: 'fake', severity: 'INFO', title: 'test' }).forward, false);
});
t('gaps(): covered window has none', () => assert.deepStrictEqual(gaps([[0, 10000], [10000, 20000]], 2000, 18000), []));
t('gaps(): missing head and middle are reported', () => assert.deepStrictEqual(gaps([[5000, 8000], [12000, 20000]], 0, 20000), [[0, 5000], [8000, 12000]]));
t('gaps(): 1 s hiccup between segments is tolerated', () => assert.deepStrictEqual(gaps([[0, 10000], [11000, 20000]], 0, 20000), []));
t('cameras: match by name, CAMERA_MAP aside', () => {
  cameras.build([{ id: 10, name: 'Cam-1' }, { id: 11, name: 'cam 2' }, { id: 99, name: 'other' }], [{ camera_id: 4, camera_name: 'cam_1' }, { camera_id: 5, camera_name: 'CAM-2' }, { camera_id: 6, camera_name: 'lonely' }]);
  assert.strictEqual(cameras.toCms(4), 10); assert.strictEqual(cameras.toCms(5), 11); assert.strictEqual(cameras.toCms(6), null); assert.strictEqual(cameras.toMnvr(11), 5);
});
console.log(`${n} checks passed`);
