import {test} from 'node:test';
import assert from 'node:assert/strict';
import {finishOwnedCase} from './matrix.mjs';
test('a successful request cannot pass when owned core cleanup failed',async()=>{
  let stopped=0;
  const owners=[{stop:async()=>{stopped++;},done:Promise.resolve({issue:'cleanup_failed'})},
    {stop:async()=>{stopped++;},done:Promise.resolve({issue:'cancelled'})}];
  assert.deepEqual(await finishOwnedCase({exitCode:0,issue:null},owners),{exitCode:null,issue:'cleanup_failed'});
  assert.equal(stopped,2);
});
test('failed stop still attempts every owner and fails closed',async()=>{
  let second=false;
  const owners=[{stop:async()=>{throw Error('fixture');},done:Promise.resolve({issue:null})},
    {stop:async()=>{second=true;},done:Promise.resolve({issue:'cancelled'})}];
  assert.equal((await finishOwnedCase({exitCode:0,issue:null},owners)).issue,'cleanup_failed');
  assert.equal(second,true);
});
