'use strict'

const fp = require('fastify-plugin')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')

const SSE_DECORATOR = Symbol.for('@fastify/sse.decorator')
const SSE_CONTEXT = Symbol.for('@fastify/sse.context')

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
  constructor (options) {
    this.reply = options.reply
    this._lastEventId = options.lastEventId || null
    this._isConnected = true
    this._keepAlive = false
    this._headersSent = false
    this.heartbeatTimer = null
    this.closeCallbacks = []
    this.serializer = options.serializer

    // Set up connection close handler
    this.reply.raw.on('close', () => {
      this._isConnected = false
      this.cleanup()
    })

    // Start heartbeat if enabled
    if (options.heartbeatInterval > 0) {
      this.startHeartbeat(options.heartbeatInterval)
    }
  }

  get lastEventId () {
    return this._lastEventId
  }

  get isConnected () {
    return this._isConnected
  }

  keepAlive () {
    this._keepAlive = true
  }

  close () {
    if (!this._isConnected) return

    this._isConnected = false
    this.cleanup()
    this.reply.raw.end()
  }

  onClose (callback) {
    this.closeCallbacks.push(callback)
  }

  async replay (callback) {
    if (!this._lastEventId) return

    await callback(this._lastEventId)
  }

  async send (source) {
    if (!this._isConnected) {
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
      // Send headers if not yet sent
      if (!this._headersSent) {
        // Get any headers set via reply.header() and transfer to raw response
        const replyHeaders = this.reply.getHeaders()
        for (const [name, value] of Object.entries(replyHeaders)) {
          this.reply.raw.setHeader(name, value)
        }

        this.reply.raw.writeHead(200)
        this._headersSent = true
      }

      const transform = createSSETransformStream({ serializer: this.serializer })
      await pipeline(source, transform, this.reply.raw, { end: false })
      return
    }

    // Handle AsyncIterable
    if (this.isAsyncIterable(source)) {
      for await (const chunk of source) {
        if (!this._isConnected) break
        const formatted = formatSSEMessage(chunk, this.serializer)
        await this.writeToStream(formatted)
      }
      return
    }

    throw new TypeError('Invalid SSE source type')
  }

  stream () {
    if (!this._isConnected) {
      throw new Error('SSE connection is closed')
    }

    const transform = createSSETransformStream({ serializer: this.serializer })

    // Wrap the transform to send headers on first write
    const originalWrite = transform._write
    transform._write = (chunk, encoding, callback) => {
      // Send headers if not yet sent
      if (!this._headersSent) {
        // Get any headers set via reply.header() and transfer to raw response
        const replyHeaders = this.reply.getHeaders()
        for (const [name, value] of Object.entries(replyHeaders)) {
          this.reply.raw.setHeader(name, value)
        }

        this.reply.raw.writeHead(200)
        this._headersSent = true
      }
      originalWrite.call(transform, chunk, encoding, callback)
    }

    return transform
  }

  writeToStream (data) {
    return new Promise((resolve, reject) => {
      if (!this._isConnected) {
        reject(new Error('SSE connection is closed'))
        return
      }

      // Send headers on first write
      if (!this._headersSent) {
        // Get any headers set via reply.header() and transfer to raw response
        const replyHeaders = this.reply.getHeaders()
        for (const [name, value] of Object.entries(replyHeaders)) {
          this.reply.raw.setHeader(name, value)
        }

        this.reply.raw.writeHead(200)
        this._headersSent = true
      }

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
          reject(err)
        }

        this.reply.raw.once('drain', onDrain)
        this.reply.raw.once('error', onError)
      }
    })
  }

  startHeartbeat (interval) {
    this.heartbeatTimer = setInterval(() => {
      if (this._isConnected) {
        // Send headers if not yet sent
        if (!this._headersSent) {
          // Get any headers set via reply.header() and transfer to raw response
          const replyHeaders = this.reply.getHeaders()
          for (const [name, value] of Object.entries(replyHeaders)) {
            this.reply.raw.setHeader(name, value)
          }

          this.reply.raw.writeHead(200)
          this._headersSent = true
        }
        this.reply.raw.write(': heartbeat\n\n')
      } else {
        this.stopHeartbeat()
      }
    }, interval)

    // Ensure timer doesn't keep process alive
    this.heartbeatTimer.unref()
  }

  stopHeartbeat () {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

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

  isSSEMessage (value) {
    return typeof value === 'object' &&
           value !== null &&
           'data' in value
  }

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

    const originalHandler = routeOptions.handler
    const sseOptions = typeof routeOptions.sse === 'object' ? routeOptions.sse : {}

    routeOptions.handler = async function sseHandler (request, reply) {
      // Check if client accepts SSE
      const acceptHeader = request.headers.accept || ''
      if (!acceptHeader.includes('text/event-stream')) {
        // Fall back to regular handler for non-SSE requests
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
      reply[SSE_CONTEXT] = context

      // Decorate reply with SSE interface
      const sseInterface = {}

      // Add SSE methods
      Object.defineProperty(sseInterface, 'lastEventId', {
        get: () => context.lastEventId
      })

      sseInterface.send = (source) => context.send(source)
      sseInterface.stream = () => context.stream()
      sseInterface.keepAlive = () => context.keepAlive()
      sseInterface.close = () => context.close()
      sseInterface.replay = (callback) => context.replay(callback)
      sseInterface.onClose = (callback) => context.onClose(callback)

      Object.defineProperty(sseInterface, 'isConnected', {
        get: () => context.isConnected
      })

      reply[SSE_DECORATOR] = sseInterface
      Object.defineProperty(reply, 'sse', {
        get () { return this[SSE_DECORATOR] }
      })

      // Call original handler with SSE-enabled reply
      // Note: Headers will be sent on first SSE send
      try {
        await originalHandler.call(this, request, reply)
      } catch (error) {
        // If handler doesn't call keepAlive, close connection
        if (!reply[SSE_CONTEXT]?._keepAlive) {
          reply[SSE_CONTEXT]?.close()
        }
        throw error
      }

      // If handler doesn't call keepAlive, close connection
      if (!reply[SSE_CONTEXT]?._keepAlive) {
        reply[SSE_CONTEXT]?.close()
      }
    }
  })
}

module.exports = fp(fastifySSE, {
  fastify: '5.x',
  name: '@fastify/sse'
})
