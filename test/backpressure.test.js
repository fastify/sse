'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
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

test('settles a backpressured write when the response closes without drain or error', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })
  let outcome
  let listenersBefore
  let listenersAfter
  let context
  let handlerDone

  const finished = new Promise((resolve) => { handlerDone = resolve })
  const counts = (raw) => ({
    drain: raw.listenerCount('drain'),
    error: raw.listenerCount('error'),
    close: raw.listenerCount('close')
  })

  app.get('/events', { sse: true }, async (request, reply) => {
    context = reply.sse
    const raw = reply.raw
    const originalWrite = raw.write
    listenersBefore = counts(raw)

    raw.write = function (...args) {
      originalWrite.apply(this, args)
      setImmediate(() => raw.emit('close'))
      return false
    }

    let timer
    outcome = await Promise.race([
      reply.sse.send({ data: 'backpressure' }).then(() => 'settled'),
      new Promise((resolve) => { timer = setTimeout(resolve, 1000, 'timed out') })
    ])
    clearTimeout(timer)
    raw.write = originalWrite
    listenersAfter = counts(raw)
    handlerDone()
  })

  // The response is closed before it ends, so inject() reports it as destroyed.
  await assert.rejects(
    () => app.inject({
      url: '/events',
      headers: { accept: 'text/event-stream' }
    }),
    { message: 'response destroyed before completion' }
  )
  await finished

  assert.strictEqual(outcome, 'settled')
  assert.strictEqual(listenersAfter.drain, listenersBefore.drain)
  assert.strictEqual(listenersAfter.error, listenersBefore.error)
  // Emitting close also runs other once('close') listeners, so only check none were left behind
  assert.ok(listenersAfter.close <= listenersBefore.close)
  assert.strictEqual(context.isConnected, false)
})
