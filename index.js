'use strict'

const fp = require('fastify-plugin')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')

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
   */
  close () {
    if (!this.#isConnected) return

    this.#isConnected = false
    this.cleanup()
    this.reply.raw.end()
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
   * This method ensures headers set via reply.header() are transferred
   * to the raw response before calling writeHead(200).
   * Called automatically before the first SSE data is sent, but can
   * also be called manually if needed.
   */
  sendHeaders () {
    if (!this.#headersSent) {
      // Get any headers set via reply.header() and transfer to raw response
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
      throw new Error('SSE connection is closed')
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
      throw new Error('SSE connection is closed')
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

/**
 * Determine whether the client's Accept header admits `text/event-stream`.
 *
 * Implements the RFC 9110 §12.5.1 precedence model for the media ranges that
 * are relevant to SSE — `text/event-stream`, `text/*`, and `*\/*`. Other
 * media-type parameters are ignored; only the `q` parameter is honored.
 *
 * Default (lenient) behavior returns true when:
 *   - Accept is missing or empty (any media type is acceptable),
 *   - `text/event-stream`, `text/*`, or `*\/*` appears with a quality > 0
 *     and is the most specific match present in the header.
 *
 * Pass `{ strict: true }` to require an explicit `text/event-stream` token
 * with quality > 0; ambiguous headers (`*\/*`, `text/*`, missing) return
 * false in strict mode.
 *
 * The most specific matching range wins (exact > subtype wildcard > full
 * wildcard), so `*\/*, text/event-stream;q=0` correctly returns false.
 *
 * Quality values outside [0, 1] are ignored and the entry's quality defaults
 * to 1 (the spec default when no qvalue is present).
 *
 * @param {string|undefined} acceptHeader
 * @param {{ strict?: boolean }} [options]
 * @returns {boolean}
 */
function clientAcceptsSSE (acceptHeader, options) {
  const strict = options?.strict === true
  if (!acceptHeader) return !strict

  let bestSpecificity = -1
  let bestQuality = 0

  for (const part of acceptHeader.split(',')) {
    const [rawType, ...params] = part.split(';')
    const type = rawType.trim().toLowerCase()

    let specificity
    if (type === 'text/event-stream') specificity = 3
    else if (!strict && type === 'text/*') specificity = 2
    else if (!strict && type === '*/*') specificity = 1
    else continue

    let quality = 1
    for (const p of params) {
      const eq = p.indexOf('=')
      if (eq === -1) continue
      const key = p.slice(0, eq).trim().toLowerCase()
      if (key !== 'q') continue
      const parsed = Number.parseFloat(p.slice(eq + 1).trim())
      // Per RFC 9110, qvalue is in [0, 1]; anything else is invalid and
      // ignored (the entry's quality stays at the default of 1).
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
        quality = parsed
      }
    }

    if (specificity > bestSpecificity) {
      bestSpecificity = specificity
      bestQuality = quality
    }
  }

  return bestSpecificity >= 0 && bestQuality > 0
}

async function fastifySSE (fastify, opts) {
  const {
    heartbeatInterval = 30000,
    serializer = JSON.stringify,
    strictAccept: pluginStrictAccept = false
  } = opts

  // Add route-level SSE handler
  fastify.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.sse) return

    const originalHandler = routeOptions.handler
    const sseOptions = typeof routeOptions.sse === 'object' ? routeOptions.sse : {}
    const strictAccept = sseOptions.strictAccept ?? pluginStrictAccept

    routeOptions.handler = async function sseHandler (request, reply) {
      // Decide whether to handle this request as SSE.
      //   - Default (strictAccept: false): spec-compliant per RFC 9110 —
      //     admit SSE for `text/event-stream`, `text/*`, `*\/*`, and missing
      //     Accept.
      //   - strictAccept: true — require an explicit `text/event-stream`
      //     token; ambiguous headers (`*\/*`, `text/*`, missing) fall through.
      if (!clientAcceptsSSE(request.headers.accept, { strict: strictAccept })) {
        return await originalHandler.call(this, request, reply)
      }

      // Set up SSE response
      reply.raw.setHeader('Content-Type', 'text/event-stream')
      reply.raw.setHeader('Cache-Control', 'no-cache')
      reply.raw.setHeader('Connection', 'keep-alive')
      reply.raw.setHeader('X-Accel-Buffering', 'no') // Disable Nginx buffering

      // Create SSE context
      const context = new SSEContext({
        reply,
        lastEventId: request.headers['last-event-id'],
        heartbeatInterval: sseOptions.heartbeat !== false ? heartbeatInterval : 0,
        serializer: sseOptions.serializer || serializer
      })

      // Store context on reply
      reply.sse = context

      let res
      // Call original handler with SSE-enabled reply
      // Note: Headers will be sent on first SSE send
      try {
        res = await originalHandler.call(this, request, reply)
      } catch (error) {
        // If handler doesn't call keepAlive, close connection
        if (!context.shouldKeepAlive) {
          context.close()
        }
        throw error
      }

      // If handler doesn't call keepAlive, close connection
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
module.exports.clientAcceptsSSE = clientAcceptsSSE
module.exports.fastifySSE = fastifySSE
