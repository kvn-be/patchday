import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createPortainerClient } from './portainer.ts';

interface Seen { method: string; url: string; key: string | undefined; body: string }

async function fakePortainer(handler: (seen: Seen, response: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', key: request.headers['x-api-key'] as string | undefined, body };
      seen.push(entry);
      handler(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

const json = (response: http.ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
};

test('stacks are mapped from the Portainer API and the token is sent', async (t) => {
  const server = await fakePortainer((_, response) =>
    json(response, 200, [
      { Id: 3, Name: 'paperless', EndpointId: 2, Env: [{ name: 'TZ', value: 'Europe/Berlin' }], GitConfig: null },
      { Id: 7, Name: 'immich', EndpointId: 2, GitConfig: { URL: 'https://example.com/repo.git' } },
    ]),
  );
  t.after(server.close);
  const stacks = await createPortainerClient(server.url, 'ptr_token').stacks();
  assert.deepEqual(stacks, [
    { id: 3, name: 'paperless', endpointId: 2, env: [{ name: 'TZ', value: 'Europe/Berlin' }], gitManaged: false },
    { id: 7, name: 'immich', endpointId: 2, env: [], gitManaged: true },
  ]);
  assert.equal(server.seen[0].method, 'GET');
  assert.equal(server.seen[0].url, '/api/stacks');
  assert.equal(server.seen[0].key, 'ptr_token');
});

test('file returns the stack file content', async (t) => {
  const server = await fakePortainer((_, response) => json(response, 200, { StackFileContent: 'services:\n  web:\n    image: nginx:1.27.1\n' }));
  t.after(server.close);
  assert.equal(await createPortainerClient(server.url, 'x').file(3), 'services:\n  web:\n    image: nginx:1.27.1\n');
  assert.equal(server.seen[0].url, '/api/stacks/3/file');
});

test('update sends the new file, keeps env and never prunes', async (t) => {
  const server = await fakePortainer((_, response) => json(response, 200, { Id: 3 }));
  t.after(server.close);
  const env = [{ name: 'TZ', value: 'Europe/Berlin' }];
  await createPortainerClient(server.url, 'x').update({ id: 3, name: 'paperless', endpointId: 2, env, gitManaged: false }, 'new file');
  assert.equal(server.seen[0].method, 'PUT');
  assert.equal(server.seen[0].url, '/api/stacks/3?endpointId=2');
  assert.deepEqual(JSON.parse(server.seen[0].body), { stackFileContent: 'new file', env, pullImage: true, prune: false });
});

test('an error status names the status code', async (t) => {
  const server = await fakePortainer((_, response) => json(response, 401, { message: 'Unauthorized' }));
  t.after(server.close);
  await assert.rejects(createPortainerClient(server.url, 'wrong').stacks(), /Portainer answered 401/);
});

test('a write that loses its connection is not repeated', async (t) => {
  const server = await fakePortainer((_, response) => response.socket?.destroy());
  t.after(server.close);
  await assert.rejects(createPortainerClient(server.url, 'x').update({ id: 3, name: 'a', endpointId: 2, env: [], gitManaged: false }, 'file'));
  assert.equal(server.seen.length, 1);
});
