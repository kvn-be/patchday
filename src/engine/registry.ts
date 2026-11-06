export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<any> }>;

export interface RegistryRef {
  host: string;
  path: string;
}

export function registryRef(repository: string): RegistryRef {
  const [first, ...rest] = repository.split('/');
  const hasHost = rest.length > 0 && (first.includes('.') || first.includes(':'));
  const host = hasHost ? first : 'docker.io';
  const path = hasHost ? rest.join('/') : repository;
  if (host === 'docker.io' && !path.includes('/')) return { host, path: `library/${path}` };
  return { host, path };
}

async function dockerHubTags(path: string, fetcher: FetchLike): Promise<string[]> {
  const response = await fetcher(`https://hub.docker.com/v2/repositories/${path}/tags?page_size=100&ordering=last_updated`);
  if (!response.ok) throw new Error(`Docker Hub answered ${response.status}`);
  const body = await response.json();
  return body.results.map((result: { name: string }) => result.name);
}

function parseChallenge(header: string): { realm: string; service?: string } | null {
  const realm = /realm="([^"]+)"/.exec(header)?.[1];
  if (!realm) return null;
  return { realm, service: /service="([^"]+)"/.exec(header)?.[1] };
}

async function registryTags({ host, path }: RegistryRef, fetcher: FetchLike): Promise<string[]> {
  const url = `https://${host}/v2/${path}/tags/list?n=1000`;
  let response = await fetcher(url);
  if (response.status === 401) {
    const challenge = parseChallenge(response.headers.get('www-authenticate') ?? '');
    if (!challenge) throw new Error(`${host} needs a login`);
    const query = new URLSearchParams({ scope: `repository:${path}:pull` });
    if (challenge.service) query.set('service', challenge.service);
    const token = await (await fetcher(`${challenge.realm}?${query}`)).json();
    response = await fetcher(url, { headers: { Authorization: `Bearer ${token.token ?? token.access_token}` } });
  }
  if (!response.ok) throw new Error(`${host} answered ${response.status}`);
  return (await response.json()).tags ?? [];
}

export function createTagLookup(fetcher: FetchLike = fetch as unknown as FetchLike) {
  return (repository: string): Promise<string[]> => {
    const ref = registryRef(repository);
    return ref.host === 'docker.io' ? dockerHubTags(ref.path, fetcher) : registryTags(ref, fetcher);
  };
}
