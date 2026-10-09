import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import './AuthDialog.css'

export type AuthMode = 'login' | 'signup'

type Props = {
  mode: AuthMode
  busy: boolean
  error: string
  onClose: () => void
  onModeChange: (mode: AuthMode) => void
  onSubmit: (email: string, password: string) => void
}

export default function AuthDialog({ mode, busy, error, onClose, onModeChange, onSubmit }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(email.trim(), password)
  }

  return (
    <div className="auth-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <header className="auth-dialog-header">
          <div><span className="auth-kicker">LOOPPILOT / LOCAL WORKSPACE</span><h2 id="auth-title">{mode === 'signup' ? 'Create your account.' : 'Welcome back.'}</h2></div>
          <button type="button" className="auth-close" onClick={onClose} aria-label="Close sign in dialog"><X size={17} /></button>
        </header>
        <div className="auth-switch" role="group" aria-label="Account action">
          <button type="button" className={mode === 'login' ? 'selected' : ''} onClick={() => onModeChange('login')}>Sign in</button>
          <button type="button" className={mode === 'signup' ? 'selected' : ''} onClick={() => onModeChange('signup')}>Create account</button>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" type="email" name="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" type="password" name="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
          <p className="auth-hint">{mode === 'signup' ? 'Use at least 12 characters. Email confirmation is not enabled in this local demo.' : 'First time here? Choose Create account above. Sign in uses the email and password registered for LoopPilot.'}</p>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'} <span aria-hidden="true">→</span></button>
        </form>
      </section>
    </div>
  )
}