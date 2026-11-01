'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const Fastify = require('fastify')
const fastifySSE = require('../index.js')
const { setTimeout: sleep } = require('node:timers/promises')

test('Last-Event-ID header parsing', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    assert.strictEqual(reply.sse.lastEventId, '42')
    await reply.sse.send({ id: '43', data: 'next event' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream',
      'last-event-id': '42'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  const body = response.body
  assert.ok(body.includes('id: 43'))
  assert.ok(body.includes('data: "next event"'))
})

test('replay functionality', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  // Mock event store
  const eventStore = new Map([
    ['1', { id: '1', data: 'first' }],
    ['2', { id: '2', data: 'second' }],
    ['3', { id: '3', data: 'third' }]
  ])

  fastify.get('/events', { sse: true }, async (request, reply) => {
    // Handle replay if lastEventId is present
    await reply.sse.replay(async (lastEventId) => {
      const lastId = parseInt(lastEventId)
      for (const [id, event] of eventStore) {
        if (parseInt(id) > lastId) {
          await reply.sse.send(event)
        }
      }
    })

    // Send new event
    await reply.sse.send({ id: '4', data: 'latest' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream',
      'last-event-id': '1'
    }
  })

  const body = response.body
  // Should replay events 2 and 3, then send event 4
  assert.ok(body.includes('id: 2'))
  assert.ok(body.includes('data: "second"'))
  assert.ok(body.includes('id: 3'))
  assert.ok(body.includes('data: "third"'))
  assert.ok(body.includes('id: 4'))
  assert.ok(body.includes('data: "latest"'))
})

test('connection state during handler execution', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  let connectionStateInHandler = false

  fastify.get('/events', { sse: true }, async (request, reply) => {
    // Check connection state during handler execution
    connectionStateInHandler = reply.sse.isConnected
    await reply.sse.send({ data: 'connected' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)

  // Connection should have been active during handler execution
  assert.strictEqual(connectionStateInHandler, true)
})

test('SSE interface methods exist', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  let sseInterface

  fastify.get('/events', { sse: true }, async (request, reply) => {
    sseInterface = reply.sse

    // Test interface methods exist
    assert.strictEqual(typeof reply.sse.keepAlive, 'function')
    assert.strictEqual(typeof reply.sse.close, 'function')
    assert.strictEqual(typeof reply.sse.replay, 'function')
    assert.strictEqual(typeof reply.sse.onClose, 'function')
    assert.strictEqual(typeof reply.sse.isConnected, 'boolean')

    await reply.sse.send({ data: 'test' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.ok(sseInterface)
})

test('error handling in async iterator', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/error-stream', { sse: true }, async (request, reply) => {
    async function * errorGenerator () {
      yield { id: '1', data: 'before error' }
      throw new Error('Stream error')
    }

    try {
      await reply.sse.send(errorGenerator())
    } catch (error) {
      await reply.sse.send({ data: 'error handled' })
    }
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/error-stream',
    headers: {
      accept: 'text/event-stream'
    }
  })

  const body = response.body
  assert.ok(body.includes('data: "before error"'))
  assert.ok(body.includes('data: "error handled"'))
})

async function buildApp (t, options = {}) {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  await app.register(fastifySSE, options)
  return app
}

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

test('closeOnShutdown closes active keepAlive and streaming SSE contexts on fastify.close()', async () => {
  const app = Fastify({ logger: false })
  await app.register(fastifySSE, {
    heartbeatInterval: 0,
    closeOnShutdown: true
  })

  let keepAliveClosed = false
  let streamClosed = false
  let readyResolve
  const bothReady = new Promise((resolve) => {
    let count = 0
    readyResolve = () => {
      count++
      if (count === 2) resolve()
    }
  })

  app.get('/short', { sse: 'only' }, async (_request, reply) => {
    await reply.sse.send({ data: 'done' })
  })

  app.get('/keep-alive', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive()
    await reply.sse.send({ data: 'connected' })

    const interval = setInterval(() => {
      if (reply.sse.isConnected) {
        reply.sse.send({ data: 'update' })
      }
    }, 50)

    reply.sse.onClose(() => {
      clearInterval(interval)
      keepAliveClosed = true
    })

    readyResolve()
  })

  app.get('/awaited-stream', { sse: 'only' }, async (_request, reply) => {
    let unblock
    const wait = new Promise((resolve) => {
      unblock = resolve
    })

    reply.sse.onClose(() => {
      streamClosed = true
      unblock()
    })

    async function * events () {
      yield { data: 'first' }
      readyResolve()
      await wait
      yield { data: 'second' }
    }

    await reply.sse.send(events())
  })

  const shortResponse = await app.inject({
    url: '/short',
    headers: { accept: 'text/event-stream' }
  })
  assert.strictEqual(shortResponse.statusCode, 200)
  assert.match(shortResponse.body, /data: "done"/)

  const keepAlivePromise = app.inject({
    url: '/keep-alive',
    headers: { accept: 'text/event-stream' }
  })
  const streamPromise = app.inject({
    url: '/awaited-stream',
    headers: { accept: 'text/event-stream' }
  })

  await bothReady

  await app.close()

  const [keepAliveResponse, streamResponse] = await Promise.all([
    keepAlivePromise,
    streamPromise
  ])

  assert.strictEqual(keepAliveClosed, true)
  assert.strictEqual(streamClosed, true)
  assert.strictEqual(keepAliveResponse.statusCode, 200)
  assert.match(keepAliveResponse.body, /data: "connected"/)
  assert.strictEqual(streamResponse.statusCode, 200)
  assert.match(streamResponse.body, /data: "first"/)
  assert.doesNotMatch(streamResponse.body, /second/)
})
