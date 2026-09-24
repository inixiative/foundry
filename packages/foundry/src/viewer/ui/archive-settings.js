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
      setConnections((await request('connections')).connections);
      setError('');
    } catch (error) {
      setError(error.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const discover = async () => {
    setBusy(true);
    try {
      setKingdom(await request('kingdom'));
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
        kastleId: connection.kastleId,
        connectionId: connection.connectionId ?? null,
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
              kastleId: kingdom.kastleId,
              ...(connectionId ? { connectionId } : {}),
              credential: { type: 'kingdom-runtime' },
            }
          : { kind: 'archive', url, ...(mode === 'managed' ? { secret } : { tokenEnv }) };
      await request('connect', { ...destination, projectId, keepIds: [] });
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
      ) => html`<div key=${connection.projectId + ':' + connection.url + ':' + (connection.connectionId || '')}>
      <strong>${connection.projectId}</strong> — ${connection.status}
      <p>${connection.url}${connection.connectionId ? ` · ${connection.connectionId}` : ''}</p>
      <p>${connection.credential?.type === 'kingdom-runtime' ? 'Foundry Kingdom identity' : connection.credential?.type === 'managed' ? 'Foundry managed credential' : 'Environment credential'}</p>
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
        if (event.target.value === 'kingdom') discover();
      }}>
        <option value="managed">Foundry managed credential</option>
        <option value="kingdom">Connected Kingdom identity</option>
        <option value="environment">Environment variable</option>
      </select></label>
      ${
        mode === 'kingdom'
          ? html`
        <p>${kingdom ? kingdom.url : 'Connect Foundry in Settings → Kingdom to use your enrolled identity.'}</p>
        <button type="button" disabled=${busy} onClick=${discover}>Refresh Kingdom archives</button>
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
