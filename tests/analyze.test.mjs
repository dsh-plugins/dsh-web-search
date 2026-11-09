import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeOf, parseJsonObject } from '../lib/analyze.js';

test('解析纯 JSON 文本', () => {
  assert.deepEqual(parseJsonObject('{"status":"ok","results":[]}'), { status: 'ok', results: [] });
});

test('容忍 Markdown 围栏与首尾说明文字', () => {
  assert.deepEqual(parseJsonObject('好的：\n```json\n{"status":"ok"}\n```\n以上。'), { status: 'ok' });
  assert.deepEqual(parseJsonObject('前言 {"status":"ok"} 后记'), { status: 'ok' });
});

test('无 JSON 对象时报错', () => {
  assert.throws(() => parseJsonObject('没有对象'), /找不到 JSON 对象/);
  assert.throws(() => parseJsonObject('{invalid}'), /无法解析/);
  assert.throws(() => parseJsonObject('[1,2]'), /找不到 JSON 对象/);
});

test('outcomeOf 识别 ok 与 interact', () => {
  assert.deepEqual(outcomeOf({ status: 'ok', results: [] }), { status: 'ok', value: { status: 'ok', results: [] } });
  assert.deepEqual(outcomeOf({ status: 'interact', task: ' 点击同意按钮 ' }), { status: 'interact', task: '点击同意按钮' });
});

test('outcomeOf 拒绝未知形态', () => {
  assert.throws(() => outcomeOf({ status: 'interact' }), /status/);
  assert.throws(() => outcomeOf({ status: 'weird' }), /status/);
});
