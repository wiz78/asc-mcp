import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createExpandedOperations} from './asc-expanded.mjs';

test('inline leaderboard version IDs use Apple local-id syntax on both edges',async()=>{
  const call=createExpandedOperations({cue:'123'},async(path,options)=>{
    if(options?.method==='POST'){
      const payload=options.body;
      const id=payload.included[0].id;
      assert.match(id,/^\$\{[A-Za-z0-9_-]+\}$/);
      assert.equal(payload.data.relationships.versions.data[0].id,id);
      return {data:{...payload.data,id:'created-board'}};
    }
    return {data:{type:'gameCenterDetails',id:'detail',attributes:{},relationships:{
      app:{data:{type:'apps',id:'123'}},gameCenterGroup:{data:null}
    }}};
  });
  await call('cue','create_gc_leaderboard',{attributes:{defaultFormatter:'INTEGER',
    referenceName:'Eight-ball Career',vendorIdentifier:'test.example.leaderboard.eightBall.career.v1',
    submissionType:'BEST_SCORE',scoreSortType:'DESC'}});
});
