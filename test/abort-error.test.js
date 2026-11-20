'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const { setTimeout: sleep } = require('node:timers/promises')
const Fastify = require('fastify')
const { request } = require('undici')

test('handles body.destroy() without uncaught exception', async (t) => {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  // Register @fastify/sse plugin
  await app.register(require('../index.js'))

  // Simple SSE endpoint that sends data and keeps alive
  app.get('/sse', { sse: true }, async (request, reply) => {
    reply.sse.send({ data: 'connected' })
    // Don't keep alive - let it close naturally
  })

  await app.listen({ port: 0 })
  const baseUrl = `http://localhost:${app.server.address().port}`

  // Create SSE connection using undici
  const sseResponse = await request(`${baseUrl}/sse`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream'
    }
  })

  assert.strictEqual(sseResponse.statusCode, 200)
  assert.strictEqual(sseResponse.headers['content-type'], 'text/event-stream')

  // Start consuming the body
  sseResponse.body.on('data', () => {})

  // Wait for connection to be established
  await sleep(50)

  // Destroy the body - should not cause uncaught exception
  sseResponse.body.destroy()

  // Wait to ensure no uncaught exceptions occur
  await sleep(100)
})

test('handles body.destroy() with keepAlive connection', async (t) => {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  // Register @fastify/sse plugin
  await app.register(require('../index.js'))

  // SSE endpoint that keeps connection alive
  app.get('/sse', { sse: true }, async (request, reply) => {
    reply.sse.send({ data: 'connected' })
    reply.sse.keepAlive()
  })

  await app.listen({ port: 0 })
  const baseUrl = `http://localhost:${app.server.address().port}`

  // Create SSE connection using undici
  const sseResponse = await request(`${baseUrl}/sse`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream'
    }
  })

  assert.strictEqual(sseResponse.statusCode, 200)
  assert.strictEqual(sseResponse.headers['content-type'], 'text/event-stream')

  // Start consuming the body
  sseResponse.body.on('data', () => {})

  // Wait for connection to be established
  await sleep(50)

  // Destroy the body - should not cause uncaught exception
  sseResponse.body.destroy()

  // Wait to ensure no uncaught exceptions occur
  await sleep(100)
})

test('handles body.destroy() with streaming data', async (t) => {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  // Register @fastify/sse plugin
  await app.register(require('../index.js'))

  // SSE endpoint that streams data
  app.get('/sse', { sse: true }, async (request, reply) => {
    reply.sse.keepAlive()

    // Send initial message immediately
    await reply.sse.send({ data: 'connected' })

    // Stream data periodically
    const interval = setInterval(async () => {
      if (reply.sse.isConnected) {
        try {
          await reply.sse.send({ data: 'ping' })
        } catch (e) {
          // Connection closed
          clearInterval(interval)
        }
      } else {
        clearInterval(interval)
      }
    }, 100)

    reply.sse.onClose(() => {
      clearInterval(interval)
    })
  })

  await app.listen({ port: 0 })
  const baseUrl = `http://localhost:${app.server.address().port}`

  // Create SSE connection using undici
  const sseResponse = await request(`${baseUrl}/sse`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream'
    }
  })

  assert.strictEqual(sseResponse.statusCode, 200)
  assert.strictEqual(sseResponse.headers['content-type'], 'text/event-stream')

  // Start consuming the body
  let dataReceived = false
  sseResponse.body.on('data', (chunk) => {
    dataReceived = true
  })

  // Wait for some data to be received
  await sleep(100)
  assert.ok(dataReceived, 'Should have received some data')

  // Destroy the body while streaming - should not cause uncaught exception
  sseResponse.body.destroy()

  // Wait to ensure no uncaught exceptions occur
  await sleep(100)
})

test('reports a client that disconnected before the handler ran', async (t) => {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  await app.register(require('../index.js'))

  const controller = new AbortController()
  let context
  let sendResult
  let closeCalls = 0
  let closeCallsOnRegister
  let handlerStarted
  const started = new Promise((resolve) => { handlerStarted = resolve })

  app.get('/sse', {
    sse: true,
    // Like a slow auth check: the client leaves before the handler runs
    preHandler (request, reply, done) {
      reply.raw.once('close', () => done())
      controller.abort()
    }
  }, async (request, reply) => {
    context = reply.sse
    reply.sse.keepAlive()
    reply.sse.onClose(() => { closeCalls++ })
    closeCallsOnRegister = closeCalls
    sendResult = reply.sse.send({ data: 'too late' }).then(
      () => 'sent',
      (err) => err.code
    )
    handlerStarted()
    await sendResult
  })

  await app.listen({ port: 0 })
  const baseUrl = `http://localhost:${app.server.address().port}`

  await assert.rejects(request(`${baseUrl}/sse`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream'
    },
    signal: controller.signal
  }), { name: 'AbortError' })

  await started
  assert.strictEqual(context.isConnected, false)
  assert.strictEqual(await sendResult, 'FST_ERR_SSE_CONNECTION_CLOSED')
  assert.strictEqual(context.heartbeatTimer, null)
  assert.strictEqual(closeCallsOnRegister, 0)
  await sleep(10)
  assert.strictEqual(closeCalls, 1)
})
