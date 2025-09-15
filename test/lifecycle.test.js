'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const Fastify = require('fastify')
const fastifySSE = require('../index.js')

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
