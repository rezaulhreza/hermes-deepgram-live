/**
 * Deepgram Live Voice — a full-duplex spoken conversation with Hermes.
 *
 * Deepgram is the ears and the mouth only. Its listening model (streaming speech-to-text with end-of-turn
 * detection) hears the user and Aura (streaming text-to-speech) speaks. Hermes is the only
 * model: each finished utterance is sent as an ordinary turn on the open chat, and the reply is
 * spoken sentence by sentence as it streams, including the short lines Hermes says before each
 * tool call. Speaking over a reply cuts it off (barge-in), and approvals can be answered aloud.
 *
 * The Deepgram key stays on the backend half (~/.hermes/plugins/deepgram-live): every socket
 * opened here is authorised with a 30 second token from `ctx.rest('/auth')`. All requests carry
 * `mip_opt_out=true` unless the `mip_opt_out` setting is turned off, so by default nothing is used
 * to train Deepgram's models.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls, and only the SDK and react resolve.
 */

import { atom, cn, COMPOSER_AREAS, haptic, host, KEYBINDS_AREA, PALETTE_AREA, STATUSBAR_AREAS, Tip, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'deepgram-live'

const LISTEN_URL = 'wss://api.deepgram.com/v2/listen'
const SPEAK_URL = 'wss://api.deepgram.com/v1/speak'
const INPUT_SAMPLE_RATE = 16000
const OUTPUT_SAMPLE_RATE = 24000

// Deepgram rate-limits Flush on the speak socket, so replies are flushed at most this often.
// The first sentence of a reply is always flushed at once so speech starts without delay.
const FLUSH_MIN_INTERVAL_MS = 3200
const SPEAK_TEXT_LIMIT = 1000
// Mic gain while the voice is playing. Browser echo cancellation is the main defence; ducking
// keeps leftover speaker bleed under the listening model's radar while the user's own voice still gets through
// for barge-in. Raise it if talking over a reply does not interrupt; lower it if the voice
// interrupts itself.
const MIC_GAIN_DURING_PLAYBACK = 0.2
// Speech heard this soon after playback ends may still be the speakers' tail.
const PLAYBACK_TAIL_MS = 350
const ECHO_MEMORY_MS = 20_000
const APPROVAL_POLL_MS = 2000
const SOCKET_OPEN_TIMEOUT_MS = 10_000
// A tool that starts with nothing said recently gets a stock line, so long work is never silent.
const TOOL_LINE_QUIET_MS = 2500

const STOP_PHRASES = new Set(['stop', 'stop listening', 'goodbye', 'end voice chat'])
// Spoken approval is deliberately narrow: a whole-utterance match only, and it grants this one
// call (never "always"). Anything else is asked again.
const APPROVE_PHRASES = new Set([
  'yes', 'yeah', 'yep', 'yes please', 'approve', 'approved', 'go ahead', 'yes go ahead', 'do it', 'yes do it',
  'run it', 'yes run it', 'allow it', 'yes allow it', 'let it', 'yes let it'
])
const DENY_PATTERN = /^(no|nope|no thanks|deny|denied|dont|do not|cancel|stop|reject)\b/

const TOOL_LINES = [
  [/^(terminal|shell|bash|process|execute_code)/, 'Running a command.'],
  [/^(read_file|search_files|list_|file_)/, 'Looking through the files.'],
  [/^(write_file|patch|edit)/, 'Making an edit.'],
  [/^(web_search|web_extract|x_search)/, 'Searching the web.'],
  [/^browser/, 'Using the browser.'],
  [/^computer_use/, 'Working on your screen.'],
  [/^(memory|session_search)/, 'Checking my memory.'],
  [/^(delegate|subagent)/, 'Handing part of this to a helper.'],
  [/^(image_generate|vision)/, 'Working on an image.']
]

// ── audio worklet ──────────────────────────────────────────────────────────────────────────────
// Mic: device rate → 16 kHz int16, posted in 80 ms frames (what the listening model is tuned for).
// Playback: 24 kHz int16 from Aura → device rate. Based on the Iris voice agent worklet.
const WORKLET_SOURCE = `
class DeepgramLiveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    this.inputRate = opts.inputRate
    this.outputRate = opts.outputRate
    this.duckGain = opts.duckGain
    this.frame = new Int16Array(Math.round(this.inputRate * 0.08))
    this.frameFill = 0
    this.ratio = sampleRate / this.inputRate
    this.phase = 0
    this.acc = 0
    this.accCount = 0
    this.chunks = []
    this.chunkIndex = 0
    this.sampleIndex = 0
    this.micGain = 1
    this.cooldown = 0
    this.playing = false
    this.tick = 0
    this.port.onmessage = event => {
      const data = event.data
      if (data.type === 'play' && data.samples instanceof ArrayBuffer) {
        const pcm = new Int16Array(data.samples)
        if (pcm.length) this.chunks.push(this.resample(pcm))
      } else if (data.type === 'clear') {
        this.chunks = []
        this.chunkIndex = 0
        this.sampleIndex = 0
        this.micGain = 1
        this.cooldown = 0
      }
    }
  }

  resample(pcm) {
    const ratio = sampleRate / this.outputRate
    const out = new Float32Array(Math.max(1, Math.floor(pcm.length * ratio)))
    for (let i = 0; i < out.length; i++) {
      const position = i / ratio
      const left = Math.floor(position)
      const right = Math.min(left + 1, pcm.length - 1)
      const weight = position - left
      out[i] = (pcm[left] * (1 - weight) + pcm[right] * weight) / 32768
    }
    return out
  }

  nextSample() {
    while (this.chunkIndex < this.chunks.length) {
      const chunk = this.chunks[this.chunkIndex]
      if (this.sampleIndex < chunk.length) return chunk[this.sampleIndex++]
      this.chunkIndex += 1
      this.sampleIndex = 0
    }
    if (this.chunkIndex > 0) {
      this.chunks = []
      this.chunkIndex = 0
    }
    return 0
  }

  process(inputs, outputs) {
    const output = outputs[0]
    const active = this.chunkIndex < this.chunks.length
    if (output && output[0]) {
      for (let i = 0; i < output[0].length; i++) {
        const sample = Math.max(-0.99, Math.min(0.99, this.nextSample()))
        for (let channel = 0; channel < output.length; channel++) output[channel][i] = sample
      }
    }

    // Duck (never gate) the mic while the voice plays, and for a moment after, so speaker
    // bleed stays quiet but the user can still be heard talking over it.
    let target = 1
    if (active) {
      target = this.duckGain
      this.cooldown = 30
    } else if (this.cooldown > 0) {
      target = this.duckGain
      this.cooldown -= 1
    }
    this.micGain += (target - this.micGain) * 0.15

    const input = inputs[0] && inputs[0][0]
    let energy = 0
    if (input) {
      for (let i = 0; i < input.length; i++) {
        const raw = input[i]
        energy += raw * raw
        this.acc += raw
        this.accCount += 1
        this.phase += 1
        if (this.phase >= this.ratio) {
          this.phase -= this.ratio
          const sample = Math.max(-1, Math.min(1, (this.acc / this.accCount) * this.micGain))
          this.acc = 0
          this.accCount = 0
          this.frame[this.frameFill++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
          if (this.frameFill === this.frame.length) {
            const copy = this.frame.slice()
            this.port.postMessage({ type: 'audio', samples: copy.buffer }, [copy.buffer])
            this.frameFill = 0
          }
        }
      }
    }

    this.tick += 1
    if (active !== this.playing || this.tick % 16 === 0) {
      this.playing = active
      this.port.postMessage({
        type: 'state',
        playing: active,
        level: input ? Math.sqrt(energy / input.length) : 0
      })
    }
    return true
  }
}
registerProcessor('deepgram-live-processor', DeepgramLiveProcessor)
`

// ── text helpers ───────────────────────────────────────────────────────────────────────────────

/** Lowercase words only: the form transcripts and spoken text are compared in. */
function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Make reply text speakable. Hermes is asked for plain prose on spoken turns, but typed turns
 *  and stubborn models still produce markdown. */
function speakable(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function toolLine(name) {
  const tool = String(name || '').toLowerCase()

  for (const [pattern, line] of TOOL_LINES) {
    if (pattern.test(tool)) {
      return line
    }
  }

  return tool ? `Using ${tool.replace(/[_-]+/g, ' ')}.` : 'Working on it.'
}

function describeApproval(approval) {
  const description = String(approval.description || '').replace(/\s+/g, ' ').trim()
  const command = String(approval.command || '').replace(/\s+/g, ' ').trim()

  if (description && command && command.length <= 80) {
    return `${description}. The command is: ${command}`
  }

  return description || (command ? `run this command: ${command.slice(0, 120)}` : 'run a command')
}

// ── the live session ───────────────────────────────────────────────────────────────────────────

/** off → connecting → listening ⇄ hearing → thinking → speaking → listening */
const $phase = atom('off')

class LiveVoice {
  constructor(ctx) {
    this.ctx = ctx
    this.active = false
    this.settings = null
    this.audio = null
    this.worklet = null
    this.mic = null
    this.listen = null
    this.speak = null
    this.speakOpening = null
    this.playing = false
    this.playbackEndedAt = 0
    this.pendingFlushes = 0
    this.lastFlushAt = 0
    this.flushTimer = null
    this.unflushed = false
    this.spoken = []
    this.lastSayAt = 0
    this.turn = null
    this.pendingText = ''
    this.userTurn = { duringPlayback: false, barged: false }
    this.approval = null
    this.handledApprovals = new Set()
    this.approvalTimer = null
    this.listenRetries = 0
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

  async start() {
    if (this.active) {
      return
    }

    this.active = true
    $phase.set('connecting')

    try {
      this.settings = await this.ctx.rest('/status')

      if (!this.settings?.available) {
        throw new Error(this.settings?.reason || 'Deepgram is not configured')
      }

      await this.openAudio()
      await Promise.all([this.openListen(), this.ensureSpeak()])

      if (!this.active) {
        return
      }

      this.approvalTimer = window.setInterval(() => void this.pollApproval(), APPROVAL_POLL_MS)
      this.refreshPhase()
      haptic('tap')
    } catch (error) {
      this.stop()
      host.notifyError(error, 'Could not start live voice')
    }
  }

  stop() {
    if (!this.active && $phase.get() === 'off') {
      return
    }

    this.active = false
    window.clearInterval(this.approvalTimer)
    window.clearTimeout(this.flushTimer)
    this.approvalTimer = null
    this.flushTimer = null

    try {
      this.listen?.send(JSON.stringify({ type: 'CloseStream' }))
    } catch {
      // Socket already gone.
    }

    try {
      this.speak?.send(JSON.stringify({ type: 'Close' }))
    } catch {
      // Socket already gone.
    }

    this.listen?.close()
    this.speak?.close()
    this.listen = null
    this.speak = null
    this.speakOpening = null
    this.mic?.getTracks().forEach(track => track.stop())
    this.mic = null
    this.worklet?.disconnect()
    this.worklet = null
    void this.audio?.close().catch(() => undefined)
    this.audio = null
    this.playing = false
    this.turn = null
    this.approval = null
    this.pendingText = ''
    $phase.set('off')
  }

  toggle() {
    if (this.active) {
      this.stop()
    } else {
      void this.start()
    }
  }

  refreshPhase() {
    if (!this.active) {
      return
    }

    if ($phase.get() === 'connecting' && !this.listen) {
      return
    }

    const busy = this.turn && !this.turn.done

    $phase.set(this.playing || this.pendingFlushes > 0 ? 'speaking' : busy ? 'thinking' : 'listening')
  }

  // ── audio ────────────────────────────────────────────────────────────────────────────────────

  async openAudio() {
    const audio = new AudioContext({ latencyHint: 'interactive' })
    this.audio = audio

    if (audio.state === 'suspended') {
      await audio.resume()
    }

    const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))

    try {
      await audio.audioWorklet.addModule(moduleUrl)
    } finally {
      URL.revokeObjectURL(moduleUrl)
    }

    const worklet = new AudioWorkletNode(audio, 'deepgram-live-processor', {
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        duckGain: MIC_GAIN_DURING_PLAYBACK,
        inputRate: INPUT_SAMPLE_RATE,
        outputRate: OUTPUT_SAMPLE_RATE
      }
    })

    worklet.port.onmessage = ({ data }) => {
      if (data.type === 'audio') {
        if (this.listen?.readyState === WebSocket.OPEN) {
          this.listen.send(data.samples)
        }

        return
      }

      if (data.type === 'state' && data.playing !== this.playing) {
        this.playing = data.playing

        if (!data.playing) {
          this.playbackEndedAt = Date.now()
        }

        this.refreshPhase()
      }
    }

    worklet.connect(audio.destination)
    this.worklet = worklet

    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
    audio.createMediaStreamSource(this.mic).connect(worklet)
  }

  /** The voice is audible now, or was a moment ago (its tail may still be in the room). */
  audible() {
    return this.playing || Date.now() - this.playbackEndedAt < PLAYBACK_TAIL_MS
  }

  // ── sockets ──────────────────────────────────────────────────────────────────────────────────

  async openSocket(url) {
    const auth = await this.ctx.rest('/auth', { method: 'POST' })
    const socket = new WebSocket(url, [auth.scheme, auth.value])
    socket.binaryType = 'arraybuffer'

    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Deepgram connection timed out')), SOCKET_OPEN_TIMEOUT_MS)

      socket.addEventListener('open', () => {
        window.clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        window.clearTimeout(timer)
        reject(new Error('Deepgram connection failed'))
      })
    })

    return socket
  }

  async openListen() {
    const params = new URLSearchParams({
      encoding: 'linear16',
      eot_threshold: String(this.settings.eot_threshold),
      eot_timeout_ms: String(this.settings.eot_timeout_ms),
      mip_opt_out: String(this.settings.mip_opt_out !== false),
      model: this.settings.listen_model,
      sample_rate: String(INPUT_SAMPLE_RATE)
    })

    for (const term of this.settings.keyterms || []) {
      params.append('keyterm', term)
    }

    const socket = await this.openSocket(`${LISTEN_URL}?${params}`)

    if (!this.active) {
      socket.close()

      return
    }

    socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') {
        this.onListenMessage(data)
      }
    })
    socket.addEventListener('close', () => {
      if (this.listen === socket && this.active) {
        this.listen = null
        void this.reopenListen()
      }
    })
    this.listen = socket
    this.listenRetries = 0
  }

  async reopenListen() {
    if (this.listenRetries >= 2) {
      this.stop()
      host.notify({ kind: 'warning', message: 'Live voice lost its connection to Deepgram.' })

      return
    }

    this.listenRetries += 1

    try {
      await this.openListen()
    } catch {
      void this.reopenListen()
    }
  }

  /** The speak socket is opened on demand: Deepgram closes it when idle, and a reply can
   *  arrive long after the last one. */
  ensureSpeak() {
    if (this.speak?.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.speak)
    }

    if (!this.speakOpening) {
      const params = new URLSearchParams({
        encoding: 'linear16',
        mip_opt_out: String(this.settings.mip_opt_out !== false),
        model: this.settings.voice,
        sample_rate: String(OUTPUT_SAMPLE_RATE)
      })

      if (Number(this.settings.speed) && Number(this.settings.speed) !== 1) {
        params.set('speed', String(this.settings.speed))
      }

      this.speakOpening = this.openSocket(`${SPEAK_URL}?${params}`)
        .then(socket => {
          if (!this.active) {
            socket.close()

            throw new Error('Live voice stopped')
          }

          socket.addEventListener('message', ({ data }) => this.onSpeakMessage(data))
          socket.addEventListener('close', () => {
            if (this.speak === socket) {
              this.speak = null
              this.pendingFlushes = 0
              this.refreshPhase()
            }
          })
          this.speak = socket

          return socket
        })
        .finally(() => {
          this.speakOpening = null
        })
    }

    return this.speakOpening
  }

  onSpeakMessage(data) {
    if (typeof data !== 'string') {
      this.worklet?.port.postMessage({ type: 'play', samples: data }, [data])

      return
    }

    let message

    try {
      message = JSON.parse(data)
    } catch {
      return
    }

    if (message.type === 'Flushed') {
      this.pendingFlushes = Math.max(0, this.pendingFlushes - 1)
      this.refreshPhase()
    } else if (message.type === 'Cleared') {
      this.pendingFlushes = 0
      this.refreshPhase()
    } else if (message.type === 'Warning' || message.type === 'Error') {
      console.warn('[deepgram-live] speak:', message.code, message.description)
    }
  }

  // ── speaking ─────────────────────────────────────────────────────────────────────────────────

  say(text) {
    const line = speakable(text)

    if (!line || !this.active) {
      return
    }

    const now = Date.now()

    this.lastSayAt = now
    this.spoken = [...this.spoken.filter(entry => now - entry.at < ECHO_MEMORY_MS), { at: now, text: normalise(line) }]

    void this.ensureSpeak()
      .then(socket => {
        for (let index = 0; index < line.length; index += SPEAK_TEXT_LIMIT) {
          socket.send(JSON.stringify({ text: line.slice(index, index + SPEAK_TEXT_LIMIT), type: 'Speak' }))
        }

        this.unflushed = true
        this.scheduleFlush()
      })
      .catch(error => console.warn('[deepgram-live] could not speak:', error))
  }

  scheduleFlush() {
    if (this.flushTimer || !this.unflushed) {
      return
    }

    const wait = this.lastFlushAt + FLUSH_MIN_INTERVAL_MS - Date.now()

    if (wait > 0) {
      this.flushTimer = window.setTimeout(() => {
        this.flushTimer = null
        this.scheduleFlush()
      }, wait)

      return
    }

    if (this.speak?.readyState !== WebSocket.OPEN) {
      return
    }

    this.speak.send(JSON.stringify({ type: 'Flush' }))
    this.unflushed = false
    this.lastFlushAt = Date.now()
    this.pendingFlushes += 1
    this.refreshPhase()
  }

  /** Cut the voice off mid-word and drop everything it was still going to say. */
  hush() {
    window.clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.unflushed = false
    this.pendingText = ''

    if (this.speak?.readyState === WebSocket.OPEN) {
      this.speak.send(JSON.stringify({ type: 'Clear' }))
    }

    this.worklet?.port.postMessage({ type: 'clear' })
    this.pendingFlushes = 0
  }

  /** Feed streamed reply text; complete sentences are spoken as they form. */
  feed(text, final = false) {
    this.pendingText += text

    // Code is shown on screen, never read aloud. An unclosed fence holds back what follows it.
    let ready = this.pendingText.replace(/```[\s\S]*?```/g, ' ')
    let held = ''
    const fence = ready.indexOf('```')

    if (fence !== -1) {
      held = ready.slice(fence)
      ready = ready.slice(0, fence)
    }

    if (final) {
      this.pendingText = ''
      this.say(ready)

      return
    }

    const boundary = /[.!?…]["')\]]*\s+|\n+/g
    let cut = 0
    let match

    while ((match = boundary.exec(ready))) {
      // Short fragments ("Sure.", "1.") read better joined to what follows.
      if (match.index + match[0].length - cut >= 24) {
        this.say(ready.slice(cut, match.index + match[0].length))
        cut = match.index + match[0].length
      }
    }

    this.pendingText = ready.slice(cut) + held
  }

  // ── hearing ──────────────────────────────────────────────────────────────────────────────────

  onListenMessage(raw) {
    let message

    try {
      message = JSON.parse(raw)
    } catch {
      return
    }

    if (message.type !== 'TurnInfo') {
      if (message.type === 'Error' || message.type === 'Warning') {
        console.warn('[deepgram-live] listen:', message.code, message.description)
      }

      return
    }

    const transcript = String(message.transcript || '').trim()

    if (message.event === 'StartOfTurn') {
      this.userTurn = { barged: false, duringPlayback: this.audible() }
    }

    if (message.event === 'StartOfTurn' || message.event === 'Update') {
      if (this.audible() && !this.userTurn.barged && transcript && !this.isEcho(transcript)) {
        this.userTurn.barged = true
        this.hush()

        if (this.turn) {
          this.turn.muted = true
        }

        haptic('tap')
      }

      if (!this.audible()) {
        $phase.set('hearing')
      }

      return
    }

    if (message.event !== 'EndOfTurn') {
      return
    }

    const turn = this.userTurn

    this.userTurn = { barged: false, duringPlayback: false }
    this.refreshPhase()

    // A turn that began under the voice and never broke through it is the voice itself.
    if (!transcript || (turn.duringPlayback && !turn.barged)) {
      return
    }

    void this.onUtterance(transcript, turn)
  }

  /** True when a transcript is just the speakers being heard by the mic. */
  isEcho(transcript) {
    const heard = normalise(transcript)

    if (!heard) {
      return true
    }

    const now = Date.now()
    const recent = this.spoken.filter(entry => now - entry.at < ECHO_MEMORY_MS).map(entry => entry.text).join(' ')
    const words = heard.split(' ')

    if (words.length > 3) {
      return recent.includes(heard)
    }

    const said = new Set(recent.split(' '))

    return words.every(word => said.has(word))
  }

  async onUtterance(transcript, userTurn) {
    const heard = normalise(transcript)

    if (this.approval) {
      await this.answerApproval(heard, userTurn)

      return
    }

    if (STOP_PHRASES.has(heard)) {
      await this.interruptIfBusy(host.state.focusedSessionId.get())
      this.stop()

      return
    }

    await this.submit(transcript)
  }

  // ── Hermes turns ─────────────────────────────────────────────────────────────────────────────

  async interruptIfBusy(sessionId) {
    if (!sessionId || !host.state.busyBySession.get()[sessionId]) {
      return
    }

    await host.request('session.interrupt', { session_id: sessionId }).catch(() => undefined)

    const deadline = Date.now() + 4000

    while (host.state.busyBySession.get()[sessionId] && Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 100))
    }
  }

  async submit(text) {
    const sessionId = host.state.focusedSessionId.get()

    this.hush()
    await this.interruptIfBusy(sessionId)

    // Tell the agent half this turn was spoken, so the reply comes back as speakable prose.
    await this.ctx.rest('/turn', { body: { text }, method: 'POST' }).catch(() => undefined)

    if (!this.active) {
      return
    }

    // Only text that streams after this turn's own start is spoken: late chunks of an
    // interrupted reply must stay silent.
    this.turn = { done: false, muted: false, sessionId, spoke: false, started: false }

    const sent =
      host.composer.submit(null, text) ||
      (sessionId ? host.composer.submit(sessionId, text) : false) ||
      host.composer.submit('new', text)

    if (!sent) {
      this.turn = null
      this.say('I could not send that. Click into a chat and try again.')
    }

    this.refreshPhase()
  }

  /** Does a gateway event belong to the chat this conversation is talking to? */
  claims(event) {
    if (!this.active || !event.session_id) {
      return false
    }

    if (this.turn?.sessionId) {
      return event.session_id === this.turn.sessionId
    }

    return event.session_id === host.state.focusedSessionId.get()
  }

  onMessageStart(event) {
    if (!this.claims(event)) {
      return
    }

    if (!this.turn || this.turn.done) {
      // A typed turn while live voice is on is spoken too.
      this.turn = { done: false, muted: false, sessionId: event.session_id, spoke: false, started: true }
    } else {
      // A brand-new chat has no id until its first turn starts: bind to it here.
      this.turn.sessionId = event.session_id
      this.turn.started = true
    }

    this.pendingText = ''
    this.refreshPhase()
  }

  speaking(event) {
    return this.claims(event) && this.turn?.started && !this.turn.muted
  }

  onMessageDelta(event) {
    const text = event.payload?.text

    if (this.speaking(event) && typeof text === 'string' && text) {
      this.turn.spoke = true
      this.feed(text)
    }
  }

  onMessageInterim(event) {
    if (!this.speaking(event)) {
      return
    }

    const text = event.payload?.text

    if (!event.payload?.already_streamed && typeof text === 'string' && text) {
      this.turn.spoke = true
      this.feed(text)
    }

    // The commentary before a tool call is a finished thought: say it now.
    this.feed('', true)
  }

  onToolStart(event) {
    if (!this.speaking(event)) {
      return
    }

    this.feed('', true)

    if (Date.now() - this.lastSayAt > TOOL_LINE_QUIET_MS && !this.audible()) {
      this.say(toolLine(event.payload?.name))
    }
  }

  onMessageComplete(event) {
    if (!this.claims(event) || !this.turn || !this.turn.started) {
      return
    }

    if (!this.turn.muted) {
      const text = event.payload?.text

      if (!this.turn.spoke && typeof text === 'string') {
        this.feed(text, true)
      } else {
        this.feed('', true)
      }
    }

    this.turn.done = true
    this.refreshPhase()
  }

  // ── approvals ────────────────────────────────────────────────────────────────────────────────

  async pollApproval() {
    const sessionId = this.turn?.sessionId || host.state.focusedSessionId.get()

    if (!this.active || !sessionId || !host.state.busyBySession.get()[sessionId]) {
      this.approval = null

      return
    }

    let pending

    try {
      pending = (await host.request('approval.pending', { session_id: sessionId }))?.approvals || []
    } catch {
      return
    }

    const next = pending.find(approval => approval.request_id && !this.handledApprovals.has(approval.request_id))

    if (!next) {
      // Answered on screen, or withdrawn.
      this.approval = null

      return
    }

    if (this.approval?.id === next.request_id) {
      return
    }

    this.approval = { id: next.request_id, sessionId, spokenOk: !next.smart_denied }
    this.feed('', true)

    // The question never contains an accepting word, so the mic hearing the voice ask it can
    // not approve anything.
    this.say(
      next.smart_denied
        ? `Hermes wants to ${describeApproval(next)}. This one was flagged as risky, so please decide on screen.`
        : `Hermes wants to ${describeApproval(next)}. Should I let it?`
    )
  }

  async answerApproval(heard, userTurn) {
    const approval = this.approval

    if (DENY_PATTERN.test(heard)) {
      await this.respondApproval(approval, 'deny', 'Okay, I blocked it.')

      return
    }

    if (!approval.spokenOk) {
      this.say('Please decide that one on screen.')

      return
    }

    // Allowing needs a clear answer given after the question finished playing; an answer that
    // started over the voice could be the voice. Blocking above is accepted any time.
    if (APPROVE_PHRASES.has(heard) && !userTurn.duringPlayback) {
      await this.respondApproval(approval, 'once', 'Okay, going ahead.')

      return
    }

    this.say('I need a clear answer. Should I let it run?')
  }

  async respondApproval(approval, choice, line) {
    try {
      await host.request('approval.respond', {
        choice,
        request_id: approval.id,
        session_id: approval.sessionId
      })
      this.handledApprovals.add(approval.id)
      this.approval = null
      this.say(line)
    } catch (error) {
      host.notifyError(error, 'Could not answer the approval')
      this.say('That did not go through. Please decide on screen.')
    }
  }
}

// ── UI ─────────────────────────────────────────────────────────────────────────────────────────

const PHASE_LABEL = {
  connecting: 'Connecting…',
  hearing: 'Hearing you',
  listening: 'Listening',
  off: 'Live voice',
  speaking: 'Speaking',
  thinking: 'Working'
}

function WaveIcon({ live }) {
  const bars = [
    [4, 9, 6],
    [8, 5, 14],
    [12, 3, 18],
    [16, 6, 12],
    [20, 9, 6]
  ]

  return jsx('svg', {
    'aria-hidden': true,
    className: cn('size-4', live && 'animate-pulse'),
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round',
    strokeWidth: 2,
    viewBox: '0 0 24 24',
    children: bars.map(([x, y, height]) => jsx('line', { x1: x, x2: x, y1: y, y2: y + height }, x))
  })
}

function LiveButton({ voice }) {
  const phase = useValue($phase)
  const on = phase !== 'off'

  return jsx(Tip, {
    label: on ? `${PHASE_LABEL[phase]} — click to end live voice` : 'Start live voice (Deepgram)',
    // Labelled, because the app's own voice-chat button is also a waveform.
    children: jsxs('button', {
      'aria-label': on ? 'End live voice' : 'Start live voice',
      'aria-pressed': on,
      className: cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors',
        'hover:bg-(--chrome-action-hover)',
        on ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary) hover:text-foreground'
      ),
      onClick: () => voice.toggle(),
      type: 'button',
      children: [
        jsx(WaveIcon, { live: phase === 'hearing' || phase === 'speaking' }),
        on ? PHASE_LABEL[phase] : 'Live'
      ]
    })
  })
}

function LiveChip({ voice }) {
  const phase = useValue($phase)

  if (phase === 'off') {
    return null
  }

  return jsx(Tip, {
    label: 'Live voice is on — click to end',
    children: jsxs('button', {
      className: cn(
        'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-accent) hover:bg-(--chrome-action-hover)'
      ),
      onClick: () => voice.stop(),
      type: 'button',
      children: [jsx(WaveIcon, { live: phase === 'hearing' || phase === 'speaking' }), PHASE_LABEL[phase]]
    })
  })
}

export default {
  id: ID,
  name: 'Deepgram Live Voice',
  register(ctx) {
    const voice = new LiveVoice(ctx)

    ctx.onDispose(() => voice.stop())
    ctx.onEvent('message.start', event => voice.onMessageStart(event))
    ctx.onEvent('message.delta', event => voice.onMessageDelta(event))
    ctx.onEvent('message.interim', event => voice.onMessageInterim(event))
    ctx.onEvent('tool.start', event => voice.onToolStart(event))
    ctx.onEvent('message.complete', event => voice.onMessageComplete(event))

    ctx.registerMany([
      {
        id: 'button',
        area: COMPOSER_AREAS.actions,
        order: 50,
        render: () => jsx(LiveButton, { voice })
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 125,
        render: () => jsx(LiveChip, { voice })
      },
      {
        id: 'toggle-command',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.toggle`,
          keywords: ['voice', 'live', 'deepgram', 'talk', 'speak'],
          label: 'Toggle Live Voice (Deepgram)',
          run: () => voice.toggle()
        }
      },
      {
        id: 'toggle-keybind',
        area: KEYBINDS_AREA,
        data: {
          category: 'Live Voice',
          defaults: ['mod+alt+v'],
          id: `${ID}.toggle`,
          label: 'Toggle live voice',
          run: () => voice.toggle()
        }
      }
    ])
  }
}
