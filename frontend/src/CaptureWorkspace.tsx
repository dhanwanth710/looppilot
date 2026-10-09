import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  FileText,
  FileUp,
  Image as ImageIcon,
  Mic,
  Moon,
  Paperclip,
  RotateCcw,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react'
import './CaptureWorkspace.css'
import WorkflowPages, { ProfilePanel, type WorkspaceEvent, type WorkspaceTask, type WorkspaceView } from './WorkflowPages'
import AuthDialog, { type AuthMode } from './AuthDialog'

type ExtractedField = {
  label: string
  value: string
  source: string
  uncertain: boolean
}

type PlanStep = {
  title: string
  status: 'To do' | 'Waiting' | 'Blocked' | 'Needs approval' | 'Verified' | 'Unresolved'
  reason: string
}

type SpeechRecognitionInstance = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { results: SpeechRecognitionResultList }) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionInstance
  webkitSpeechRecognition?: new () => SpeechRecognitionInstance
}

const seedMessage = 'Please send the revised project report by Friday. Include the latest budget sheet.'

type Account = { id: number; email: string }
type GemmaStatus = { provider: string; key_configured: boolean; model: string; model_configured: boolean; ready: boolean }

async function fetchWorkspace() {
  const healthResponse = await fetch('/api/health')
  if (!healthResponse.ok) throw new Error('The local API is unavailable.')
  const [accountResponse, modelResponse] = await Promise.all([fetch('/api/auth/me'), fetch('/api/model/status')])
  if ((!accountResponse.ok && accountResponse.status !== 401) || !modelResponse.ok) throw new Error('The local API could not load account or model status.')
  const account = accountResponse.ok ? await accountResponse.json() as Account : null
  const model = await modelResponse.json() as GemmaStatus
  if (!account) return { tasks: [], events: [], account, model }
  const [tasksResponse, eventsResponse] = await Promise.all([fetch('/api/tasks'), fetch('/api/audit')])
  if (!tasksResponse.ok || !eventsResponse.ok) throw new Error('The local API could not load workspace data.')
  return {
    tasks: await tasksResponse.json() as WorkspaceTask[],
    events: await eventsResponse.json() as WorkspaceEvent[],
    account,
    model,
  }
}

function createIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function deriveFields(text: string): ExtractedField[] {
  const cleanText = text.replace(/\s+/g, ' ').trim()
  const taskMatch = cleanText.match(/(?:please\s+)?(?:send|share|submit|forward|deliver)\s+(?:the\s+)?([^.!?]+?)(?=\s+by\s+|[.!?]|$)/i)
  const deadlineMatch = cleanText.match(/\b(?:by|before|on)\s+((?:this\s+|next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+|[a-z]+\s+\d{1,2}(?:,\s*\d{4})?))/i)
  const requiredMatch = cleanText.match(/\b(?:include|attach|with)\s+(?:the\s+)?([^.!?]+)/i)
  const sourceFor = (match: RegExpMatchArray | null) => match?.[0]?.trim() ?? 'No supporting phrase found in this source.'

  return [
    {
      label: 'Requested action',
      value: taskMatch ? `Send ${taskMatch[1].replace(/^(?:the\s+)/i, '').trim()}` : '',
      source: sourceFor(taskMatch),
      uncertain: !taskMatch,
    },
    {
      label: 'Deadline',
      value: deadlineMatch?.[1]?.trim() ?? '',
      source: sourceFor(deadlineMatch),
      uncertain: !deadlineMatch || /^(?:today|tomorrow|this\s|next\s|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(deadlineMatch[1]),
    },
    {
      label: 'Required item',
      value: requiredMatch?.[1]?.trim() ?? '',
      source: sourceFor(requiredMatch),
      uncertain: !requiredMatch,
    },
    {
      label: 'Owner',
      value: '',
      source: 'No owner was explicitly identified.',
      uncertain: true,
    },
  ]
}

export default function CaptureWorkspace() {
  const [message, setMessage] = useState('')
  const [fields, setFields] = useState<ExtractedField[] | null>(null)
  const [interpretation, setInterpretation] = useState('')
  const [plan, setPlan] = useState<PlanStep[]>([])
  const [sourceName, setSourceName] = useState('Pasted message')
  const [sourceType, setSourceType] = useState('MESSAGE')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [recording, setRecording] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [darkMode, setDarkMode] = useState(false)
  const [notice, setNotice] = useState('')
  const [activeView, setActiveView] = useState<WorkspaceView>('capture')
  const [profileOpen, setProfileOpen] = useState(false)
  const [apiStatus, setApiStatus] = useState<'checking' | 'connected' | 'unavailable'>('checking')
  const [apiError, setApiError] = useState('')
  const [account, setAccount] = useState<Account | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [gemmaStatus, setGemmaStatus] = useState<GemmaStatus>({ provider: 'Google AI Studio', key_configured: false, model: 'gemma-4-26b-a4b-it', model_configured: true, ready: false })
  const [modelConnection, setModelConnection] = useState<{ state: 'idle' | 'checking' | 'connected' | 'error'; message: string }>({ state: 'idle', message: '' })
  const [tasks, setTasks] = useState<WorkspaceTask[]>([])
  const [events, setEvents] = useState<WorkspaceEvent[]>([])
  const [workspaceLoading, setWorkspaceLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const idempotencyKey = useRef(createIdempotencyKey())
  const fileInput = useRef<HTMLInputElement>(null)
  const dropArea = useRef<HTMLDivElement>(null)
  const recognition = useRef<SpeechRecognitionInstance | null>(null)

  async function refreshWorkspace() {
    setWorkspaceLoading(true)
    setApiStatus('checking')
    try {
      const workspaceData = await fetchWorkspace()
      setTasks(workspaceData.tasks)
      setEvents(workspaceData.events)
      setAccount(workspaceData.account)
      setGemmaStatus(workspaceData.model)
      setApiStatus('connected')
      setApiError('')
    } catch {
      setApiStatus('unavailable')
      setApiError('Cannot reach the local API. Captures are not saved until the backend is available.')
    } finally {
      setWorkspaceLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void fetchWorkspace()
      .then((workspaceData) => {
        if (!active) return
        setTasks(workspaceData.tasks)
        setEvents(workspaceData.events)
        setAccount(workspaceData.account)
        setGemmaStatus(workspaceData.model)
        setApiStatus('connected')
      })
      .catch(() => {
        if (!active) return
        setApiStatus('unavailable')
        setApiError('Cannot reach the local API. Captures are not saved until the backend is available.')
      })
      .finally(() => { if (active) setWorkspaceLoading(false) })
    return () => { active = false }
  }, [])

  async function submitAuth(email: string, password: string) {
    if (!authMode) return
    setAuthBusy(true)
    setAuthError('')
    try {
      const response = await fetch(`/api/auth/${authMode === 'signup' ? 'signup' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Could not sign in.')
      setAccount(result as Account)
      setAuthMode(null)
      setAuthError('')
      await refreshWorkspace()
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not reach the local API.')
    } finally {
      setAuthBusy(false)
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    setAccount(null)
    setTasks([])
    setEvents([])
    setActiveView('capture')
    setProfileOpen(false)
  }

  async function checkGemma() {
    setModelConnection({ state: 'checking', message: '' })
    try {
      const response = await fetch('/api/model/check', { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'The model check failed.')
      setModelConnection({ state: 'connected', message: `Gemma responded successfully (${result.model}).` })
    } catch (error) {
      setModelConnection({ state: 'error', message: error instanceof Error ? error.message : 'Could not reach Gemma.' })
    }
  }

  const fieldCount = fields?.length ?? 0
  const confirmedCount = fields?.filter((field) => field.value && !field.uncertain).length ?? 0
  const speechSupported = Boolean((window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition)

  function analyze(text = message, name = 'Pasted message', kind = 'MESSAGE') {
    const trimmed = text.trim()
    setMessage(trimmed)
    setSourceName(name)
    setSourceType(kind)
    setAccepted(false)
    idempotencyKey.current = createIdempotencyKey()
    setNotice('')
    setInterpretation('')
    setPlan([])
    setFields(trimmed ? deriveFields(trimmed) : null)
  }

  async function analyzeWithGemma(source = message, name = sourceName, kind = sourceType) {
    const sourceContent = source.trim()
    if (!sourceContent) return
    if (!account) {
      setAuthError('Sign in before using the configured Gemma API.')
      setAuthMode('login')
      return
    }
    setBusy(true)
    setNotice('Asking Gemma to interpret the request and build a safe next-step plan…')
    try {
      const response = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_content: sourceContent }),
      })
      const result = await response.json()
      if (response.status === 401) {
        setAuthError('Sign in before using the configured Gemma API.')
        setAuthMode('login')
        return
      }
      if (!response.ok) throw new Error(result.detail ?? 'Gemma extraction failed.')
      if (!Array.isArray(result.fields) || result.fields.length === 0) throw new Error('Gemma did not return reviewable fields.')
      setFields(result.fields as ExtractedField[])
      setSourceName(name)
      setSourceType(`GEMMA · GOOGLE AI STUDIO · ${kind}`)
      setInterpretation(typeof result.interpretation === 'string' ? result.interpretation : '')
      setPlan(Array.isArray(result.plan) ? result.plan as PlanStep[] : [])
      setAccepted(false)
      idempotencyKey.current = createIdempotencyKey()
      setNotice('Gemma proposed an interpretation and plan. Verify every source quote and unresolved step before saving.')
    } catch (error) {
      setFields(deriveFields(sourceContent))
      setSourceName(name)
      setSourceType(`${kind} · LOCAL FALLBACK`)
      setInterpretation('')
      setPlan([])
      setNotice(error instanceof Error ? error.message : 'Gemma extraction failed. No task or external action was created.')
    } finally {
      setBusy(false)
    }
  }

  function updateField(index: number, value: string) {
    setFields((current) => current?.map((field, fieldIndex) => fieldIndex === index
      ? { ...field, value, uncertain: value.trim().length === 0 }
      : field) ?? null)
    setAccepted(false)
    setInterpretation('')
    setPlan([])
    if (sourceType.startsWith('GEMMA')) setNotice('Details changed. Re-run Gemma to refresh the interpretation and plan before saving.')
  }

  async function analyzeCapturedText(text: string, name: string, kind: string) {
    analyze(text, name, kind)
    if (gemmaStatus.ready && account) {
      await analyzeWithGemma(text, name, kind)
    } else if (gemmaStatus.ready) {
      setNotice('Local draft ready. Sign in to ask the configured Gemma model for its interpretation and plan.')
    }
  }

  async function extractFile(file: File) {
    setBusy(true)
    setNotice('')
    try {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const pdfjs = await import('pdfjs-dist')
        const workerUrl = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default
        const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
        const pageTexts: string[] = []
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          const page = await document.getPage(pageNumber)
          const content = await page.getTextContent()
          pageTexts.push(`[Page ${pageNumber}]\n${content.items.map((item) => ('str' in item ? item.str : '')).join(' ')}`)
        }
        let text = pageTexts.filter(Boolean).join('\n\n')
        let sourceKind = 'PDF'
        if (!text.trim()) {
          setNotice('Scanned PDF detected. Reading page images locally before Gemma…')
          const { createWorker } = await import('tesseract.js')
          const worker = await createWorker('eng')
          const recognizedPages: string[] = []
          try {
            for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
              const page = await document.getPage(pageNumber)
              const viewport = page.getViewport({ scale: 1.8 })
              const canvas = window.document.createElement('canvas')
              canvas.width = Math.ceil(viewport.width)
              canvas.height = Math.ceil(viewport.height)
              const canvasContext = canvas.getContext('2d')
              if (!canvasContext) continue
              await page.render({ canvas, canvasContext, viewport }).promise
              const result = await worker.recognize(canvas)
              recognizedPages.push(`[Page ${pageNumber}]\n${result.data.text.trim()}`)
              canvas.width = 0
              canvas.height = 0
            }
          } finally {
            await worker.terminate()
          }
          text = recognizedPages.filter(Boolean).join('\n\n')
          sourceKind = 'PDF · OCR'
          if (!text.trim()) {
            setNotice('No readable text was found in this PDF. Try a clearer scan or paste the request.')
            return
          }
        }
        await analyzeCapturedText(text, file.name, sourceKind)
      } else if (file.type.startsWith('image/')) {
        setNotice('Reading image text locally. This can take a moment.')
        const { createWorker } = await import('tesseract.js')
        const worker = await createWorker('eng')
        let recognizedText = ''
        try {
          const result = await worker.recognize(file)
          recognizedText = result.data.text.trim()
        } finally {
          await worker.terminate()
        }
        if (!recognizedText) {
          setNotice('No readable text was found. Try a clearer image or paste the message.')
          return
        }
        await analyzeCapturedText(recognizedText, file.name, 'IMAGE · OCR')
      } else {
        const text = await file.text()
        if (!text.trim()) {
          setNotice('This file is empty. Paste a message or choose a text, PDF, or image file.')
          return
        }
        await analyzeCapturedText(text, file.name, 'TEXT FILE')
      }
    } catch {
      setNotice('Could not read this file. Try a text file, a searchable PDF, or a clear image.')
    } finally {
      setBusy(false)
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) void extractFile(file)
    event.target.value = ''
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) void extractFile(file)
  }

  function onPasteKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      analyze()
    }
  }

  function startVoiceCapture() {
    const SpeechRecognition = (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition
    if (!SpeechRecognition) return
    const speech = new SpeechRecognition()
    speech.lang = 'en-IN'
    speech.continuous = false
    speech.interimResults = false
    speech.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? '').join(' ')
      setMessage((current) => [current, transcript].filter(Boolean).join(' '))
    }
    speech.onerror = () => {
      setNotice('Voice capture stopped. You can paste or type the instruction instead.')
      setRecording(false)
    }
    speech.onend = () => setRecording(false)
    recognition.current = speech
    setRecording(true)
    speech.start()
  }

  async function acceptDraft() {
    if (!fields?.length || saving || accepted) return
    const title = fields.find((field) => field.label === 'Requested action')?.value.trim()
    if (!title) {
      setNotice('Add the requested action before saving this capture.')
      return
    }
    setSaving(true)
    setNotice('Saving the confirmed request to the local workspace…')
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotency_key: idempotencyKey.current,
          title,
          deadline: fields.find((field) => field.label === 'Deadline')?.value.trim() || null,
          owner: fields.find((field) => field.label === 'Owner')?.value.trim() || null,
          required_items: fields.filter((field) => field.label === 'Required item' && field.value.trim()).map((field) => field.value.trim()),
          source_name: sourceName,
          source_type: sourceType,
          source_content: message,
          facts: fields.map((field) => ({ label: field.label, value: field.value, source: field.source, uncertain: field.uncertain })),
        }),
      })
      if (response.status === 401) {
        setAuthError('Sign in to save this request.')
        setAuthMode('login')
        setNotice('Sign in to save this request. No external action was created.')
        return
      }
      if (!response.ok) throw new Error('The API rejected this capture.')
      const savedTask = await response.json() as WorkspaceTask
      await refreshWorkspace()
      setAccepted(true)
      setActiveView('capture')
      setNotice(`Saved as LP-${String(savedTask.id).padStart(4, '0')}. Unresolved facts remain marked; no external action was taken.`)
    } catch {
      setNotice('Could not save this request. Sign in if needed, then retry; no external action was created.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={darkMode ? 'app-shell theme-dark' : 'app-shell'}>
      <header className="topbar">
        <a className="brand" href="#capture" aria-label="LoopPilot home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span className="brand-name">loop<span>pilot</span></span>
        </a>
        <nav className="top-nav" aria-label="Primary">
          <button className={`nav-link${activeView === 'capture' ? ' active' : ''}`} type="button" onClick={() => setActiveView('capture')} aria-current={activeView === 'capture' ? 'page' : undefined}>Capture</button>
          <button className={`nav-link${activeView === 'today' ? ' active' : ''}`} type="button" onClick={() => setActiveView('today')} aria-current={activeView === 'today' ? 'page' : undefined}>Today <span>{String(tasks.length).padStart(2, '0')}</span></button>
          <button className={`nav-link${activeView === 'ledger' ? ' active' : ''}`} type="button" onClick={() => setActiveView('ledger')} aria-current={activeView === 'ledger' ? 'page' : undefined}>Ledger</button>
        </nav>
        <div className="top-actions">
          <span className="build-tag"><span className={`live-dot api-${apiStatus}`} /> {apiStatus === 'connected' ? 'API CONNECTED' : apiStatus === 'checking' ? 'API CHECKING' : 'API OFFLINE'}</span>
          <button className="theme-toggle" type="button" onClick={() => setDarkMode((value) => !value)} aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} title={darkMode ? 'Light mode' : 'Dark mode'}>
            {darkMode ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <div className="profile-menu-wrap">
            <button className="profile-button" type="button" aria-label="Local workspace account" aria-expanded={profileOpen} aria-controls="profile-panel" title="Local workspace account" onClick={() => setProfileOpen((open) => !open)}>LP</button>
            {profileOpen && <div id="profile-panel"><ProfilePanel
              apiStatus={apiStatus}
              account={account}
              model={gemmaStatus}
              modelConnection={modelConnection}
              onRefresh={() => void refreshWorkspace()}
              onClose={() => setProfileOpen(false)}
              onOpenAuth={(mode) => { setAuthError(''); setAuthMode(mode); setProfileOpen(false) }}
              onSignOut={() => void signOut()}
              onCheckModel={() => void checkGemma()}
            /></div>}
          </div>
        </div>
      </header>

      {apiError && activeView === 'capture' && <div className="api-warning" role="status">{apiError}<button type="button" onClick={() => void refreshWorkspace()} disabled={workspaceLoading}>Retry</button></div>}

      {activeView === 'capture' ? (
      <main id="capture" className="workspace">
        <div className="page-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-rule" /> INTAKE / 01</div>
            <h1>Close the loop<br /><em>before it slips.</em></h1>
            <p className="page-intro">A request comes in. Let’s make sure nothing gets lost on its way out.</p>
          </div>
          <div className="phase-stamp" aria-label="Phase 1 of 6">
            <span className="phase-label">WORKFLOW</span>
            <div className="phase-track" aria-hidden="true"><span className="phase-filled" /><span /><span /><span /><span /><span /></div>
            <span className="phase-current">01 <span>/</span> 06</span>
          </div>
        </div>

        <div className="workflow-grid">
          <section className="capture-column" aria-labelledby="capture-title">
            <div className="section-topline">
              <div><span className="step-index">01</span><h2 id="capture-title">Bring in the request</h2></div>
              <span className="step-note">PASTE · DROP · SPEAK</span>
            </div>

            <div
              className={`drop-zone${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
              ref={dropArea}
              onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
              onDragLeave={(event) => { if (!dropArea.current?.contains(event.relatedTarget as Node)) setDragging(false) }}
              onDrop={onDrop}
              aria-busy={busy}
            >
              <div className="drop-zone-header">
                <span className="drop-icon"><FileUp size={17} strokeWidth={1.7} /></span>
                <span>{busy ? 'Reading your source…' : 'Drop a file here'}</span>
                <span className="file-types">PDF · PNG · JPG · TXT</span>
              </div>
              <div className="drop-rule"><span>OR PASTE A MESSAGE</span></div>
              <label className="sr-only" htmlFor="request-message">Paste or type the document request</label>
              <textarea
                id="request-message"
                value={message}
                onChange={(event) => { setMessage(event.target.value); setAccepted(false) }}
                onKeyDown={onPasteKey}
                placeholder={'“Please send the revised project report by Friday.\nInclude the latest budget sheet.”'}
                rows={6}
              />
              <div className="drop-zone-footer">
                <span className="shortcut-hint"><kbd>⌘</kbd><kbd>↵</kbd> to extract</span>
                <div className="capture-buttons">
                  {speechSupported ? (
                    <button className={`icon-action${recording ? ' recording' : ''}`} type="button" onClick={() => recording ? recognition.current?.stop() : startVoiceCapture()} aria-label={recording ? 'Stop voice capture' : 'Record a voice request'} title={recording ? 'Stop recording' : 'Record a voice request'}>
                      {recording ? <AudioLines size={17} /> : <Mic size={17} />}
                    </button>
                  ) : (
                    <button className="icon-action" type="button" disabled title="Speech recognition is not available in this browser" aria-label="Speech recognition unavailable"><Mic size={17} /></button>
                  )}
                  <button className="icon-action" type="button" onClick={() => fileInput.current?.click()} aria-label="Choose a file" title="Choose a file"><Paperclip size={17} /></button>
                  <input ref={fileInput} className="sr-only" type="file" accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,text/markdown,image/*" onChange={onFileChange} />
                  <button className="extract-button" type="button" onClick={() => gemmaStatus.ready && account ? void analyzeWithGemma() : analyze()} disabled={!message.trim() || busy} title={gemmaStatus.ready && account ? `Use ${gemmaStatus.model}` : 'Local heuristic only; configure Gemma from the account menu'}>{busy ? 'Extracting…' : gemmaStatus.ready && account ? 'Extract with Gemma' : 'Extract locally'} <ArrowRight size={15} /></button>
                </div>
              </div>
            </div>

            <div className="capture-footnote"><ShieldCheck size={14} strokeWidth={1.7} /> {gemmaStatus.ready && account ? 'OCR runs locally; source text is sent to Google Gemma for interpretation and planning. Nothing is sent to a recipient.' : 'PDF and image text extraction runs locally. No recipient message is sent; browser voice recognition may use its own service.'}</div>

            {notice && (
              <div className={`notice${accepted ? ' notice-success' : ''}`} role="status">
                {accepted ? <Check size={15} /> : <FileText size={15} />}
                <span>{notice}</span>
                <button type="button" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={14} /></button>
              </div>
            )}

            <div className="example-row">
              <span className="example-label">TRY A SAMPLE</span>
              <button type="button" onClick={() => analyze(seedMessage, 'Sample project request', 'MESSAGE')}>Project report <ArrowDownToLine size={12} /></button>
            </div>
          </section>

          <section className={`review-column${fields ? ' has-fields' : ''}`} aria-labelledby="review-title" aria-live="polite">
            <div className="section-topline review-topline">
              <div><span className="step-index">02</span><h2 id="review-title">Check what we heard</h2></div>
              {fields && <button className="reset-button" type="button" onClick={() => { setFields(null); setAccepted(false); setNotice('') }} aria-label="Clear extraction" title="Clear extraction"><RotateCcw size={15} /></button>}
            </div>

            <AnimatePresence mode="wait">
              {fields ? (
                <motion.div className="extraction-card" key="extracted" initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.22 }}>
                  <div className="extraction-card-top">
                    <div className="source-identity">
                      <span className="source-file-icon">{sourceType.includes('IMAGE') ? <ImageIcon size={16} /> : <FileText size={16} />}</span>
                      <div><span className="source-name">{sourceName}</span><span className="source-kind">{sourceType} · JUST NOW</span></div>
                    </div>
                    <span className="local-chip"><span /> LOCAL DRAFT</span>
                  </div>

                  <div className="field-list">
                    {fields.map((field, index) => (
                      <div className={`field-row${field.uncertain ? ' is-uncertain' : ''}`} key={field.label}>
                        <div className="field-label-row">
                          <label htmlFor={`field-${index}`}>{field.label}</label>
                          {field.uncertain && <span className="uncertainty-chip">CHECK</span>}
                        </div>
                        <input id={`field-${index}`} value={field.value} onChange={(event) => updateField(index, event.target.value)} placeholder={field.label === 'Owner' ? 'Add a name or leave unresolved' : `Not detected — add ${field.label.toLowerCase()}`} />
                        <div className="evidence-line"><span className="evidence-pin" /><span>{field.source}</span></div>
                      </div>
                    ))}
                  </div>

                  {interpretation && (
                    <section className="gemma-plan" aria-label="Gemma interpretation and plan">
                      <div className="gemma-plan-heading"><span>GEMMA INTERPRETATION</span><span>DETERMINISTIC NEXT STEPS</span></div>
                      <p className="gemma-interpretation">{interpretation}</p>
                      <ol className="plan-step-list">
                        {plan.map((step, index) => (
                          <li key={`${step.title}-${index}`}>
                            <span className="plan-step-index">{String(index + 1).padStart(2, '0')}</span>
                            <div className="plan-step-copy">
                              <div className="plan-step-title"><strong>{step.title}</strong><span className={`plan-status plan-${step.status.toLowerCase().replaceAll(' ', '-')}`}>{step.status}</span></div>
                              <p>{step.reason}</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}

                  <div className="review-card-footer">
                    <div className="confidence-summary">
                      <span className="confidence-dots" aria-hidden="true">{Array.from({ length: fieldCount }, (_, index) => <i className={index < confirmedCount ? 'confirmed' : ''} key={index} />)}</span>
                      <span>{confirmedCount} of {fieldCount} fields clear</span>
                    </div>
                    <button className="accept-button" type="button" onClick={() => void acceptDraft()} disabled={accepted || saving}>{saving ? 'Saving…' : accepted ? <><Check size={15} /> Saved</> : <>Save to Today <ArrowRight size={15} /></>}</button>
                  </div>
                </motion.div>
              ) : (
                <motion.div className="empty-review" key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <div className="empty-orbit" aria-hidden="true"><span /><i /><b /></div>
                  <span className="empty-kicker">THE FIRST HANDOFF</span>
                  <p>Your request, made<br />clear and checkable.</p>
                  <span className="empty-detail">Extracted details and their source evidence will appear here.</span>
                  <div className="empty-divider"><span /><ChevronDown size={13} /><span /></div>
                  <div className="empty-steps"><span><i>1</i> Bring in a request</span><ArrowRight size={12} /><span><i>2</i> Check each detail</span></div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>

        <section className="workflow-note" aria-label="Workflow boundary">
          <div className="note-mark"><span className="brand-mark small" aria-hidden="true"><span /></span></div>
          <div className="note-copy"><span className="note-title">Nothing moves until you say so.</span><span>LoopPilot drafts the details. You stay in control of what happens next.</span></div>
          <span className="note-status"><span className="live-dot" /> NO ACTIONS TAKEN</span>
        </section>

        <footer className="page-footer">
          <span>LOOPPILOT <span className="footer-separator">/</span> PHASE 01 · CAPTURE & CONFIRM</span>
          <span>{sourceType.startsWith('GEMMA') ? `MODEL PROPOSAL · ${gemmaStatus.model}` : 'LOCAL HEURISTIC EXTRACTION · NOT A MODEL RESULT'}</span>
        </footer>
      </main>
      ) : (
        <WorkflowPages view={activeView} tasks={tasks} events={events} loading={workspaceLoading} error={apiError} onRefresh={() => void refreshWorkspace()} />
      )}
      {authMode && <AuthDialog mode={authMode} busy={authBusy} error={authError} onClose={() => { setAuthMode(null); setAuthError('') }} onModeChange={(mode) => { setAuthError(''); setAuthMode(mode) }} onSubmit={(email, password) => void submitAuth(email, password)} />}
    </div>
  )
}