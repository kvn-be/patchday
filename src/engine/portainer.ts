import https from 'node:https';
import http from 'node:http';

export interface PortainerStack {
  id: number;
  name: string;
  endpointId: number;
  env: unknown[];
  gitManaged: boolean;
}

export interface PortainerClient {
  stacks(): Promise<PortainerStack[]>;
  file(id: number): Promise<string>;
  update(stack: PortainerStack, content: string): Promise<void>;
}

function isLocal(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function createPortainerClient(baseUrl: string, token: string): PortainerClient {
  const call = (method: string, path: string, body?: unknown, attempt = 1): Promise<any> =>
    new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const client = url.protocol === 'https:' ? https : http;
      const request = client.request(
        url,
        {
          method,
          timeout: 120_000,
          // Portainer ships a self-signed certificate. That is only accepted on this machine.
          rejectUnauthorized: !isLocal(url),
          headers: { 'X-API-Key': token, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { text += chunk; });
          response.on('end', () => {
            if ((response.statusCode ?? 500) >= 400) reject(new Error(`Portainer answered ${response.statusCode}`));
            else resolve(text ? JSON.parse(text) : null);
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('Portainer did not answer in time')));
      request.on('error', (error) => {
        // Only reads repeat: a write may already have reached Portainer.
        if (method === 'GET' && attempt < 3) setTimeout(() => call(method, path, body, attempt + 1).then(resolve, reject), 30_000);
        else reject(error);
      });
      request.end(payload);
    });

  return {
    async stacks() {
      const stacks = await call('GET', '/api/stacks');
      return stacks.map((stack: any) => ({
        id: stack.Id,
        name: stack.Name,
        endpointId: stack.EndpointId,
        env: stack.Env ?? [],
        gitManaged: Boolean(stack.GitConfig),
      }));
    },
    async file(id) {
      return (await call('GET', `/api/stacks/${id}/file`)).StackFileContent;
    },
    async update(stack, content) {
      await call('PUT', `/api/stacks/${stack.id}?endpointId=${stack.endpointId}`, {
        stackFileContent: content,
        env: stack.env,
        pullImage: true,
        prune: false,
      });
    },
  };
}
