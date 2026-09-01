'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const { Readable } = require('node:stream')
const { setTimeout: sleep } = require('node:timers/promises')
const Fastify = require('fastify')
const fastifySSE = require('../index.js')

async function buildApp (t, options = {}) {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  await app.register(fastifySSE, options)
  return app
}

function createErrorStream (message, code) {
  return new Readable({
    read () {
      const error = new Error(message)
      if (code) error.code = code
      this.destroy(error)
    }
  })
}

test('formats multiline Buffer messages', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse.send(Buffer.from('first\nsecond'))
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.body, 'data: first\ndata: second\n\n')
})

test('leaves ordinary routes alone and falls back when Accept is missing', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/plain', async () => ({ plain: true }))
  app.get('/events', { sse: true }, async (request, reply) => {
    return { fallback: reply.sse === undefined }
  })

  const plainResponse = await app.inject({ url: '/plain' })
  const fallbackResponse = await app.inject({ url: '/events' })

  assert.deepStrictEqual(plainResponse.json(), { plain: true })
  assert.deepStrictEqual(fallbackResponse.json(), { fallback: true })
})

test('parses SSE Accept parameters and optional whitespace', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/events', { sse: 'only' }, async (request, reply) => {
    await reply.sse.send({ data: 'accepted' })
  })

  const cases = [
    ['TEXT/EVENT-STREAM', 200],
    ['text/event-streax', 406],
    ['text/event-stream;q=', 200],
    ['text/event-stream;q=1', 200],
    ['text/event-stream;q=0.00', 406],
    ['text/event-stream;q=0.01', 200],
    ['text/event-stream ;q=0', 406],
    ['text/*;q=0', 406],
    ['application/json;foo=bar, text/event-stream', 200],
    ['text/event-stream; q=0', 406],
    ['text/event-stream;q=0;foo=bar', 406],
    ['text/event-stream;Q=0', 406]
  ]

  for (const [accept, expectedStatus] of cases) {
    const response = await app.inject({
      url: '/events',
      headers: { accept }
    })

    assert.strictEqual(response.statusCode, expectedStatus, accept)
  }
})

test('rejects unsupported route option values', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  assert.throws(
    () => app.get('/invalid', { sse: 42 }, async () => {}),
    /unsupported value for route option 'sse': 42/
  )
})

test('preserves legacy fallback errors and describes missing Accept misuse', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/misuse', { sse: true }, async (request, reply) => {
    await reply.sse.send({ data: 'value' })
  })

  app.get('/failure', { sse: true }, async () => {
    throw new Error('fallback failed')
  })

  const misuseResponse = await app.inject({ url: '/misuse' })
  const failureResponse = await app.inject({ url: '/failure' })

  assert.strictEqual(misuseResponse.statusCode, 500)
  assert.match(misuseResponse.body, /<missing>/)
  assert.strictEqual(failureResponse.statusCode, 500)
  assert.match(failureResponse.body, /fallback failed/)
})

test('falls back to status 200 when no response status is available', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/events', { sse: 'only' }, async (request, reply) => {
    Object.defineProperty(reply.raw, 'statusCode', {
      configurable: true,
      writable: true,
      value: undefined
    })
    reply.sse.sendHeaders()
  })

  const response = await app.inject({ url: '/events' })

  assert.strictEqual(response.statusCode, 200)
})

test('supports route-level serializer and disabled heartbeat options', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 1 })
  let context

  app.get('/events', {
    sse: {
      heartbeat: false,
      serializer: (data) => `route:${data}`
    }
  }, async (request, reply) => {
    context = reply.sse
    reply.sse.keepAlive()
    await reply.sse.send({ data: 'value' })
    setTimeout(() => reply.sse.close(), 20)
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.body, 'data: route:value\n\n')
  assert.strictEqual(context.heartbeatTimer, null)
})

test('handles replay without an event ID and rejects invalid sources', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })
  let replayCalls = 0

  app.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse.replay(async () => {
      replayCalls++
    })

    for (const source of [null, 42, {}]) {
      await assert.rejects(
        () => reply.sse.send(source),
        { name: 'TypeError', message: 'Invalid SSE source type' }
      )
    }

    await reply.sse.send({ data: 'valid' })
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(replayCalls, 0)
  assert.match(response.body, /data: "valid"/)
})

test('closed contexts reject writes and stop restarted heartbeats', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })
  let context

  app.get('/events', { sse: true }, async (request, reply) => {
    context = reply.sse
    reply.sse.close()
    reply.sse.close()

    assert.throws(
      () => reply.sse.stream(),
      { message: 'SSE connection is closed' }
    )
    await assert.rejects(
      () => reply.sse.send({ data: 'late' }),
      { message: 'SSE connection is closed' }
    )
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(context.isConnected, false)

  context.startHeartbeat(1)
  await sleep(20)
  assert.strictEqual(context.heartbeatTimer, null)
})

test('detects a connection closed synchronously by the serializer', async (t) => {
  let context
  const app = await buildApp(t, {
    heartbeatInterval: 0,
    serializer (data) {
      context.close()
      return JSON.stringify(data)
    }
  })

  app.get('/events', { sse: true }, async (request, reply) => {
    context = reply.sse
    await assert.rejects(
      () => reply.sse.send({ data: 'value' }),
      { message: 'SSE connection is closed' }
    )
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(context.isConnected, false)
})

test('stops an async iterable when the connection closes', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/events', { sse: true }, async (request, reply) => {
    async function * events () {
      yield { data: 'first' }
      reply.sse.close()
      yield { data: 'second' }
    }

    await reply.sse.send(events())
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.match(response.body, /data: "first"/)
  assert.doesNotMatch(response.body, /second/)
})

test('reports unexpected transform errors and ends the response', async (t) => {
  const app = await buildApp(t, {
    heartbeatInterval: 0,
    serializer () {
      throw new Error('serialization failed')
    }
  })
  const errorLog = t.mock.fn()

  app.get('/events', { sse: true }, async (request, reply) => {
    reply.log.error = errorLog
    await reply.sse.send(Readable.from([{ data: 'value' }]))
    reply.raw.end()
  })

  await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(errorLog.mock.callCount(), 1)
  assert.strictEqual(
    errorLog.mock.calls[0].arguments[1],
    'Unexpected error in SSE stream'
  )
})

test('reports expected readable stream errors and ends the response', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })
  const infoLog = t.mock.fn()

  app.get('/events', { sse: true }, async (request, reply) => {
    reply.log.info = infoLog
    await reply.sse.send(createErrorStream('client disconnected', 'EPIPE'))
    reply.raw.end()
  })

  await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(infoLog.mock.callCount(), 1)
  assert.strictEqual(
    infoLog.mock.calls[0].arguments[1],
    'SSE stream ended (client disconnected)'
  )
})

test('waits for drain when the response applies backpressure', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })
  let errorListenersBefore
  let errorListenersAfter

  app.get('/events', { sse: true }, async (request, reply) => {
    const raw = reply.raw
    const originalWrite = raw.write
    errorListenersBefore = raw.listenerCount('error')

    raw.write = function (...args) {
      originalWrite.apply(this, args)
      setImmediate(() => raw.emit('drain'))
      return false
    }

    await reply.sse.send({ data: 'backpressure' })
    raw.write = originalWrite
    errorListenersAfter = raw.listenerCount('error')
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.match(response.body, /data: "backpressure"/)
  assert.strictEqual(errorListenersAfter, errorListenersBefore)
})

test('handles a response error while waiting for drain', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })
  const infoLog = t.mock.fn()
  let context

  app.get('/events', { sse: true }, async (request, reply) => {
    context = reply.sse
    reply.log.info = infoLog

    const raw = reply.raw
    const originalWrite = raw.write
    raw.write = function (...args) {
      originalWrite.apply(this, args)
      setImmediate(() => raw.emit('error', new Error('write failed')))
      return false
    }

    await reply.sse.send({ data: 'backpressure' })
    raw.write = originalWrite
    raw.end()
  })

  await assert.rejects(
    () => app.inject({
      url: '/events',
      headers: { accept: 'text/event-stream' }
    }),
    { message: 'write failed' }
  )

  const messages = infoLog.mock.calls.map((call) => call.arguments[1])
  assert.deepStrictEqual(messages, [
    'SSE connection closed',
    'SSE write ended'
  ])
  assert.strictEqual(context.isConnected, false)
})

test('emits heartbeats and clears the timer when closed', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 5 })
  let context

  app.get('/events', { sse: true }, async (request, reply) => {
    context = reply.sse
    reply.sse.sendHeaders()
    reply.sse.keepAlive()
    setTimeout(() => reply.sse.close(), 40)
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.match(response.body, /: heartbeat\n\n/)
  assert.strictEqual(context.heartbeatTimer, null)
})

test('logs close callback failures without preventing cleanup', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })
  const consoleError = t.mock.method(console, 'error', () => {})
  let context

  app.get('/events', { sse: true }, async (request, reply) => {
    context = reply.sse
    reply.sse.onClose(() => {
      throw new Error('close callback failed')
    })
    await reply.sse.send({ data: 'value' })
  })

  await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(consoleError.mock.callCount(), 1)
  assert.strictEqual(context.closeCallbacks.length, 0)
})

test('cleans up when handlers fail with and without keepAlive', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })
  let closedContext
  let keptContext

  app.get('/closed', { sse: true }, async (request, reply) => {
    closedContext = reply.sse
    throw new Error('closed handler failed')
  })

  app.get('/kept', { sse: true }, async (request, reply) => {
    keptContext = reply.sse
    reply.sse.keepAlive()
    throw new Error('kept handler failed')
  })

  const closedResponse = await app.inject({
    url: '/closed',
    headers: { accept: 'text/event-stream' }
  })
  const keptResponse = await app.inject({
    url: '/kept',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(closedResponse.statusCode, 500)
  assert.match(closedResponse.body, /closed handler failed/)
  assert.strictEqual(closedContext.isConnected, false)
  assert.strictEqual(keptResponse.statusCode, 500)
  assert.match(keptResponse.body, /kept handler failed/)
  assert.strictEqual(keptContext.isConnected, false)
})
