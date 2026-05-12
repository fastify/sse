'use strict'

const fp = require('fastify-plugin')
const createError = require('@fastify/error')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')

const FST_ERR_SSE_UNKNOWN_KIND = createError(
  'FST_ERR_SSE_UNKNOWN_KIND',
  "@fastify/sse: unknown sse kind '%s'. Use 'only' (SSE-only route), 'dual' (route serves both SSE and non-SSE), or omit for back-compat."
)

const FST_ERR_SSE_INVALID_OPTION = createError(
  'FST_ERR_SSE_INVALID_OPTION',
  "@fastify/sse: unsupported value for route option 'sse': %s. Use true, 'dual', 'only', or an options object."
)

const FST_ERR_SSE_LEGACY_MISUSE = createError(
  'FST_ERR_SSE_LEGACY_MISUSE',
  "@fastify/sse: route registered with { sse: true } received Accept '%s' (no explicit 'text/event-stream') " +
  'and the handler then tried to use reply.sse. If this route only serves SSE, ' +
  "register it with { sse: 'only' } so ambiguous Accept headers admit SSE per " +
  'RFC 9110. If it serves both SSE and a non-SSE representation, register with ' +
  "{ sse: 'dual' } and branch on the Accept header in the handler. " +
  '(Underlying error: %s)'
)

const FST_ERR_SSE_CONNECTION_CLOSED = createError(
  'FST_ERR_SSE_CONNECTION_CLOSED',
  'SSE connection is closed'
)

// Character codes used by the Accept-header scanner. Hoisted to module scope
// so V8 treats them as constants and the tight loops below stay monomorphic.
const CC_SP = 32
const CC_HT = 9
const CC_COMMA = 44
const CC_SEMI = 59
const CC_EQ = 61
const CC_DOT = 46
const CC_ZERO = 48
const CC_LOWER_Q = 113
const CC_UPPER_Q = 81

function ciEqualsAt (s, start, end, lower) {
  if (end - start !== lower.length) return false
  for (let j = 0; j < lower.length; j++) {
    let c = s.charCodeAt(start + j)
    if (c >= 65 && c <= 90) c |= 32
    if (c !== lower.charCodeAt(j)) return false
  }
  return true
}

function isQValueZero (s, start, end) {
  if (end <= start) return false
  if (s.charCodeAt(start) !== CC_ZERO) return false
  let i = start + 1
  if (i < end && s.charCodeAt(i) === CC_DOT) {
    i++
    while (i < end) {
      if (s.charCodeAt(i) !== CC_ZERO) return false
      i++
    }
  }
  return i === end
}

/**
 * Determine whether the client's Accept header admits `text/event-stream`.
 *
 * Implements the RFC 9110 §12.5.1 precedence model for the media ranges that
 * are relevant to SSE — `text/event-stream`, `text/*`, and `*\/*`. Other
 * media-type parameters are ignored; only the `q` parameter is honored, and
 * only the binary distinction `q=0` (explicit refuse) vs `q>0` (admit) is
 * preserved. Fractional qvalues like `q=0.5` are treated identically to
 * `q=1`: observably equivalent here because the function picks the winning
 * media range by specificity, not by comparing fractional qvalues.
 *
 * Default (lenient) returns true when the header is missing, empty, or
 * contains a matching range with quality > 0. The most specific matching
 * range wins, so `*\/*, text/event-stream;q=0` correctly returns false.
 *
 * Pass `{ strict: true }` to require an explicit `text/event-stream` token
 * with quality > 0; ambiguous headers (`*\/*`, `text/*`, missing) return
 * false in strict mode.
 *
 * Hot paths (`text/event-stream`, `*\/*`, `text/*`) short-circuit before any
 * scanning, so the common case is a single string-equality compare.
 *
 * @param {string|undefined} acceptHeader
 * @param {{ strict?: boolean }} [options]
 * @returns {boolean}
 */
function clientAcceptsSSE (acceptHeader, options) {
  const strict = options !== undefined && options.strict === true
  if (!acceptHeader) return !strict

  // Hot path: the literal values that EventSource and common HTTP clients
  // actually emit. Caught with a single ===, no allocation.
  if (acceptHeader === 'text/event-stream') return true
  if (!strict && (acceptHeader === '*/*' || acceptHeader === 'text/*')) return true

  // Slow path: walk the header in place via charCodeAt. No .split(),
  // no .toLowerCase(), no .trim(), no substrings allocated.
  const len = acceptHeader.length
  let bestSpec = -1
  let bestRefused = false
  let i = 0

  while (i < len) {
    while (i < len) {
      const c = acceptHeader.charCodeAt(i)
      if (c !== CC_SP && c !== CC_HT) break
      i++
    }

    const typeStart = i
    while (i < len) {
      const c = acceptHeader.charCodeAt(i)
      if (c === CC_SEMI || c === CC_COMMA) break
      i++
    }
    let typeEnd = i
    while (typeEnd > typeStart) {
      const c = acceptHeader.charCodeAt(typeEnd - 1)
      if (c !== CC_SP && c !== CC_HT) break
      typeEnd--
    }

    let spec = -1
    if (ciEqualsAt(acceptHeader, typeStart, typeEnd, 'text/event-stream')) spec = 3
    else if (!strict && ciEqualsAt(acceptHeader, typeStart, typeEnd, 'text/*')) spec = 2
    else if (!strict && ciEqualsAt(acceptHeader, typeStart, typeEnd, '*/*')) spec = 1

    let refused = false
    if (spec === -1) {
      // Non-matching entry: skip its parameters in one jump.
      while (i < len && acceptHeader.charCodeAt(i) !== CC_COMMA) i++
    } else {
      // Spec note: per RFC 9110 §5.6.6, `parameter = parameter-name "="
      // parameter-value` permits no OWS inside the parameter — only around
      // the `;` separator. We honor the OWS-around-`;` case (which browsers
      // emit as `; q=0.8`) but do not handle OWS adjacent to `=` or
      // trailing OWS on the value/key (which would be malformed input
      // anyway). Node's HTTP parser also strips leading + trailing OWS
      // from the whole header value, so the only WS we see in production
      // is OWS after `,` and after `;`.
      while (i < len && acceptHeader.charCodeAt(i) === CC_SEMI) {
        i++
        while (i < len) {
          const c = acceptHeader.charCodeAt(i)
          if (c !== CC_SP && c !== CC_HT) break
          i++
        }
        const keyStart = i
        while (i < len) {
          const c = acceptHeader.charCodeAt(i)
          if (c === CC_EQ || c === CC_SEMI || c === CC_COMMA) break
          i++
        }
        const keyEnd = i

        if (i < len && acceptHeader.charCodeAt(i) === CC_EQ) {
          i++
          const valStart = i
          while (i < len) {
            const c = acceptHeader.charCodeAt(i)
            if (c === CC_SEMI || c === CC_COMMA) break
            i++
          }
          const valEnd = i

          if (keyEnd - keyStart === 1) {
            const kc = acceptHeader.charCodeAt(keyStart)
            if ((kc === CC_LOWER_Q || kc === CC_UPPER_Q) &&
                isQValueZero(acceptHeader, valStart, valEnd)) {
              refused = true
            }
          }
        }
      }
    }

    // text/event-stream with a non-refused qvalue has the maximum
    // specificity; nothing later in the list can outrank it.
    if (spec === 3 && !refused) return true

    if (spec > bestSpec) {
      bestSpec = spec
      bestRefused = refused
    }

    if (i < len && acceptHeader.charCodeAt(i) === CC_COMMA) i++
  }

  return bestSpec >= 0 && !bestRefused
}

/**
 * Resolve the `sse` field on route options into a normalized shape.
 *
 *   - `sse: true`     → kind 'legacy' (back-compat, strict gate + clearer
 *                       error if the handler tries to use reply.sse on the
 *                       fallback path)
 *   - `sse: 'dual'`   → kind 'dual'  (explicit dual-mode: strict gate, the
 *                       handler is expected to serve a non-SSE response when
 *                       reply.sse is undefined)
 *   - `sse: 'only'`   → kind 'only'  (SSE-only: lenient gate, returns 406
 *                       Not Acceptable to clients that explicitly refuse SSE)
 *   - `sse: { ... }`  → object form; same kinds via `kind: 'dual' | 'only'`,
 *                       or `kind` omitted = 'legacy' for back-compat with
 *                       existing `{ heartbeat, serializer, ... }` shapes
 */
function resolveSSEConfig (sseField) {
  if (sseField === true) return { kind: 'legacy', options: {} }
  if (sseField === 'dual') return { kind: 'dual', options: {} }
  if (sseField === 'only') return { kind: 'only', options: {} }
  if (typeof sseField === 'object' && sseField !== null) {
    const kind = sseField.kind ?? 'legacy'
    if (kind !== 'legacy' && kind !== 'dual' && kind !== 'only') {
      throw new FST_ERR_SSE_UNKNOWN_KIND(kind)
    }
    return { kind, options: sseField }
  }
  throw new FST_ERR_SSE_INVALID_OPTION(JSON.stringify(sseField))
}

const MISSING_SSE_ERROR_PATTERN = /Cannot read prop(?:erties)? of undefined.*'(?:send|stream|keepAlive|close|sendHeaders|replay|onClose)'/

/**
 * Format an SSE message according to the specification
 * @param {Object|string|Buffer} message - The message to format
 * @param {Function} serializer - Function to serialize data
 * @returns {string} Formatted SSE message
 */
function formatSSEMessage (message, serializer) {
  let payload = ''

  if (typeof message === 'string') {
    // Plain string message
    for (const line of message.split('\n')) {
      payload += `data: ${line}\n`
    }
  } else if (Buffer.isBuffer(message)) {
    // Buffer message
    const str = message.toString('utf-8')
    for (const line of str.split('\n')) {
      payload += `data: ${line}\n`
    }
  } else {
    // SSEMessage object
    if (message.id) {
      payload += `id: ${message.id}\n`
    }

    if (message.event) {
      payload += `event: ${message.event}\n`
    }

    if (message.data !== undefined) {
      // Always serialize the data to ensure consistent format
      const dataStr = serializer(message.data)

      for (const line of dataStr.split('\n')) {
        payload += `data: ${line}\n`
      }
    }

    if (message.retry) {
      payload += `retry: ${message.retry}\n`
    }
  }

  // Add trailing newline to separate events
  if (payload) {
    payload += '\n'
  }

  return payload
}

/**
 * Create a transform stream that converts objects to SSE format
 * @param {Object} options - Transform options
 * @returns {Transform} Transform stream
 */
function createSSETransformStream (options = {}) {
  const { serializer = JSON.stringify } = options

  return new Transform({
    objectMode: true,
    transform (chunk, encoding, callback) {
      try {
        const formatted = formatSSEMessage(chunk, serializer)
        callback(null, formatted)
      } catch (error) {
        callback(error)
      }
    }
  })
}

/**
 * SSE Context class for managing connection state
 */
class SSEContext {
  #lastEventId
  #isConnected
  #keepAlive
  #headersSent

  constructor (options) {
    this.reply = options.reply
    this.#lastEventId = options.lastEventId || null
    this.#isConnected = true
    this.#keepAlive = false
    this.#headersSent = false
    this.heartbeatTimer = null
    this.closeCallbacks = []
    this.serializer = options.serializer

    // Set up connection close handler
    this.reply.raw.on('close', () => {
      this.#isConnected = false
      this.cleanup()
    })

    // Handle errors on the raw response to prevent uncaught exceptions
    this.reply.raw.on('error', (error) => {
      // Client disconnection is expected behavior, handle gracefully
      this.#isConnected = false
      this.cleanup()
      // Log as info since client disconnections are normal
      this.reply.log.info({ err: error }, 'SSE connection closed')
    })

    // Start heartbeat if enabled
    if (options.heartbeatInterval > 0) {
      this.startHeartbeat(options.heartbeatInterval)
    }
  }

  /**
   * Gets the last event ID from the client's Last-Event-ID header.
   * @returns {string|null} The last event ID or null if not present
   */
  get lastEventId () {
    return this.#lastEventId
  }

  /**
   * Checks if the SSE connection is still active.
   * @returns {boolean} True if connected, false otherwise
   */
  get isConnected () {
    return this.#isConnected
  }

  /**
   * Checks if the connection should be kept alive after handler completion.
   * @returns {boolean} True if connection should be kept alive
   */
  get shouldKeepAlive () {
    return this.#keepAlive
  }

  /**
   * Marks the connection to be kept alive after the handler completes.
   * Without calling this, the connection will close after the handler returns.
   */
  keepAlive () {
    this.#keepAlive = true
  }

  /**
   * Closes the SSE connection and performs cleanup.
   * Safe to call multiple times.
   *
   * If no SSE data was ever written (i.e., headers were never committed as
   * SSE), the raw response is left open so Fastify can serialize the
   * handler's return value normally.
   */
  close () {
    if (!this.#isConnected) return

    this.#isConnected = false
    this.cleanup()
    if (this.#headersSent) {
      this.reply.raw.end()
    }
  }

  /**
   * Registers a callback to be called when the connection closes.
   * @param {Function} callback - Function to call on connection close
   */
  onClose (callback) {
    this.closeCallbacks.push(callback)
  }

  /**
   * Executes a callback with the last event ID for replay functionality.
   * Only calls the callback if a last event ID exists.
   * @param {Function} callback - Async function that receives the last event ID
   */
  async replay (callback) {
    if (!this.#lastEventId) return

    await callback(this.#lastEventId)
  }

  /**
   * Sends HTTP headers for the SSE response if not already sent.
   * Applies the SSE-specific response headers, transfers any headers set
   * via reply.header(), and calls writeHead(200). Called automatically
   * before the first SSE data is sent, but can also be called manually.
   *
   * Until this fires, the response is not yet committed as SSE — a handler
   * that never writes SSE data will return through Fastify's normal
   * serialization path.
   */
  sendHeaders () {
    if (!this.#headersSent) {
      this.reply.raw.setHeader('Content-Type', 'text/event-stream')
      this.reply.raw.setHeader('Cache-Control', 'no-cache')
      this.reply.raw.setHeader('Connection', 'keep-alive')
      this.reply.raw.setHeader('X-Accel-Buffering', 'no') // Disable Nginx buffering

      // Transfer headers set via reply.header() to the raw response
      const replyHeaders = this.reply.getHeaders()
      for (const [name, value] of Object.entries(replyHeaders)) {
        this.reply.raw.setHeader(name, value)
      }

      this.reply.raw.writeHead(200)
      this.#headersSent = true
    }
  }

  /**
   * Sends SSE data from various source types.
   * @param {string|Buffer|Object|ReadableStream|AsyncIterable} source - The data source to send
   * @throws {Error} If connection is closed
   * @throws {TypeError} If source type is invalid
   */
  async send (source) {
    if (!this.#isConnected) {
      throw new FST_ERR_SSE_CONNECTION_CLOSED()
    }

    // Handle single message
    if (typeof source === 'string' || Buffer.isBuffer(source) || this.isSSEMessage(source)) {
      const formatted = formatSSEMessage(source, this.serializer)
      await this.writeToStream(formatted)
      return
    }

    // Handle Readable stream
    if (source instanceof Readable) {
      this.sendHeaders()

      const transform = createSSETransformStream({ serializer: this.serializer })
      try {
        await pipeline(source, transform, this.reply.raw, { end: false })
      } catch (error) {
        // Distinguish between expected disconnection errors and unexpected errors
        this.#isConnected = false
        this.cleanup()
        if (error && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
          this.reply.log.info({ err: error }, 'SSE stream ended (client disconnected)')
        } else {
          this.reply.log.error({ err: error }, 'Unexpected error in SSE stream')
        }
        return
      }
      return
    }

    // Handle AsyncIterable
    if (this.isAsyncIterable(source)) {
      for await (const chunk of source) {
        if (!this.#isConnected) break
        const formatted = formatSSEMessage(chunk, this.serializer)
        await this.writeToStream(formatted)
      }
      return
    }

    throw new TypeError('Invalid SSE source type')
  }

  /**
   * Creates a transform stream for SSE formatting.
   * The returned stream automatically sends headers on first write.
   * @returns {Transform} A transform stream that formats data as SSE
   * @throws {Error} If connection is closed
   */
  stream () {
    if (!this.#isConnected) {
      throw new FST_ERR_SSE_CONNECTION_CLOSED()
    }

    const transform = createSSETransformStream({ serializer: this.serializer })

    // Wrap the transform to send headers on first write
    const originalWrite = transform._write
    transform._write = (chunk, encoding, callback) => {
      this.sendHeaders()
      originalWrite.call(transform, chunk, encoding, callback)
    }

    return transform
  }

  /**
   * Writes data to the response stream with backpressure handling.
   * @param {string|Buffer} data - The data to write
   * @returns {Promise<void>} Resolves when data is written
   * @private
   */
  writeToStream (data) {
    return new Promise((resolve, reject) => {
      if (!this.#isConnected) {
        reject(new Error('SSE connection is closed'))
        return
      }

      // Send headers on first write
      this.sendHeaders()

      const canWrite = this.reply.raw.write(data)

      if (canWrite) {
        resolve()
      } else {
        // Handle backpressure
        const onDrain = () => {
          this.reply.raw.off('error', onError)
          resolve()
        }

        const onError = (err) => {
          this.reply.raw.off('drain', onDrain)
          // Handle all errors gracefully - client disconnection is normal
          this.#isConnected = false
          this.cleanup()
          this.reply.log.info({ err }, 'SSE write ended')
          resolve() // Resolve instead of reject for graceful handling
        }

        this.reply.raw.once('drain', onDrain)
        this.reply.raw.once('error', onError)
      }
    })
  }

  /**
   * Starts sending periodic heartbeat messages to keep the connection alive.
   * @param {number} interval - Heartbeat interval in milliseconds
   * @private
   */
  startHeartbeat (interval) {
    this.heartbeatTimer = setInterval(() => {
      if (this.#isConnected) {
        this.sendHeaders()
        this.reply.raw.write(': heartbeat\n\n')
      } else {
        this.stopHeartbeat()
      }
    }, interval)

    // Ensure timer doesn't keep process alive
    this.heartbeatTimer.unref()
  }

  /**
   * Stops the heartbeat timer.
   * @private
   */
  stopHeartbeat () {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * Performs cleanup operations when the connection closes.
   * Stops heartbeat and executes all registered close callbacks.
   * @private
   */
  cleanup () {
    this.stopHeartbeat()

    // Call all close callbacks
    for (const callback of this.closeCallbacks) {
      try {
        callback()
      } catch (error) {
        // Log error but don't throw
        console.error('Error in SSE close callback:', error)
      }
    }

    this.closeCallbacks = []
  }

  /**
   * Checks if a value is a valid SSE message object.
   * @param {*} value - The value to check
   * @returns {boolean} True if value is an SSE message object
   * @private
   */
  isSSEMessage (value) {
    return typeof value === 'object' &&
           value !== null &&
           'data' in value
  }

  /**
   * Checks if a value is an async iterable.
   * @param {*} value - The value to check
   * @returns {boolean} True if value is async iterable
   * @private
   */
  isAsyncIterable (value) {
    return value != null &&
           typeof value[Symbol.asyncIterator] === 'function'
  }
}

async function fastifySSE (fastify, opts) {
  const {
    heartbeatInterval = 30000,
    serializer = JSON.stringify
  } = opts

  // Add route-level SSE handler
  fastify.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.sse) return

    const { kind, options: sseOptions } = resolveSSEConfig(routeOptions.sse)
    const originalHandler = routeOptions.handler

    routeOptions.handler = async function sseHandler (request, reply) {
      const acceptHeader = request.headers.accept

      // Kind-specific gate.
      //   'only'  — SSE-only route. Lenient gate: any spec-compliant Accept
      //             admits SSE. Clients that explicitly refuse SSE get 406.
      //   'dual'  — Route serves both SSE and non-SSE on the same handler.
      //             Strict gate: only an explicit `text/event-stream` token
      //             admits SSE; everything else falls through to the
      //             handler, which is expected to serve a non-SSE response.
      //   'legacy' — `sse: true` back-compat. Same routing as 'dual'. If
      //              the fallback handler then tries to use `reply.sse`
      //              (which is undefined because the gate refused), the
      //              plugin rethrows with a message that names
      //              `sse: 'only'` as the likely fix.
      if (kind === 'only') {
        if (!clientAcceptsSSE(acceptHeader)) {
          return reply.code(406).type('application/json').send({
            statusCode: 406,
            error: 'Not Acceptable',
            message: "This endpoint only produces 'text/event-stream'."
          })
        }
        // Fall through to SSE setup.
      } else {
        // 'dual' or 'legacy'
        if (!clientAcceptsSSE(acceptHeader, { strict: true })) {
          if (kind === 'legacy') {
            try {
              return await originalHandler.call(this, request, reply)
            } catch (err) {
              if (err instanceof TypeError && MISSING_SSE_ERROR_PATTERN.test(err.message)) {
                throw new FST_ERR_SSE_LEGACY_MISUSE(acceptHeader || '<missing>', err.message)
              }
              throw err
            }
          }
          // 'dual' — handler intentionally handles the fallback.
          return await originalHandler.call(this, request, reply)
        }
        // Fall through to SSE setup.
      }

      // Set up SSE context. Headers are written lazily on the first send.
      const context = new SSEContext({
        reply,
        lastEventId: request.headers['last-event-id'],
        heartbeatInterval: sseOptions.heartbeat !== false ? heartbeatInterval : 0,
        serializer: sseOptions.serializer || serializer
      })

      // Store context on reply
      reply.sse = context

      let res
      try {
        res = await originalHandler.call(this, request, reply)
      } catch (error) {
        if (!context.shouldKeepAlive) {
          context.close()
        }
        throw error
      }

      if (!context.shouldKeepAlive) {
        context.close()
      }

      return res
    }
  })
}

module.exports = fp(fastifySSE, {
  fastify: '5.x',
  name: '@fastify/sse'
})
module.exports.default = fastifySSE
module.exports.fastifySSE = fastifySSE
