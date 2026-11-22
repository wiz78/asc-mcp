import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateUploadOperations} from './asc-uploads.mjs';
const operation = {method:'PUT',url:'https://northamerica-1.object-storage.apple.com/image?signature=private',offset:0,length:24,requestHeaders:[]};
test('accept the exact documented Apple object-storage endpoint', () => {
  assert.doesNotThrow(() => validateUploadOperations([operation],24));
});
test('object-storage support preserves destination, method and credential restrictions', () => {
  for (const url of ['http://northamerica-1.object-storage.apple.com/image','https://northamerica-1.object-storage.apple.com.evil.test/image','https://evil.object-storage.apple.com/image','https://user@northamerica-1.object-storage.apple.com/image','https://northamerica-1.object-storage.apple.com:8443/image','https://northamerica-1.object-storage.apple.com/image#fragment']) {
    assert.throws(() => validateUploadOperations([{...operation,url}],24));
  }
  assert.throws(() => validateUploadOperations([{...operation,method:'POST'}],24));
  assert.throws(() => validateUploadOperations([{...operation,requestHeaders:[{name:'Authorization',value:'secret'}]}],24));
});
