import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateUploadOperations} from './asc-uploads.mjs';

test('rejected destination exposes only host and recognized method, never signed URL or headers', () => {
  const operation = {method:'PUT',url:'https://unsupported.example.com/private-path?signature=private-signature',offset:0,length:24,requestHeaders:[{name:'x-apple-token',value:'private-header'}]};
  assert.throws(() => validateUploadOperations([operation],24), error => {
    assert.match(error.message,/unsupported.example.com/);
    assert.match(error.message,/PUT/);
    assert.doesNotMatch(error.message,/private-path|private-signature|private-header/);
    return true;
  });
});
