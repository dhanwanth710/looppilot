import { useState } from 'react'
import { Activity, RefreshCw, ShieldCheck } from 'lucide-react'
import './WorkflowPages.css'
import type { AuthMode } from './AuthDialog'

export type WorkspaceView = 'capture' | 'today' | 'ledger'
export type WorkspaceTask = {
  id: number
  title: string
  deadline: string | null
  owner: string | null
  required_items: string[]
  status: 'To do' | 'Waiting' | 'Blocked' | 'Needs approval' | 'Verified' | 'Unresolved'
  source_name: string
  source_type: string
  created_at: string
}
export type WorkspaceEvent = {
  id: number
  task_id: number | null
  event_type: string
  message: string
  details: Record<string, unknown>
  created_at: string
}

type Props = {
  view: Exclude<WorkspaceView, 'capture'>
  tasks: WorkspaceTask[]
  events: WorkspaceEvent[]
  loading: boolean
  error: string
  onRefresh: () => void
}

const statuses: WorkspaceTask['status'][] = ['To do', 'Waiting', 'Blocked', 'Needs approval', 'Verified', 'Unresolved']

function timestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default function WorkflowPages({ view, tasks, events, loading, error, onRefresh }: Props) {
  const [query, setQuery] = useState('')
  const title = view === 'today' ? 'Today, in view.' : 'A record of what happened.'

  return (
    <main className="workspace workspace-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-rule" /> WORKSPACE / {view === 'today' ? '02' : '03'}</div>
          <h1>{view === 'today' ? <>A clear next<br /><em>step.</em></> : <>The proof<br /><em>stays.</em></>}</h1>
          <p className="page-intro">{view === 'today' ? 'Confirmed requests, grouped by their current state.' : 'A persistent record of confirmed captures and their source.'}</p>
        </div>
        <button type="button" className="view-refresh" onClick={onRefresh} disabled={loading} aria-label="Refresh workspace data" title="Refresh">
          <RefreshCw size={15} className={loading ? 'is-spinning' : ''} /> Refresh
        </button>
      </div>

      {error && <div className="view-alert" role="alert"><Activity size={16} /> <span>{error}</span></div>}

      {view === 'today' ? (
        <section className="status-board" aria-label="Tasks by status" aria-busy={loading}>
          {statuses.map((status) => {
            const laneTasks = tasks.filter((task) => task.status === status)
            return (
              <section className={`status-lane status-${status.toLowerCase().replaceAll(' ', '-')}`} key={status} aria-labelledby={`lane-${status}`}>
                <header><h2 id={`lane-${status}`}>{status}</h2><span>{String(laneTasks.length).padStart(2, '0')}</span></header>
                {laneTasks.length ? laneTasks.map((task) => (
                  <article className="task-ticket" key={task.id}>
                    <span className="ticket-id">LP-{String(task.id).padStart(4, '0')}</span>
                    <h3>{task.title}</h3>
                    {task.deadline && <p><span>Deadline</span>{task.deadline}</p>}
                    {task.required_items.length > 0 && <p><span>Include</span>{task.required_items.join(', ')}</p>}
                    <small>{task.source_name}</small>
                  </article>
                )) : <p className="lane-empty">Nothing here</p>}
              </section>
            )
          })}
        </section>
      ) : (
        <section className="ledger-panel" aria-label="Audit ledger" aria-busy={loading}>
          <div className="ledger-toolbar">
            <label htmlFor="ledger-filter">Filter events</label>
            <input id="ledger-filter" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search event or source" />
            <span>{events.filter((event) => `${event.event_type} ${event.message} ${JSON.stringify(event.details)}`.toLowerCase().includes(query.toLowerCase())).length} events</span>
          </div>
          {events.filter((event) => `${event.event_type} ${event.message} ${JSON.stringify(event.details)}`.toLowerCase().includes(query.toLowerCase())).length ? (
            <ol className="event-list">
              {events.filter((event) => `${event.event_type} ${event.message} ${JSON.stringify(event.details)}`.toLowerCase().includes(query.toLowerCase())).map((event) => (
                <li key={event.id}>
                  <span className="event-marker" aria-hidden="true" />
                  <div className="event-copy">
                    <div className="event-meta"><span>{event.event_type.replaceAll('.', ' · ')}</span><time dateTime={event.created_at}>{timestamp(event.created_at)}</time></div>
                    <p>{event.message}</p>
                    {event.task_id !== null && <small>Task LP-{String(event.task_id).padStart(4, '0')}</small>}
                    {Object.keys(event.details).length > 0 && <small>{Object.entries(event.details).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value)}`).join(' · ')}</small>}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="ledger-empty"><ShieldCheck size={23} /><h2>{loading ? 'Loading the ledger' : query ? 'No matching events' : 'No events recorded yet'}</h2><p>{loading ? 'Checking the local API.' : query ? 'Try a different search.' : 'Confirm a captured request to create the first append-only entry.'}</p></div>
          )}
        </section>
      )}

      <div className="view-footnote"><ShieldCheck size={15} /><span>{title} Data is served by the local LoopPilot API. No external actions are available in this phase.</span></div>
    </main>
  )
}

export function ProfilePanel({
  apiStatus,
  account,
  model,
  modelConnection,
  onRefresh,
  onClose,
  onOpenAuth,
  onSignOut,
  onCheckModel,
}: {
  apiStatus: 'checking' | 'connected' | 'unavailable'
  account: { id: number; email: string } | null
  model: { model: string; key_configured: boolean; ready: boolean }
  modelConnection: { state: 'idle' | 'checking' | 'connected' | 'error'; message: string }
  onRefresh: () => void
  onClose: () => void
  onOpenAuth: (mode: AuthMode) => void
  onSignOut: () => void
  onCheckModel: () => void
}) {
  return (
    <section className="profile-panel" aria-label="Local workspace account">
      <header><div><span className="profile-kicker">WORKSPACE</span><strong>{account ? 'Signed in' : 'Account access'}</strong></div><button type="button" onClick={onClose} aria-label="Close account panel">×</button></header>
      {account ? (
        <>
          <p className="account-email">{account.email}</p>
          <button type="button" className="connection-refresh" onClick={onSignOut}>Sign out</button>
        </>
      ) : (
        <>
          <p>Email and password are stored locally with a hashed password. Email ownership is not verified in this demo.</p>
          <div className="account-actions"><button type="button" onClick={() => onOpenAuth('login')}>Sign in</button><button type="button" onClick={() => onOpenAuth('signup')}>Create account</button></div>
        </>
      )}
      <div className="connection-row"><span>API and storage</span><span className={`connection-status ${apiStatus}`}>{apiStatus === 'checking' ? 'Checking' : apiStatus === 'connected' ? 'Connected' : 'Unavailable'}</span></div>
      <button type="button" className="connection-refresh" onClick={onRefresh} disabled={apiStatus === 'checking'}><RefreshCw size={14} /> Check connection</button>
      <div className="model-status-block">
        <div className="connection-row"><span>Gemma API key</span><span className={`connection-status ${model.key_configured ? 'connected' : 'unavailable'}`}>{model.key_configured ? 'Configured' : 'Not set'}</span></div>
        <small>{model.model}</small>
        <button type="button" className="connection-refresh" onClick={onCheckModel} disabled={!account || !model.ready || modelConnection.state === 'checking'}>
          <Activity size={14} /> {modelConnection.state === 'checking' ? 'Checking Gemma…' : 'Test Gemma connection'}
        </button>
        {modelConnection.message && <p className={`model-message ${modelConnection.state}`} role="status">{modelConnection.message}</p>}
      </div>
    </section>
  )
}