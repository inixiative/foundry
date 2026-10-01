import { html, useState, useEffect } from './lib.js';

export function ArchiveSettings() {
  const [connections, setConnections] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [projectId, setProjectId] = useState('');
  const [mode, setMode] = useState('managed');
  const [secret, setSecret] = useState('');
  const [tokenEnv, setTokenEnv] = useState('ARCHIVE_TOKEN');
  const [kingdom, setKingdom] = useState(null);
  const [paired, setPaired] = useState([]);
  const [kingdomId, setKingdomId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const request = async (path, body) => {
    const response = await fetch(
      `/api/archives/${path}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Archive unavailable');
    return result;
  };
  const load = async () => {
    try {
      const result = await request('connections');
      setConnections(result.connections);
      setError(result.configurationError || '');
    } catch (error) {
      setError(error.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const choose = async () => {
    try {
      const response = await fetch('/api/kingdom/status');
      const runtimes = response.ok ? (await response.json()).runtimes : [];
      setPaired(runtimes);
      const id = runtimes.some((runtime) => runtime.id === kingdomId) ? kingdomId : (runtimes[0]?.id ?? '');
      setKingdomId(id);
      if (id) await discover(id);
      else setKingdom(null);
    } catch (error) {
      setError(error.message);
    }
  };
  const discover = async (id = kingdomId) => {
    setBusy(true);
    try {
      setKingdom(await request(`kingdom?kingdom=${encodeURIComponent(id)}`));
      setConnectionId('');
      setError('');
    } catch (error) {
      setKingdom(null);
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  const retrieve = async (connection) => {
    setEvidence('');
    try {
      const result = await request('context', {
        projectId: connection.projectId,
        url: connection.url,
        connectionId: connection.connectionId ?? null,
        ownerModel: connection.ownerModel ?? null,
        organizationId: connection.organizationId ?? null,
        spaceId: connection.spaceId ?? null,
        owner: connection.credential?.type === 'kingdom-runtime' ? connection.credential.owner : null,
        query,
      });
      setEvidence(result.evidence || 'No matching evidence.');
    } catch (error) {
      setError(error.message);
    }
  };
  const connect = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const destination =
        mode === 'kingdom'
          ? {
              kind: 'kingdom',
              url: kingdom.url,
              ...(connectionId ? { connectionId } : {}),
              credential: { type: 'kingdom-runtime', owner: kingdom.owner },
            }
          : { kind: 'archive', url, ...(mode === 'managed' ? { secret } : { tokenEnv }) };
      await request('connect', { ...destination, projectId });
      setSecret('');
      await load();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<section class="settings-section"><h3>Archive connections</h3>
    <p>Automatically publish captured sessions for the selected project. Existing matching local archives will also sync.</p>
    ${connections.map(
      (
        connection,
      ) => html`<div key=${[connection.projectId, connection.url, connection.connectionId, connection.ownerModel, connection.organizationId, connection.spaceId, connection.credential?.owner].join(':')}>
      <strong>${connection.projectId}</strong> — ${connection.status}
      <p>${connection.url}${connection.connectionId ? ` · ${connection.connectionId}` : ''}</p>
      <p>${connection.credential?.type === 'kingdom-runtime' ? `Foundry Kingdom identity (${connection.credential.owner})` : connection.credential?.type === 'managed' ? 'Foundry managed credential' : 'Environment credential'}</p>
      <button onClick=${() => retrieve(connection)}>Retrieve context</button>
    </div>`,
    )}
    <label>Context search<input value=${query} onInput=${(event) => setQuery(event.target.value)} /></label>
    <button onClick=${load}>Check connections</button>
    ${evidence && html`<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${evidence}</pre>`}
    <form onSubmit=${connect}>
      <label>Project ID<input required value=${projectId} onInput=${(event) => setProjectId(event.target.value)} /></label>
      <label>Connect using<select value=${mode} onChange=${(event) => {
        setMode(event.target.value);
        setSecret('');
        if (event.target.value === 'kingdom') choose();
      }}>
        <option value="managed">Foundry managed credential</option>
        <option value="kingdom">Connected Kingdom identity</option>
        <option value="environment">Environment variable</option>
      </select></label>
      ${
        mode === 'kingdom'
          ? html`
        ${
          paired.length
            ? html`<label>Kingdom<select value=${kingdomId} onChange=${(event) => {
                setKingdomId(event.target.value);
                setConnectionId('');
                discover(event.target.value);
              }}>
              ${paired.map((runtime) => html`<option key=${runtime.id} value=${runtime.id}>${runtime.url} as ${runtime.owner}</option>`)}
            </select></label>`
            : html`<p><a href="/kingdom">Pair with Kingdom first</a> to use your enrolled identity, then refresh.</p>`
        }
        <button type="button" disabled=${busy} onClick=${choose}>Refresh Kingdom archives</button>
        ${
          kingdom &&
          html`<label>Destination<select value=${connectionId} onChange=${(event) => {
            setConnectionId(event.target.value);
            const selected = kingdom.connections.find((connection) => connection.id === event.target.value);
            if (selected?.projectId) setProjectId(selected.projectId);
          }}>
          <option value="">Kingdom-stored archives</option>
          ${kingdom.connections.filter((connection) => connection.projectId).map((connection) => html`<option key=${connection.id} value=${connection.id}>${connection.name}</option>`)}
        </select></label>`
        }
      `
          : html`
        <label>Archive URL<input required type="url" value=${url} onInput=${(event) => setUrl(event.target.value)} /></label>
        ${
          mode === 'managed'
            ? html`
          <label>Archive access token<input required type="password" autocomplete="new-password" value=${secret} onInput=${(event) => setSecret(event.target.value)} /></label>
          <p>Foundry stores this credential privately, scoped to this project and Archive URL. Settings retain only its reference.</p>
        `
            : html`<label>Credential environment variable<input required value=${tokenEnv} onInput=${(event) => setTokenEnv(event.target.value)} /></label>`
        }
      `
      }
      <button type="submit" disabled=${busy || (mode === 'kingdom' && !kingdom)}>${busy ? 'Connecting…' : 'Connect Archive'}</button>
    </form>
    ${error && html`<p role="alert">${error}</p>`}
  </section>`;
}
