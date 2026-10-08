import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRegExp, matchPatterns, render, padTimes, validate } from '../src/compiler.mjs';

test('patterns: JavaScript, Python and template dialects all match', () => {
  assert.deepEqual(matchPatterns(['set an alarm (?:for|at) (?<hour>\\d{1,2}):(?<minute>\\d{2})'], 'Set an alarm for 7:14'), { hour: '7', minute: '14' });
  assert.deepEqual(matchPatterns(['(?i)wake me up at (?P<hour>\\d{1,2}):(?P<minute>\\d{2})'], 'Wake me up at 5:45'), { hour: '5', minute: '45' });
  assert.deepEqual(matchPatterns(['Find {{query}} in Google Maps'], 'Find ramen in Google Maps'), { query: 'ramen' });
  assert.deepEqual(matchPatterns(['search {query} on maps'], 'Search sushi bars on Maps.'), { query: 'sushi bars' });
  assert.equal(matchPatterns(['Find {{query}} in Google Maps'], 'Delete the 7:14 alarm'), null);
});

test('templates escape regex characters in the literal parts', () => {
  assert.ok(toRegExp('Price (USD) of {{item}}?').test('price (usd) of milk?'));
});

test('render applies filters', () => {
  assert.equal(render('{{hour|pad2}}:{{minute}}', { hour: '7', minute: '14' }), '07:14');
  assert.equal(render('{{q|upper}}', { q: 'pizza' }), 'PIZZA');
});

test('padTimes makes 7:14 and 07:14 the same', () => {
  assert.equal(padTimes('Delete the 7:14 alarm'), 'Delete the 07:14 alarm');
  assert.equal(padTimes('17:14'), '17:14');
});

const alarmTrace = [
  { op: 'launch', pkg: 'com.sec.android.app.clockpackage' },
  { op: 'tap', sel: { resourceId: 'x:id/menu_alarm_add', labelHas: 'Add alarm' }, label: 'Add alarm' },
  { op: 'tap', sel: { resourceId: '', labelHas: '07' }, label: '07' },
  { op: 'type', sel: { resourceId: 'x:id/numberpicker_input', labelHas: 'Hour' }, text: '07' },
  { op: 'type', sel: { resourceId: 'x:id/numberpicker_input', labelHas: 'Minute' }, text: '14' },
];
const shape = spec => ({ drop: new Set(), targets: {}, ...spec });

test('validate fixes a forgotten zero pad instead of failing', () => {
  const spec = shape({
    name: 'clock.set_alarm', params: [{ name: 'hour' }, { name: 'minute' }],
    patterns: ['set an alarm for {{hour}}:{{minute}}'], typed: { 3: '{{hour}}', 4: '{{minute}}' },
    drop: new Set([2]), test: { hour: '6', minute: '30' },
  });
  assert.deepEqual(validate(spec, 'Set an alarm for 7:14', alarmTrace, '07:14'), []);
  assert.equal(spec.typed[3], '{{hour|pad2}}');
});

test('validate flags a tap that depends on the input', () => {
  const spec = shape({
    name: 'clock.set_alarm', params: [{ name: 'hour' }, { name: 'minute' }],
    patterns: ['set an alarm for {{hour}}:{{minute}}'], typed: { 3: '{{hour|pad2}}', 4: '{{minute}}' },
    test: { hour: '6', minute: '30' },
  });
  const problems = validate(spec, 'Set an alarm for 7:14', alarmTrace, '07:14');
  assert.ok(problems.some(p => p.includes('depends on the input')));
});

test('a param the request never gave can come from its default', () => {
  const trace = [{ op: 'launch', pkg: 'com.whatsapp' }, { op: 'type', sel: { resourceId: 'w:id/entry' }, text: 'Hi!' }];
  const spec = shape({
    name: 'whatsapp.send_message', params: [{ name: 'contact' }, { name: 'message', default: 'Hi!' }],
    patterns: ['send a greeting to {{contact}} on whatsapp'], typed: { 1: '{{message}}' }, test: { contact: 'Petr', message: 'Hey' },
  });
  assert.deepEqual(validate(spec, 'Send a greeting to Petr Kyncl on WhatsApp', trace, ''), []);
});
